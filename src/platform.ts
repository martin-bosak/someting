import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { recordActivity, listActivity } from "./activityLog.js";
import { sendAlert } from "./alerts.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { runCommand } from "./shell.js";
import {
  deployAuthSchema,
  domainInputSchema,
  mailNoteSchema,
  siteInputSchema,
  siteMetadataUpdateSchema,
} from "./validators.js";

export type SiteRow = {
  id: string;
  slug: string;
  name: string;
  runtime: string;
  repo_url: string;
  branch: string;
  repo_subdir: string;
  build_command: string | null;
  start_command: string | null;
  healthcheck_path: string | null;
  status: string;
  last_health_status: string | null;
  last_health_checked_at: Date | null;
  last_health_error: string | null;
};

export type DeployTrigger = "manual" | "github_webhook" | "rollback";

export type DeployOptions = {
  trigger?: DeployTrigger;
  expectedCommitSha?: string;
};

export type SiteRelease = {
  id: string;
  active: boolean;
};

export type BackupFileInfo = {
  name: string;
  size: number;
  modifiedAt: Date;
};

export type BackupStatus = {
  backupDir: string;
  files: BackupFileInfo[];
  latestPostgres: BackupFileInfo | null;
  backupLogTail: string;
  stale: boolean;
};

export type SiteRuntimeStat = {
  slug: string;
  running: boolean;
  cpuPercent: string | null;
  memoryUsage: string | null;
  memoryPercent: string | null;
};

export type HealthCheckResult =
  | { ok: true; status: number }
  | { ok: false; status?: number; error: string };

