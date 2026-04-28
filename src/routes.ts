import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { config } from "./config.js";
import { pool } from "./db.js";
import { runCommand } from "./shell.js";
import { domainInputSchema, mailNoteSchema, siteInputSchema } from "./validators.js";

type SiteRow = {
  id: string;
  slug: string;
  name: string;
  runtime: string;
  repo_url: string;
  branch: string;
  status: string;
};

export async function registerRoutes(app: FastifyInstance) {
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/", async (_request, reply) => reply.redirect("/admin"));

  app.get("/admin", async (_request, reply) => {
    const [sites, domains, deployments, mailNotes] = await Promise.all([
      pool.query<SiteRow>("select * from sites order by created_at desc"),
      pool.query("select d.*, s.slug from domains d join sites s on s.id = d.site_id order by d.hostname"),
      pool.query("select d.*, s.slug from deployments d join sites s on s.id = d.site_id order by d.started_at desc limit 20"),
      pool.query("select * from mail_notes order by created_at desc"),
    ]);

    return reply.type("text/html").send(renderAdmin(sites.rows, domains.rows, deployments.rows, mailNotes.rows));
  });

  app.post("/admin/sites", async (request, reply) => {
    const input = siteInputSchema.parse(request.body);
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
      return reply.code(500).type("text/plain").send(provision.output);
    }

    await pool.query(
      `insert into sites (slug, name, runtime, repo_url, branch, build_command, start_command, healthcheck_path)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
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
    return reply.redirect("/admin");
  });

  app.post("/admin/domains", async (request, reply) => {
    const input = domainInputSchema.parse(request.body);
    await pool.query(
      "insert into domains (site_id, hostname, is_primary) values ($1, $2, $3)",
      [input.site_id, input.hostname, input.is_primary],
    );
    return reply.redirect("/admin");
  });

  app.post("/admin/mail-notes", async (request, reply) => {
    const input = mailNoteSchema.parse(request.body);
    await pool.query(
      "insert into mail_notes (domain, mode, provider, notes) values ($1, $2, $3, $4)",
      [input.domain, input.mode, input.provider, input.notes],
    );
    return reply.redirect("/admin");
  });

  app.post("/admin/sites/:id/deploy", async (request, reply) => {
    const site = await getSite(request.params);
    const deployment = await pool.query(
      "insert into deployments (site_id, status) values ($1, 'running') returning id",
      [site.id],
    );

    const result = await runCommand("bash", [config.DEPLOY_SCRIPT, site.slug]);
    await pool.query(
      `update deployments
       set status = $1, output = $2, finished_at = now()
       where id = $3`,
      [result.code === 0 ? "succeeded" : "failed", result.output.slice(-60000), deployment.rows[0].id],
    );
    await pool.query("update sites set status = $1, updated_at = now() where id = $2", [
      result.code === 0 ? "deployed" : "deploy_failed",
      site.id,
    ]);

    return reply.redirect("/admin");
  });

  app.post("/admin/sites/:id/apply-route", async (request, reply) => {
    const site = await getSite(request.params);
    const domains = await pool.query<{ hostname: string }>(
      "select hostname from domains where site_id = $1 order by is_primary desc, hostname",
      [site.id],
    );

    if (domains.rowCount === 0) {
      return reply.code(400).send("Add at least one domain before applying a route.");
    }

    await writeCaddyRoute(site.slug, domains.rows.map((row) => row.hostname));
    await runCommand("docker", ["exec", "hosting-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"], 60_000);
    return reply.redirect("/admin");
  });

  app.get("/admin/sites/:id/logs", async (request, reply) => {
    const site = await getSite(request.params);
    const result = await runCommand("docker", ["logs", "--tail", "250", `site-${site.slug}`], 60_000);
    return reply.type("text/plain").send(result.output || "No logs returned.");
  });

  app.get("/admin/sites/:id/env", async (request, reply) => {
    const site = await getSite(request.params);
    const envPath = join(config.HOSTING_ROOT, "sites", site.slug, ".env");
    const contents = await readFile(envPath, "utf8").catch(() => "");
    return reply.type("text/html").send(renderEnvEditor(site, contents));
  });

  app.post("/admin/sites/:id/env", async (request, reply) => {
    const site = await getSite(request.params);
    const body = request.body as { contents?: string };
    const envPath = join(config.HOSTING_ROOT, "sites", site.slug, ".env");
    await writeFile(envPath, body.contents ?? "", { mode: 0o600 });
    return reply.redirect("/admin");
  });
}

async function getSite(params: unknown) {
  const id = Number((params as { id?: string }).id);
  const result = await pool.query<SiteRow>("select * from sites where id = $1", [id]);

  if (result.rowCount !== 1) {
    throw new Error("Site not found");
  }

  return result.rows[0];
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

function renderAdmin(sites: SiteRow[], domains: any[], deployments: any[], mailNotes: any[]) {
  const siteOptions = sites.map((site) => `<option value="${site.id}">${escapeHtml(site.slug)}</option>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Someting Admin</title>
  <style>
    body { color: #17202a; font: 15px system-ui, sans-serif; margin: 2rem auto; max-width: 1120px; padding: 0 1rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #ddd; padding: .6rem; text-align: left; vertical-align: top; }
    input, select, textarea { box-sizing: border-box; margin: .2rem 0 .8rem; padding: .45rem; width: 100%; }
    button { cursor: pointer; padding: .45rem .7rem; }
    .grid { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 1rem; }
    .actions { display: flex; flex-wrap: wrap; gap: .35rem; }
    .muted { color: #667; }
  </style>
</head>
<body>
  <h1>Someting Admin</h1>
  <p class="muted">Manage sites, domains, deploys, generated Caddy routes, logs, and mail decisions for this VPS.</p>

  <h2>Sites</h2>
  <table>
    <thead><tr><th>Slug</th><th>Runtime</th><th>Repository</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>
      ${sites
        .map(
          (site) => `<tr>
            <td>${escapeHtml(site.slug)}<br><small>${escapeHtml(site.name)}</small></td>
            <td>${escapeHtml(site.runtime)}</td>
            <td>${escapeHtml(site.repo_url)}<br><small>${escapeHtml(site.branch)}</small></td>
            <td>${escapeHtml(site.status)}</td>
            <td class="actions">
              <form method="post" action="/admin/sites/${site.id}/deploy"><button>Redeploy</button></form>
              <form method="post" action="/admin/sites/${site.id}/apply-route"><button>Apply route</button></form>
              <a href="/admin/sites/${site.id}/env">Env</a>
              <a href="/admin/sites/${site.id}/logs">Logs</a>
            </td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>

  <div class="grid">
    <section class="card">
      <h2>Add Site</h2>
      <form method="post" action="/admin/sites">
        <label>Slug <input name="slug" placeholder="my-site" required></label>
        <label>Name <input name="name" placeholder="My Site" required></label>
        <label>Runtime
          <select name="runtime"><option>static</option><option>node</option><option>python</option><option>php</option></select>
        </label>
        <label>Repository URL <input name="repo_url" placeholder="https://github.com/user/repo.git" required></label>
        <label>Branch <input name="branch" value="main" required></label>
        <label>Build command <input name="build_command" placeholder="npm run build"></label>
        <label>Start command <input name="start_command" placeholder="npm start"></label>
        <label>Healthcheck path <input name="healthcheck_path" value="/"></label>
        <button>Create site</button>
      </form>
    </section>

    <section class="card">
      <h2>Add Domain</h2>
      <form method="post" action="/admin/domains">
        <label>Site <select name="site_id">${siteOptions}</select></label>
        <label>Hostname <input name="hostname" placeholder="example.com" required></label>
        <label><input type="checkbox" name="is_primary" value="true"> Primary domain</label>
        <button>Add domain</button>
      </form>
      <h3>Configured Domains</h3>
      <ul>${domains.map((domain) => `<li>${escapeHtml(domain.hostname)} -> ${escapeHtml(domain.slug)}</li>`).join("")}</ul>
    </section>

    <section class="card">
      <h2>Mail Notes</h2>
      <form method="post" action="/admin/mail-notes">
        <label>Domain <input name="domain" placeholder="example.com" required></label>
        <label>Mode
          <select name="mode"><option>external</option><option>forwarding</option><option>smtp-relay</option><option>self-hosted</option></select>
        </label>
        <label>Provider <input name="provider" placeholder="Migadu, Fastmail, Postmark, ..."></label>
        <label>Notes <textarea name="notes"></textarea></label>
        <button>Save mail note</button>
      </form>
      <ul>${mailNotes.map((note) => `<li>${escapeHtml(note.domain)}: ${escapeHtml(note.mode)} ${escapeHtml(note.provider ?? "")}</li>`).join("")}</ul>
    </section>
  </div>

  <h2>Recent Deployments</h2>
  <table>
    <thead><tr><th>Site</th><th>Status</th><th>Started</th><th>Finished</th></tr></thead>
    <tbody>${deployments
      .map(
        (deployment) =>
          `<tr><td>${escapeHtml(deployment.slug)}</td><td>${escapeHtml(deployment.status)}</td><td>${escapeHtml(deployment.started_at)}</td><td>${escapeHtml(deployment.finished_at ?? "")}</td></tr>`,
      )
      .join("")}</tbody>
  </table>
</body>
</html>`;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderEnvEditor(site: SiteRow, contents: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(site.slug)} Env</title>
  <style>
    body { color: #17202a; font: 15px system-ui, sans-serif; margin: 2rem auto; max-width: 900px; padding: 0 1rem; }
    textarea { box-sizing: border-box; font: 14px ui-monospace, SFMono-Regular, Consolas, monospace; min-height: 420px; padding: 1rem; width: 100%; }
    button { cursor: pointer; margin-top: 1rem; padding: .5rem .8rem; }
  </style>
</head>
<body>
  <p><a href="/admin">Back to admin</a></p>
  <h1>${escapeHtml(site.slug)} environment</h1>
  <p>Values are written to the site container env file on the VPS. Redeploy or restart the site after changing runtime variables.</p>
  <form method="post" action="/admin/sites/${site.id}/env">
    <textarea name="contents" spellcheck="false">${escapeHtml(contents)}</textarea>
    <button>Save env file</button>
  </form>
</body>
</html>`;
}
