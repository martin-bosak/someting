import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { pool } from "./db.js";
import { runCommand } from "./shell.js";
import { deployAuthSchema, domainInputSchema, mailNoteSchema, siteInputSchema } from "./validators.js";

export type SiteRow = {
  id: string;
  slug: string;
  name: string;
  runtime: string;
  repo_url: string;
  branch: string;
  build_command: string | null;
  start_command: string | null;
  healthcheck_path: string | null;
  status: string;
};

export async function listPlatformState() {
  const [sites, domains, deployments, mailNotes] = await Promise.all([
    pool.query<SiteRow>("select * from sites order by created_at desc"),
    pool.query("select d.*, s.slug from domains d join sites s on s.id = d.site_id order by d.hostname"),
    pool.query("select d.*, s.slug from deployments d join sites s on s.id = d.site_id order by d.started_at desc limit 20"),
    pool.query("select * from mail_notes order by created_at desc"),
  ]);

  return {
    sites: sites.rows,
    domains: domains.rows,
    deployments: deployments.rows,
    mailNotes: mailNotes.rows,
  };
}

export async function createSite(body: unknown) {
  const input = siteInputSchema.parse(body);
  const provision = await runCommand("bash", [
    config.CREATE_SITE_SCRIPT,
    input.slug,
    input.runtime,
    input.repo_url,
    input.branch,
    input.build_command ?? "",
    input.start_command ?? "",
  ]);

  if (provision.code !== 0) {
    throw new Error(provision.output || "Site provisioning failed");
  }

  const result = await pool.query<SiteRow>(
    `insert into sites (slug, name, runtime, repo_url, branch, build_command, start_command, healthcheck_path)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning *`,
    [
      input.slug,
      input.name,
      input.runtime,
      input.repo_url,
      input.branch,
      input.build_command,
      input.start_command,
      input.healthcheck_path,
    ],
  );

  return result.rows[0];
}

export async function addDomain(body: unknown) {
  const input = domainInputSchema.parse(body);
  const result = await pool.query(
    `insert into domains (site_id, hostname, is_primary)
     values ($1, $2, $3)
     returning *`,
    [input.site_id, input.hostname, input.is_primary],
  );
  return result.rows[0];
}

export async function addMailNote(body: unknown) {
  const input = mailNoteSchema.parse(body);
  const result = await pool.query(
    `insert into mail_notes (domain, mode, provider, notes)
     values ($1, $2, $3, $4)
     returning *`,
    [input.domain, input.mode, input.provider, input.notes],
  );
  return result.rows[0];
}

export async function getSiteById(id: number) {
  const result = await pool.query<SiteRow>("select * from sites where id = $1", [id]);

  if (result.rowCount !== 1) {
    throw new Error("Site not found");
  }

  return result.rows[0];
}

export async function getSiteBySlug(slug: string) {
  const result = await pool.query<SiteRow>("select * from sites where slug = $1", [slug]);

  if (result.rowCount !== 1) {
    throw new Error("Site not found");
  }

  return result.rows[0];
}

export async function deploySiteBySlug(slug: string) {
  const site = await getSiteBySlug(slug);
  const deployment = await pool.query(
    "insert into deployments (site_id, status) values ($1, 'running') returning id",
    [site.id],
  );

  const result = await runCommand("bash", [config.DEPLOY_SCRIPT, site.slug]);
  const status = result.code === 0 ? "succeeded" : "failed";

  await pool.query(
    `update deployments
     set status = $1, output = $2, finished_at = now()
     where id = $3`,
    [status, result.output.slice(-60000), deployment.rows[0].id],
  );
  await pool.query("update sites set status = $1, updated_at = now() where id = $2", [
    result.code === 0 ? "deployed" : "deploy_failed",
    site.id,
  ]);

  return {
    site,
    status,
    output: result.output,
  };
}

export async function getDeploymentLogById(id: number) {
  const result = await pool.query(
    `select d.id, d.status, d.output, d.started_at, d.finished_at, s.slug
     from deployments d
     join sites s on s.id = d.site_id
     where d.id = $1`,
    [id],
  );

  if (result.rowCount !== 1) {
    throw new Error("Deployment not found");
  }

  return result.rows[0] as {
    id: string;
    slug: string;
    status: string;
    output: string;
    started_at: Date;
    finished_at: Date | null;
  };
}

export async function listDeploymentLogsForSite(slug: string) {
  const site = await getSiteBySlug(slug);
  const result = await pool.query(
    `select id, status, output, started_at, finished_at
     from deployments
     where site_id = $1
     order by started_at desc
     limit 20`,
    [site.id],
  );

  return result.rows;
}

export async function applyRouteBySlug(slug: string) {
  const site = await getSiteBySlug(slug);
  const domains = await pool.query<{ hostname: string }>(
    "select hostname from domains where site_id = $1 order by is_primary desc, hostname",
    [site.id],
  );

  if (domains.rowCount === 0) {
    throw new Error("Add at least one domain before applying a route.");
  }

  const hostnames = domains.rows.map((row) => row.hostname);
  await writeCaddyRoute(site.slug, hostnames);
  const reload = await runCommand("docker", ["exec", "hosting-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"], 60_000);

  if (reload.code !== 0) {
    throw new Error(reload.output || "Caddy reload failed");
  }

  return { site, hostnames };
}