export type ObservabilitySummary = {
  sites: SiteRow[];
  unhealthySites: SiteRow[];
  recentFailedDeployments: Array<{
    id: string;
    slug: string;
    status: string;
    started_at: Date;
    health_status: string | null;
  }>;
  recentErrors: Awaited<ReturnType<typeof listActivity>>;
  backup: BackupStatus;
  runtimeStats: SiteRuntimeStat[];
  visitTotals: Record<string, number>;
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
    `insert into sites (slug, name, runtime, repo_url, branch, repo_subdir, build_command, start_command, healthcheck_path)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [
      input.slug,
      input.name,
      input.runtime,
      input.repo_url,
      input.branch,
      input.repo_subdir,
      input.build_command,
      input.start_command,
      input.healthcheck_path,
    ],
  );

  const site = result.rows[0];
  await syncSiteEnv(site);

  await recordActivity({
    category: "site",
    action: "Create site",
    target: input.slug,
    detail: `runtime=${input.runtime} repo=${input.repo_url} branch=${input.branch}${input.repo_subdir ? ` subdir=${input.repo_subdir}` : ""}`,
  });

  return site;
}

export async function updateSiteMetadata(siteId: number, body: unknown) {
  const site = await getSiteById(siteId);
  const input = siteMetadataUpdateSchema.parse(body);
  await pool.query(
    `update sites
     set name = $1, repo_url = $2, branch = $3, repo_subdir = $4,
         build_command = $5, start_command = $6, healthcheck_path = $7,
         updated_at = now()
     where id = $8`,
    [
      input.name,
      input.repo_url,
      input.branch,
      input.repo_subdir,
      input.build_command ?? null,
      input.start_command ?? null,
      input.healthcheck_path,
      site.id,
    ],
  );

  if (input.runtime && input.runtime !== site.runtime) {
    await changeSiteRuntime(site.slug, input.runtime);
  }

  const result = await pool.query<SiteRow>("select * from sites where id = $1", [site.id]);
  await syncSiteEnv(result.rows[0]);

  await recordActivity({
    category: "site",
    action: "Update site metadata",
    target: site.slug,
    detail: `name=${input.name} repo=${input.repo_url} branch=${input.branch}${input.repo_subdir ? ` subdir=${input.repo_subdir}` : ""}`,
  });

  return result.rows[0];
}

// Swap a site's runtime template (Dockerfile + compose.yaml) and update the
// DB row. The next deploy_site / recreate_site rebuilds the container against
// the new template — this call alone does not restart anything.
const RUNTIME_VALUES = new Set(["php", "node", "python", "static", "html"]);

export async function changeSiteRuntime(slug: string, runtime: string) {
  if (!RUNTIME_VALUES.has(runtime)) {
    throw new Error(`Unknown runtime: ${runtime}`);
  }
  const site = await getSiteBySlug(slug);
  if (site.runtime === runtime) {
    return { site, runtime, changed: false };
  }

  const templateDir = join(config.HOSTING_ROOT, "templates", runtime);
  const siteDir = join(config.HOSTING_ROOT, "sites", site.slug);

  const dockerfile = await readFile(join(templateDir, "Dockerfile"), "utf8").catch(() => {
    throw new Error(`Template not found for runtime "${runtime}".`);
  });
  const composeFile = await readFile(join(templateDir, "compose.yaml"), "utf8").catch(() => {
    throw new Error(`Template compose file not found for runtime "${runtime}".`);
  });

  await mkdir(siteDir, { recursive: true });
  await writeFile(join(siteDir, "Dockerfile"), dockerfile, { mode: 0o644 });
  await writeFile(join(siteDir, "compose.yaml"), composeFile, { mode: 0o644 });

  await pool.query("update sites set runtime = $1, updated_at = now() where id = $2", [
    runtime,
    site.id,
  ]);

  const updated = await getSiteBySlug(slug);
  await syncSiteEnv(updated);

  return {
    site: updated,
    runtime,
    changed: true,
    next_steps: "Run deploy_site or recreate_site to rebuild the container with the new runtime.",
  };
}

// Tear a site fully down: stop+remove its compose project, drop its Caddy
// route files, reload Caddy, delete the on-disk site directory, and delete
// the DB row (cascades domains + deployments). Idempotent enough to recover
// from a partially-deleted site.
export async function deleteSiteBySlug(slug: string) {
  const site = await getSiteBySlug(slug);
  const siteDir = join(config.HOSTING_ROOT, "sites", site.slug);
  const steps: { step: string; ok: boolean; output: string }[] = [];

  const composeFile = join(siteDir, "compose.yaml");
  const composeExists = await stat(composeFile).then(() => true).catch(() => false);
  if (composeExists) {
    const down = await runCommand(
      "docker",
      [
        "compose",
        "--env-file",
        join(siteDir, "site.env"),
        "-p",
        `site-${slug}`,
        "down",
        "--remove-orphans",
        "-v",
      ],
      5 * 60 * 1000,
      { cwd: siteDir },
    );
    steps.push({ step: "docker compose down", ok: down.code === 0, output: down.output });
  } else {
    const rm = await runCommand("docker", ["rm", "-f", `site-${slug}`], 60_000);
    steps.push({ step: "docker rm -f", ok: rm.code === 0, output: rm.output });
  }

  const caddyHost = join(config.HOSTING_ROOT, "caddy", "sites", `${slug}.caddy`);
  const caddyPath = join(config.HOSTING_ROOT, "caddy", "paths", `${slug}.caddy`);
  await rm(caddyHost, { force: true });
  await rm(caddyPath, { force: true });
  steps.push({ step: "remove caddy route files", ok: true, output: `${caddyHost}\n${caddyPath}` });

  const reload = await runCommand(
    "docker",
    ["exec", "hosting-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"],
    60_000,
  );
  steps.push({ step: "caddy reload", ok: reload.code === 0, output: reload.output });

  await rm(siteDir, { recursive: true, force: true });
  steps.push({ step: "remove site directory", ok: true, output: siteDir });

  await pool.query("delete from sites where id = $1", [site.id]);
  steps.push({ step: "delete db row", ok: true, output: `site id ${site.id}` });

  await recordActivity({
    category: "site",
    action: "Delete site",
    target: slug,
    detail: steps.map((s) => `${s.ok ? "ok" : "FAIL"} ${s.step}`).join("\n"),
  });

  return { slug, deleted: true, steps };
}

export async function addDomain(body: unknown) {
  const input = domainInputSchema.parse(body);
  const result = await pool.query(
    `insert into domains (site_id, hostname, is_primary)
     values ($1, $2, $3)
     returning *`,
    [input.site_id, input.hostname, input.is_primary],
  );
  const domain = result.rows[0];

  const site = await pool.query<SiteRow>("select * from sites where id = $1", [input.site_id]);
  const slug = site.rowCount === 1 ? site.rows[0].slug : `site#${input.site_id}`;
  await recordActivity({
    category: "domain",
    action: "Add domain",
    target: input.hostname,
    detail: `site=${slug}${input.is_primary ? " (primary)" : ""}`,
  });

  if (site.rowCount === 1) {
    try {
      await applyRouteBySlug(site.rows[0].slug);
    } catch (err) {
      console.error(`[addDomain] auto apply-route failed for ${site.rows[0].slug}:`, err);
    }
  }

  return domain;
}

export async function addMailNote(body: unknown) {
  const input = mailNoteSchema.parse(body);
  const result = await pool.query(
    `insert into mail_notes (domain, mode, provider, notes)
     values ($1, $2, $3, $4)
     returning *`,
    [input.domain, input.mode, input.provider, input.notes],
  );
  await recordActivity({
    category: "mail",
    action: "Save mail note",
    target: input.domain,
    detail: `mode=${input.mode}${input.provider ? ` provider=${input.provider}` : ""}`,
  });
  return result.rows[0];
}

// Provision a fresh database + owning role in the shared Postgres instance for
// a hosted site to use. Uses the control-plane's own DATABASE_URL, which
// connects as the POSTGRES_USER superuser created by compose.yaml — so it has
// CREATE ROLE / CREATE DATABASE rights.
const DB_NAME_RE = /^[a-z][a-z0-9_]{1,62}$/;

export async function provisionDatabase(body: unknown) {
  const input = body as { name?: unknown; password?: unknown };
  const name = typeof input.name === "string" ? input.name : "";
  if (!DB_NAME_RE.test(name)) {
    throw new Error(
      "Database name must start with a lowercase letter and contain only lowercase letters, digits, and underscores (2–63 chars).",
    );
  }

  const supplied = typeof input.password === "string" ? input.password.trim() : "";
  const password = supplied || randomBytes(18).toString("base64url");

  const client = await pool.connect();
  try {
    // CREATE ROLE/DATABASE don't accept bind parameters, so build the SQL
    // server-side with format() to get correct quoting of both the identifier
    // and the password literal.
    const roleSql = await client.query<{ sql: string }>(
      "select format('create role %I with login password %L', $1::text, $2::text) as sql",
      [name, password],
    );
    await client.query(roleSql.rows[0].sql);

    try {
      const dbSql = await client.query<{ sql: string }>(
        "select format('create database %I owner %I', $1::text, $2::text) as sql",
        [name, name],
      );
      await client.query(dbSql.rows[0].sql);
    } catch (err) {
      const cleanupSql = await client.query<{ sql: string }>(
        "select format('drop role if exists %I', $1::text) as sql",
        [name],
      );
      await client.query(cleanupSql.rows[0].sql).catch(() => {});
      throw err;
    }
  } finally {
    client.release();
  }

  await recordActivity({ category: "database", action: "Provision database", target: name });

  const host = "postgres";
  const port = 5432;
  return {
    name,
    username: name,
    password,
    host,
    port,
    database: name,
    connection_string: `postgres://${name}:${encodeURIComponent(password)}@${host}:${port}/${name}`,
  };
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

export async function deploySiteBySlug(slug: string, options: DeployOptions = {}) {
  const site = await getSiteBySlug(slug);
  const trigger = options.trigger ?? "manual";
  await syncSiteEnv(site);
  const deployment = await pool.query<{ id: string }>(
    "insert into deployments (site_id, status, trigger) values ($1, 'running', $2) returning id",
    [site.id, trigger],
  );
  const deploymentId = deployment.rows[0].id;

  const result = await runCommand("bash", [config.DEPLOY_SCRIPT, site.slug]);
  const markers = parseDeployMarkers(result.output);
  const commitSha = options.expectedCommitSha ?? markers.commitSha ?? null;
  const releaseId = markers.releaseId ?? null;

  let status = result.code === 0 ? "succeeded" : "failed";
  let healthStatus: string | null = null;
  let finalOutput = result.output;

  if (result.code === 0) {
    const health = await checkSiteHealth(site.slug, site.healthcheck_path ?? "/");
    healthStatus = health.ok ? "healthy" : "unhealthy";
    await updateSiteHealth(site.id, health);

    if (!health.ok) {
      status = "failed";
      const restored = await restorePreviousRelease(site.slug, markers.previousCurrent);
      finalOutput += `\nHealth check failed: ${formatHealthError(health)}`;
      if (restored) {
        finalOutput += "\nRestored previous release after failed health check.";
        status = "rolled_back";
        healthStatus = "rolled_back";
      }
      await sendAlert({
        level: "error",
        title: "Deploy health check failed",
        message: `Site ${site.slug} failed health check after deploy`,
        target: site.slug,
        detail: formatHealthError(health),
      });
    }
  } else if (markers.previousCurrent) {
    finalOutput += "\nDeploy script attempted to restore previous release after build failure.";
    status = "failed";
  }

  await pool.query(
    `update deployments
     set status = $1, output = $2, finished_at = now(), commit_sha = $3, release_id = $4, health_status = $5
     where id = $6`,
    [status, finalOutput.slice(-60000), commitSha, releaseId, healthStatus, deploymentId],
  );

  const siteStatus =
    status === "succeeded" ? "deployed" : status === "rolled_back" ? "deployed" : "deploy_failed";
  await pool.query("update sites set status = $1, updated_at = now() where id = $2", [siteStatus, site.id]);

  await recordActivity({
    category: "deploy",
    action: trigger === "github_webhook" ? "GitHub webhook deploy" : "Deploy site",
    target: site.slug,
    status: status === "succeeded" || status === "rolled_back" ? "ok" : "error",
    detail: `${status}${commitSha ? ` commit=${commitSha.slice(0, 7)}` : ""}${healthStatus ? ` health=${healthStatus}` : ""}\n${finalOutput.slice(-4000)}`,
  });

  if (status === "failed") {
    await sendAlert({
      level: "error",
      title: "Deploy failed",
      message: `Deploy failed for ${site.slug}`,
      target: site.slug,
      detail: finalOutput.slice(-2000),
    });
  }

  return {
    site,
    status,
    healthStatus,
    commitSha,
    releaseId,
    output: finalOutput,
  };
}

export async function getDeploymentLogById(id: number) {
  const result = await pool.query(
    `select d.id, d.status, d.output, d.started_at, d.finished_at, d.commit_sha, d.release_id, d.trigger, d.health_status, s.slug
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
    commit_sha: string | null;
    release_id: string | null;
    trigger: string | null;
    health_status: string | null;
  };
}

export async function listDeploymentLogsForSite(slug: string) {
  const site = await getSiteBySlug(slug);
  const result = await pool.query(
    `select id, status, output, started_at, finished_at, commit_sha, release_id, trigger, health_status
     from deployments
     where site_id = $1
     order by started_at desc
     limit 20`,
    [site.id],
  );

  return result.rows;
}

export async function applyRouteBySlug(slug: string) {
  const started = Date.now();
  const site = await getSiteBySlug(slug);
  const domains = await pool.query<{ hostname: string }>(
    "select hostname from domains where site_id = $1 order by is_primary desc, hostname",
    [site.id],
  );

  if (domains.rowCount === 0) {
    await recordActivity({
      category: "route",
      action: "Apply domain route",
      target: site.slug,
      status: "error",
      detail: "No domains configured for this site.",
      durationMs: Date.now() - started,
    });
    throw new Error("Add at least one domain before applying a route.");
  }

  const hostnames = domains.rows.map((row) => row.hostname);
  try {
    await writeCaddyRoute(site.slug, hostnames);
    const reload = await runCommand("docker", ["exec", "hosting-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"], 60_000);

    if (reload.code !== 0) {
      throw new Error(reload.output || "Caddy reload failed");
    }
  } catch (err) {
    await recordActivity({
      category: "route",
      action: "Apply domain route",
      target: site.slug,
      status: "error",
      detail: `${hostnames.join(", ")}\n${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - started,
    });
    throw err;
  }

  await recordActivity({
    category: "route",
    action: "Apply domain route",
    target: site.slug,
    status: "ok",
    detail: `Caddy reverse-proxy route for: ${hostnames.join(", ")}`,
    durationMs: Date.now() - started,
  });

  return { site, hostnames };
}