export async function applyPathRouteBySlug(slug: string) {
  const site = await getSiteBySlug(slug);
  await writeCaddyPathRoute(site.slug);
  const reload = await runCommand("docker", ["exec", "hosting-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"], 60_000);

  if (reload.code !== 0) {
    throw new Error(reload.output || "Caddy reload failed");
  }

  return {
    site,
    path: `/sites/${site.slug}/`,
  };
}

export async function getSiteLogsBySlug(slug: string, tail = 250) {
  await getSiteBySlug(slug);
  const result = await runCommand("docker", ["logs", "--tail", String(tail), `site-${slug}`], 60_000);
  return result.output || "No logs returned.";
}

export async function readSiteEnvBySlug(slug: string) {
  const site = await getSiteBySlug(slug);
  const envPath = join(config.HOSTING_ROOT, "sites", site.slug, ".env");
  return readFile(envPath, "utf8").catch(() => "");
}

export async function writeSiteEnvBySlug(slug: string, contents: string) {
  const site = await getSiteBySlug(slug);
  const envPath = join(config.HOSTING_ROOT, "sites", site.slug, ".env");
  await writeFile(envPath, contents, { mode: 0o600 });
  return { site, envPath };
}

export async function readDeployAuthBySlug(slug: string) {
  const site = await getSiteBySlug(slug);
  const deployEnv = join(config.HOSTING_ROOT, "sites", site.slug, "deploy.env");
  const contents = await readFile(deployEnv, "utf8").catch(() => "");

  if (contents.includes("GIT_AUTH_MODE=https-token")) {
    const tokenB64 = readEnvValue(contents, "GIT_TOKEN_B64");
    return {
      mode: "https-token",
      username: readEnvValue(contents, "GIT_USERNAME") || "x-access-token",
      hasSecret: contents.includes("GIT_TOKEN_B64="),
      token: tokenB64 ? Buffer.from(tokenB64, "base64").toString("utf8") : "",
    };
  }

  if (contents.includes("GIT_AUTH_MODE=ssh-key")) {
    const keyPath = readEnvValue(contents, "GIT_SSH_KEY_PATH");
    return {
      mode: "ssh-key",
      hasSecret: true,
      privateKey: keyPath ? await readFile(keyPath, "utf8").catch(() => "") : "",
    };
  }

  return {
    mode: "none",
    hasSecret: false,
  };
}

export async function writeDeployAuthBySlug(slug: string, body: unknown) {
  const site = await getSiteBySlug(slug);
  const input = deployAuthSchema.parse(body);
  const siteDir = join(config.HOSTING_ROOT, "sites", site.slug);
  const deployEnv = join(siteDir, "deploy.env");
  const deployKey = join(siteDir, "deploy_key");

  if (input.mode === "none") {
    await rm(deployEnv, { force: true });
    await rm(deployKey, { force: true });
    return { site, mode: input.mode };
  }

  await mkdir(siteDir, { recursive: true });

  if (input.mode === "https-token") {
    const token = Buffer.from(input.token, "utf8").toString("base64");
    await rm(deployKey, { force: true });
    await writeFile(
      deployEnv,
      `GIT_AUTH_MODE=https-token\nGIT_USERNAME=${shellQuote(input.username)}\nGIT_TOKEN_B64=${shellQuote(token)}\n`,
      { mode: 0o600 },
    );
    return { site, mode: input.mode };
  }

  await writeFile(deployKey, normalizePrivateKey(input.private_key), { mode: 0o600 });
  await writeFile(deployEnv, `GIT_AUTH_MODE=ssh-key\nGIT_SSH_KEY_PATH=${shellQuote(deployKey)}\n`, { mode: 0o600 });
  return { site, mode: input.mode };
}

async function writeCaddyRoute(slug: string, hostnames: string[]) {
  const sitesDir = join(config.HOSTING_ROOT, "caddy", "sites");
  await mkdir(sitesDir, { recursive: true });

  const body = `${hostnames.join(", ")} {
	encode zstd gzip
	reverse_proxy site-${slug}:8080
}
`;

  await writeFile(join(sitesDir, `${slug}.caddy`), body, { mode: 0o644 });
}

async function writeCaddyPathRoute(slug: string) {
  const pathsDir = join(config.HOSTING_ROOT, "caddy", "paths");
  await mkdir(pathsDir, { recursive: true });

  const body = `redir /sites/${slug} /sites/${slug}/
handle_path /sites/${slug}/* {
	reverse_proxy site-${slug}:8080
}
`;

  await writeFile(join(pathsDir, `${slug}.caddy`), body, { mode: 0o644 });
}

function readEnvValue(contents: string, key: string) {
  const line = contents.split("\n").find((item) => item.startsWith(`${key}=`));
  if (!line) {
    return "";
  }

  return line.slice(key.length + 1).replace(/^'|'$/g, "").replaceAll("'\\''", "'");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function normalizePrivateKey(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd() + "\n";
}