export async function applyPathRouteBySlug(slug: string) {
  const started = Date.now();
  const site = await getSiteBySlug(slug);
  try {
    await writeCaddyPathRoute(site.slug);
    const reload = await runCommand("docker", ["exec", "hosting-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"], 60_000);

    if (reload.code !== 0) {
      throw new Error(reload.output || "Caddy reload failed");
    }
  } catch (err) {
    await recordActivity({
      category: "route",
      action: "Apply path route",
      target: site.slug,
      status: "error",
      detail: `/sites/${site.slug}/\n${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - started,
    });
    throw err;
  }

  await recordActivity({
    category: "route",
    action: "Apply path route",
    target: site.slug,
    status: "ok",
    detail: `Caddy path route at /sites/${site.slug}/`,
    durationMs: Date.now() - started,
  });

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

export async function restartSiteBySlug(slug: string) {
  const site = await getSiteBySlug(slug);
  const result = await runCommand("docker", ["restart", `site-${slug}`], 60_000);
  if (result.code !== 0) {
    await recordActivity({
      category: "site",
      action: "Restart site",
      target: slug,
      status: "error",
      detail: result.output,
    });
    throw new Error(result.output || `docker restart site-${slug} failed`);
  }
  await recordActivity({ category: "site", action: "Restart site", target: slug });
  return { site, output: result.output };
}

export async function recreateSiteBySlug(slug: string) {
  const site = await getSiteBySlug(slug);
  await syncSiteEnv(site);
  const siteDir = join(config.HOSTING_ROOT, "sites", site.slug);
  const result = await runCommand(
    "docker",
    [
      "compose",
      "--env-file",
      join(siteDir, "site.env"),
      "-p",
      `site-${slug}`,
      "up",
      "-d",
      "--remove-orphans",
    ],
    5 * 60 * 1000,
    { cwd: siteDir },
  );
  if (result.code !== 0) {
    await recordActivity({
      category: "site",
      action: "Recreate site",
      target: slug,
      status: "error",
      detail: result.output.slice(-4000),
    });
    throw new Error(result.output || `recreate failed for site-${slug}`);
  }

  const health = await checkSiteHealth(site.slug, site.healthcheck_path ?? "/");
  await updateSiteHealth(site.id, health);
  if (!health.ok) {
    await sendAlert({
      level: "warning",
      title: "Recreate health check failed",
      message: `Site ${site.slug} is unhealthy after recreate`,
      target: site.slug,
      detail: formatHealthError(health),
    });
  }

  await recordActivity({
    category: "site",
    action: "Recreate site",
    target: slug,
    detail: health.ok ? "healthy" : `unhealthy: ${formatHealthError(health)}`,
  });
  return { site, output: result.output, health };
}

export async function execInSiteBySlug(slug: string, command: string) {
  await getSiteBySlug(slug);
  if (!command.trim()) {
    throw new Error("Command is required.");
  }
  const result = await runCommand(
    "docker",
    ["exec", `site-${slug}`, "sh", "-lc", command],
    60_000,
  );
  return {
    slug,
    command,
    exitCode: result.code,
    output: result.output,
  };
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

async function syncSiteEnv(site: SiteRow) {
  const siteDir = join(config.HOSTING_ROOT, "sites", site.slug);
  await mkdir(siteDir, { recursive: true });
  const envPath = join(siteDir, "site.env");
  const body =
    `SITE_SLUG=${shellQuote(site.slug)}\n` +
    `RUNTIME=${shellQuote(site.runtime)}\n` +
    `REPO_URL=${shellQuote(site.repo_url)}\n` +
    `BRANCH=${shellQuote(site.branch)}\n` +
    `REPO_SUBDIR=${shellQuote(site.repo_subdir ?? "")}\n` +
    `BUILD_COMMAND=${shellQuote(site.build_command ?? "")}\n` +
    `START_COMMAND=${shellQuote(site.start_command ?? "")}\n` +
    `HEALTHCHECK_PATH=${shellQuote(site.healthcheck_path ?? "/")}\n` +
    `SERVICE_PORT=8080\n`;
  await writeFile(envPath, body, { mode: 0o600 });
}

async function writeCaddyRoute(slug: string, hostnames: string[]) {
  const sitesDir = join(config.HOSTING_ROOT, "caddy", "sites");
  await mkdir(sitesDir, { recursive: true });

  const body = `${hostnames.join(", ")} {
	encode zstd gzip
	log {
		output file /data/access-${slug}.log
	}
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

export async function getVisitCount(slug: string) {
  try {
    const logPath = join(config.HOSTING_ROOT, "caddy", "data", `access-${slug}.log`);
    const output = await runCommand("wc", ["-l", logPath]);
    if (output.code === 0) {
      return parseInt(output.output.split(" ")[0] || "0", 10);
    }
  } catch (e) {
    // ignore
  }
  return 0;
}

export type WeeklyVisits = {
  weeks: { start: number; count: number }[];
  recentTotal: number;
  allTime: number;
};

// Parse the Caddy JSON access log and bucket hits into the last `weeks` rolling
// 7-day windows (oldest first). Each line carries a numeric `ts` (unix seconds);
// we grab it with a cheap regex and fall back to JSON.parse for odd formats.
export async function getWeeklyVisits(slug: string, weeks = 10): Promise<WeeklyVisits> {
  const logPath = join(config.HOSTING_ROOT, "caddy", "data", `access-${slug}.log`);
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const buckets = new Array<number>(weeks).fill(0);
  let recentTotal = 0;
  let allTime = 0;

  let content = "";
  try {
    content = await readFile(logPath, "utf8");
  } catch {
    // no log yet — return empty buckets
  }

  if (content) {
    for (const line of content.split("\n")) {
      if (!line) continue;

      let tsMs: number | null = null;
      const match = line.match(/"ts":\s*([0-9.]+)/);
      if (match) {
        tsMs = parseFloat(match[1]) * 1000;
      } else {
        try {
          const obj = JSON.parse(line) as { ts?: unknown };
          if (typeof obj.ts === "number") {
            tsMs = obj.ts * 1000;
          } else if (typeof obj.ts === "string") {
            const parsed = Date.parse(obj.ts);
            if (!Number.isNaN(parsed)) tsMs = parsed;
          }
        } catch {
          continue;
        }
      }
      if (tsMs === null || Number.isNaN(tsMs)) continue;

      allTime += 1;
      const idx = Math.floor((now - tsMs) / weekMs); // 0 = current rolling week
      if (idx >= 0 && idx < weeks) {
        buckets[idx] += 1;
        recentTotal += 1;
      }
    }
  }

  const series: { start: number; count: number }[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    series.push({ start: now - (i + 1) * weekMs, count: buckets[i] });
  }

  return { weeks: series, recentTotal, allTime };
}

// --- Persistent site storage (the ./shared dir mounted at /data in the container) ---

function siteStorageRoot(slug: string) {
  return resolve(config.HOSTING_ROOT, "sites", slug, "shared");
}

// Resolve a caller-supplied path against a site's shared/ dir, rejecting any
// path that would escape it (e.g. "../" or absolute paths).
function resolveStoragePath(slug: string, relPath: string) {
  const root = siteStorageRoot(slug);
  const target = resolve(root, relPath ?? "");
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Path escapes the site storage directory.");
  }
  return { root, target };
}

export async function listSiteStorage(slug: string, subPath = "") {
  await getSiteBySlug(slug);
  const { root, target } = resolveStoragePath(slug, subPath);
  await mkdir(root, { recursive: true });
  const entries = await readdir(target, { withFileTypes: true }).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  });

  const items = await Promise.all(
    entries.map(async (entry) => {
      const info = await stat(join(target, entry.name)).catch(() => null);
      return {
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
        size: info?.size ?? 0,
      };
    }),
  );

  return { slug, path: subPath || "/", entries: items };
}

export async function readSiteStorageFile(slug: string, filePath: string) {
  await getSiteBySlug(slug);
  const { target } = resolveStoragePath(slug, filePath);
  const info = await stat(target);
  if (info.isDirectory()) {
    throw new Error(`${filePath} is a directory.`);
  }
  if (info.size > 1_000_000) {
    throw new Error(`${filePath} is ${info.size} bytes; too large to read (limit 1 MB).`);
  }
  return readFile(target, "utf8");
}

export async function writeSiteStorageFile(slug: string, filePath: string, contents: string) {
  await getSiteBySlug(slug);
  const { root, target } = resolveStoragePath(slug, filePath);
  if (target === root) {
    throw new Error("A file path is required.");
  }
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, contents);
  return { slug, path: filePath, bytes: Buffer.byteLength(contents) };
}

export async function deleteSiteStorageEntry(slug: string, entryPath: string) {
  await getSiteBySlug(slug);
  const { root, target } = resolveStoragePath(slug, entryPath);
  if (target === root) {
    throw new Error("Refusing to delete the storage root.");
  }
  await rm(target, { recursive: true, force: true });
  return { slug, path: entryPath, deleted: true };
}

function readEnvValue(contents: string, key: string) {
  const line = contents.split("\n").find((item) => item.startsWith(`${key}=`));
  if (!line) {
    return "";
  }

  return line.slice(key.length + 1).replace(/^'|'$/g, "").replaceAll("'\\''", "'");
}

function formatHealthError(health: HealthCheckResult) {
  if (health.ok) {
    return `HTTP ${health.status}`;
  }
  return health.error ?? (health.status ? `HTTP ${health.status}` : "unknown");
}

function parseDeployMarkers(output: string) {
  let commitSha: string | null = null;
  let releaseId: string | null = null;
  let previousCurrent: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("SOMETING_COMMIT_SHA=")) {
      commitSha = line.slice("SOMETING_COMMIT_SHA=".length).trim() || null;
    } else if (line.startsWith("SOMETING_RELEASE_ID=")) {
      releaseId = line.slice("SOMETING_RELEASE_ID=".length).trim() || null;
    } else if (line.startsWith("SOMETING_PREVIOUS_CURRENT=")) {
      previousCurrent = line.slice("SOMETING_PREVIOUS_CURRENT=".length).trim() || null;
    }
  }
  return { commitSha, releaseId, previousCurrent };
}

export async function checkSiteHealth(slug: string, healthcheckPath = "/"): Promise<HealthCheckResult> {
  const path = healthcheckPath.startsWith("/") ? healthcheckPath : `/${healthcheckPath}`;
  const url = `http://site-${slug}:8080${path}`;
  const attempts = 6;
  const delayMs = 5000;
  let lastError = "unknown error";
  let lastStatus: number | undefined;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      lastStatus = res.status;
      if (res.ok) {
        return { ok: true as const, status: res.status };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { ok: false as const, status: lastStatus, error: lastError };
}

async function updateSiteHealth(siteId: string | number, health: HealthCheckResult) {
  await pool.query(
    `update sites
     set last_health_status = $1,
         last_health_checked_at = now(),
         last_health_error = $2,
         updated_at = now()
     where id = $3`,
    [health.ok ? "healthy" : "unhealthy", health.ok ? null : formatHealthError(health), siteId],
  );
}

async function restorePreviousRelease(slug: string, previousCurrent: string | null) {
  if (!previousCurrent) {
    return false;
  }
  const siteDir = join(config.HOSTING_ROOT, "sites", slug);
  const siteEnv = join(siteDir, "site.env");
  try {
    await stat(previousCurrent);
  } catch {
    return false;
  }
  await runCommand("ln", ["-sfn", previousCurrent, join(siteDir, "current")]);
  const up = await runCommand(
    "docker",
    ["compose", "--env-file", siteEnv, "-p", `site-${slug}`, "up", "-d", "--remove-orphans"],
    5 * 60 * 1000,
    { cwd: siteDir },
  );
  return up.code === 0;
}

export async function listSiteReleases(slug: string): Promise<{ activeRelease: string | null; releases: SiteRelease[] }> {
  await getSiteBySlug(slug);
  const siteDir = join(config.HOSTING_ROOT, "sites", slug);
  const releasesDir = join(siteDir, "releases");
  const currentLink = join(siteDir, "current");

  let activeRelease: string | null = null;
  try {
    const target = await readlink(currentLink);
    const resolved = resolve(siteDir, target);
    const match = resolved.replace(/\\/g, "/").match(/\/releases\/(\d{14})/);
    activeRelease = match?.[1] ?? basename(resolved);
  } catch {
    activeRelease = null;
  }

  const entries = await readdir(releasesDir, { withFileTypes: true }).catch(() => []);
  const releaseIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  return {
    activeRelease,
    releases: releaseIds.map((id) => ({ id, active: id === activeRelease })),
  };
}

export async function rollbackSiteBySlug(slug: string, releaseId: string) {
  const site = await getSiteBySlug(slug);
  const siteDir = join(config.HOSTING_ROOT, "sites", site.slug);
  const releaseDir = join(siteDir, "releases", releaseId);
  await stat(releaseDir).catch(() => {
    throw new Error(`Release ${releaseId} not found for ${slug}.`);
  });

  const deployment = await pool.query<{ id: string }>(
    "insert into deployments (site_id, status, trigger, release_id) values ($1, 'running', 'rollback', $2) returning id",
    [site.id, releaseId],
  );
  const deploymentId = deployment.rows[0].id;

  if (site.repo_subdir) {
    await runCommand("ln", ["-sfn", join(releaseDir, site.repo_subdir), join(siteDir, "current")]);
  } else {
    await runCommand("ln", ["-sfn", releaseDir, join(siteDir, "current")]);
  }

  const siteEnv = join(siteDir, "site.env");
  const up = await runCommand(
    "docker",
    ["compose", "--env-file", siteEnv, "-p", `site-${slug}`, "up", "-d", "--remove-orphans"],
    5 * 60 * 1000,
    { cwd: siteDir },
  );
  if (up.code !== 0) {
    await pool.query(
      `update deployments set status = 'failed', output = $1, finished_at = now() where id = $2`,
      [up.output.slice(-60000), deploymentId],
    );
    throw new Error(up.output || "docker compose up failed during rollback");
  }

  const health = await checkSiteHealth(site.slug, site.healthcheck_path ?? "/");
  await updateSiteHealth(site.id, health);
  const status = health.ok ? "rolled_back" : "rollback_unhealthy";
  const healthStatus = health.ok ? "healthy" : "unhealthy";

  await pool.query(
    `update deployments
     set status = $1, output = $2, finished_at = now(), health_status = $3
     where id = $4`,
    [status, `Rolled back to release ${releaseId}`, healthStatus, deploymentId],
  );

  await recordActivity({
    category: "deploy",
    action: "Rollback site",
    target: slug,
    status: health.ok ? "ok" : "error",
    detail: `release=${releaseId} health=${healthStatus}`,
  });

  if (!health.ok) {
    await sendAlert({
      level: "error",
      title: "Rollback unhealthy",
      message: `Rollback for ${slug} to ${releaseId} completed but health check failed`,
      target: slug,
      detail: formatHealthError(health),
    });
  }

  return { site, releaseId, status, health };
}

export async function getBackupStatus(): Promise<BackupStatus> {
  const backupDir = config.BACKUP_DIR;
  const logPath = join(config.HOSTING_ROOT, "logs", "backup.log");
  await mkdir(backupDir, { recursive: true });

  const names = await readdir(backupDir).catch(() => []);
  const files: BackupFileInfo[] = [];
  for (const name of names) {
    const filePath = join(backupDir, name);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      continue;
    }
    files.push({ name, size: info.size, modifiedAt: info.mtime });
  }
  files.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

  const latestPostgres =
    files.find((file) => file.name.startsWith("postgres-") && (file.name.endsWith(".sql.gz") || file.name.endsWith(".dump"))) ??
    null;

  const stale = !latestPostgres || Date.now() - latestPostgres.modifiedAt.getTime() > 36 * 60 * 60 * 1000;

  const backupLogTail = await readFile(logPath, "utf8")
    .then((content) => content.split("\n").slice(-40).join("\n"))
    .catch(() => "No backup log yet.");

  return { backupDir, files, latestPostgres, backupLogTail, stale };
}

export async function getSiteRuntimeStats(): Promise<SiteRuntimeStat[]> {
  const sites = await pool.query<SiteRow>("select slug from sites order by slug");
  const stats: SiteRuntimeStat[] = [];

  for (const site of sites.rows) {
    const inspect = await runCommand("docker", ["inspect", "-f", "{{.State.Running}}", `site-${site.slug}`], 15_000);
    const running = inspect.output.trim() === "true";
    if (!running) {
      stats.push({ slug: site.slug, running: false, cpuPercent: null, memoryUsage: null, memoryPercent: null });
      continue;
    }

    const dockerStats = await runCommand(
      "docker",
      ["stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}", `site-${site.slug}`],
      20_000,
    );
    const [cpuPercent, memoryUsage, memoryPercent] = dockerStats.output.trim().split("|");
    stats.push({
      slug: site.slug,
      running: true,
      cpuPercent: cpuPercent || null,
      memoryUsage: memoryUsage || null,
      memoryPercent: memoryPercent || null,
    });
  }

  return stats;
}

export async function getObservabilitySummary(): Promise<ObservabilitySummary> {
  const [sitesResult, failedDeployments, recentErrors, backup, runtimeStats] = await Promise.all([
    pool.query<SiteRow>("select * from sites order by slug"),
    pool.query<{
      id: string;
      slug: string;
      status: string;
      started_at: Date;
      health_status: string | null;
    }>(
      `select d.id, s.slug, d.status, d.started_at, d.health_status
       from deployments d
       join sites s on s.id = d.site_id
       where d.status in ('failed', 'rollback_unhealthy', 'rolled_back')
       order by d.started_at desc
       limit 10`,
    ),
    listActivity({ limit: 20 }),
    getBackupStatus(),
    getSiteRuntimeStats(),
  ]);

  const sites = sitesResult.rows;
  const unhealthySites = sites.filter((site) => site.last_health_status === "unhealthy");
  const visitTotals: Record<string, number> = {};
  await Promise.all(
    sites.map(async (site) => {
      const visits = await getWeeklyVisits(site.slug);
      visitTotals[site.slug] = visits.recentTotal;
    }),
  );

  if (backup.stale) {
    await sendAlert(
      {
        level: "warning",
        title: "Backup may be stale",
        message: backup.latestPostgres
          ? `Latest Postgres backup is older than 36 hours (${backup.latestPostgres.name})`
          : "No Postgres backup files found on the VPS",
        target: "postgres",
      },
      "backup-stale",
    );
  }

  return {
    sites,
    unhealthySites,
    recentFailedDeployments: failedDeployments.rows,
    recentErrors: recentErrors.filter((entry) => entry.status === "error"),
    backup,
    runtimeStats,
    visitTotals,
  };
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function normalizePrivateKey(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd() + "\n";
}
