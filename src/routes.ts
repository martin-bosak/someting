import type { FastifyInstance } from "fastify";
import { clearSessionCookie, createSessionCookie, verifyAdminCredentials } from "./auth.js";
import {
  addDomain,
  addMailNote,
  applyPathRouteBySlug,
  applyRouteBySlug,
  createSite,
  provisionDatabase,
  deleteSiteStorageEntry,
  deploySiteBySlug,
  execInSiteBySlug,
  getDeploymentLogById,
  getSiteById,
  getSiteLogsBySlug,
  getVisitCount,
  listPlatformState,
  listSiteStorage,
  readDeployAuthBySlug,
  readSiteEnvBySlug,
  readSiteStorageFile,
  recreateSiteBySlug,
  restartSiteBySlug,
  type SiteRow,
  updateSiteMetadata,
  writeDeployAuthBySlug,
  writeSiteEnvBySlug,
  writeSiteStorageFile,
} from "./platform.js";
import { FAVICON_SVG, renderFaviconTags } from "./favicon.js";

export async function registerRoutes(app: FastifyInstance) {
  app.get("/healthz", async () => ({ ok: true }));

  app.get("/favicon.svg", async (_request, reply) => {
    return reply
      .header("Cache-Control", "public, max-age=86400, immutable")
      .type("image/svg+xml; charset=utf-8")
      .send(FAVICON_SVG);
  });

  app.get("/favicon.ico", async (_request, reply) => {
    return reply.code(302).redirect("/favicon.svg");
  });

  app.get("/login", async (request, reply) => {
    const next = typeof (request.query as { next?: string }).next === "string" ? (request.query as { next: string }).next : "/admin";
    return reply.type("text/html").send(renderLogin(next));
  });

  app.post("/login", async (request, reply) => {
    const body = request.body as { username?: string; password?: string; next?: string };
    const next = body.next?.startsWith("/") ? body.next : "/admin";

    if (!(await verifyAdminCredentials(body.username ?? "", body.password ?? ""))) {
      return reply.code(401).type("text/html").send(renderLogin(next, "Invalid username or password."));
    }

    return reply.header("Set-Cookie", createSessionCookie(body.username ?? "")).redirect(next);
  });

  app.post("/logout", async (_request, reply) => {
    return reply.header("Set-Cookie", clearSessionCookie()).redirect("/login");
  });

  app.get("/", async (_request, reply) => reply.redirect("/admin"));

  app.get("/admin", async (_request, reply) => {
    const state = await listPlatformState();
    return reply.type("text/html").send(renderAdminDashboard(state.sites, state.domains, state.deployments, state.mailNotes));
  });

  app.get("/admin/websites", async (_request, reply) => {
    const state = await listPlatformState();
    const visitCounts: Record<string, number> = {};
    for (const site of state.sites) {
      visitCounts[site.slug] = await getVisitCount(site.slug);
    }
    return reply.type("text/html").send(renderWebsitesPage(state.sites, state.domains, visitCounts));
  });

  app.get("/admin/sites/new", async (_request, reply) => {
    return reply.type("text/html").send(renderSiteEditorPage(null, "/admin/sites/new"));
  });

  app.get("/admin/sites/:id/edit", async (request, reply) => {
    const site = await getSite(request.params);
    return reply.type("text/html").send(renderSiteEditorPage(site, `/admin/sites/${site.id}/edit`));
  });

  app.post("/admin/sites/:id/update", async (request, reply) => {
    const site = await getSite(request.params);
    await updateSiteMetadata(Number(site.id), request.body);
    return reply.redirect("/admin/websites");
  });

  app.post("/admin/sites", async (request, reply) => {
    await createSite(request.body);
    return reply.redirect("/admin/websites");
  });

  app.post("/admin/domains", async (request, reply) => {
    await addDomain(request.body);
    return reply.redirect("/admin/websites");
  });

  app.post("/admin/mail-notes", async (request, reply) => {
    await addMailNote(request.body);
    return reply.redirect("/admin");
  });

  app.post("/admin/databases", async (request, reply) => {
    const result = await provisionDatabase(request.body);
    return reply.type("application/json").send(result);
  });

  app.post("/admin/sites/:id/deploy", async (request, reply) => {
    const site = await getSite(request.params);
    await deploySiteBySlug(site.slug);
    return reply.redirect("/admin/websites");
  });

  app.post("/admin/sites/:id/apply-route", async (request, reply) => {
    const site = await getSite(request.params);
    await applyRouteBySlug(site.slug);
    return reply.redirect("/admin/websites");
  });

  app.post("/admin/sites/:id/apply-path-route", async (request, reply) => {
    const site = await getSite(request.params);
    await applyPathRouteBySlug(site.slug);
    return reply.redirect("/admin/websites");
  });

  app.post("/admin/sites/:id/restart", async (request, reply) => {
    const site = await getSite(request.params);
    await restartSiteBySlug(site.slug);
    return reply.redirect("/admin/websites");
  });

  app.post("/admin/sites/:id/recreate", async (request, reply) => {
    const site = await getSite(request.params);
    await recreateSiteBySlug(site.slug);
    return reply.redirect("/admin/websites");
  });

  app.get("/admin/sites/:id/exec", async (request, reply) => {
    const site = await getSite(request.params);
    return reply.type("text/html").send(renderExecPage(site, null));
  });

  app.post("/admin/sites/:id/exec", async (request, reply) => {
    const site = await getSite(request.params);
    const body = request.body as { command?: string };
    const command = (body.command ?? "").trim();
    if (!command) {
      return reply.type("text/html").send(renderExecPage(site, { command: "", exitCode: null, output: "Command is required." }));
    }
    try {
      const result = await execInSiteBySlug(site.slug, command);
      return reply.type("text/html").send(renderExecPage(site, result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.type("text/html").send(renderExecPage(site, { command, exitCode: null, output: message }));
    }
  });

  app.get("/admin/sites/:id/logs", async (request, reply) => {
    const site = await getSite(request.params);
    const logs = await getSiteLogsBySlug(site.slug);
    return reply.type("text/plain").send(logs);
  });

  app.get("/admin/deployments", async (_request, reply) => {
    const state = await listPlatformState();
    return reply.type("text/html").send(renderDeploymentsPage(state.deployments));
  });

  app.get("/admin/deployments/:id/logs", async (request, reply) => {
    const id = Number((request.params as { id?: string }).id);
    const deployment = await getDeploymentLogById(id);
    return reply.type("text/html").send(renderDeploymentLog(deployment));
  });

  app.get("/admin/sites/:id/env", async (request, reply) => {
    const site = await getSite(request.params);
    const contents = await readSiteEnvBySlug(site.slug);
    return reply.type("text/html").send(renderEnvEditor(site, contents));
  });

  app.post("/admin/sites/:id/env", async (request, reply) => {
    const site = await getSite(request.params);
    const body = request.body as { contents?: string };
    await writeSiteEnvBySlug(site.slug, body.contents ?? "");
    return reply.redirect("/admin/websites");
  });

  app.get("/admin/sites/:id/storage", async (request, reply) => {
    const site = await getSite(request.params);
    const query = request.query as { path?: string; file?: string };
    const subPath = typeof query.path === "string" ? query.path : "";
    const listing = await listSiteStorage(site.slug, subPath);

    let openFile: { path: string; contents: string } | null = null;
    if (typeof query.file === "string" && query.file) {
      try {
        openFile = { path: query.file, contents: await readSiteStorageFile(site.slug, query.file) };
      } catch (err) {
        openFile = { path: query.file, contents: `# Could not read file: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    return reply.type("text/html").send(renderStoragePage(site, subPath, listing.entries, openFile));
  });

  app.post("/admin/sites/:id/storage/write", async (request, reply) => {
    const site = await getSite(request.params);
    const body = request.body as { path?: string; contents?: string; dir?: string };
    await writeSiteStorageFile(site.slug, body.path ?? "", body.contents ?? "");
    return reply.redirect(`/admin/sites/${site.id}/storage${body.dir ? `?path=${encodeURIComponent(body.dir)}` : ""}`);
  });

  app.post("/admin/sites/:id/storage/delete", async (request, reply) => {
    const site = await getSite(request.params);
    const body = request.body as { path?: string; dir?: string };
    await deleteSiteStorageEntry(site.slug, body.path ?? "");
    return reply.redirect(`/admin/sites/${site.id}/storage${body.dir ? `?path=${encodeURIComponent(body.dir)}` : ""}`);
  });

  app.get("/admin/sites/:id/deploy-auth", async (request, reply) => {
    const site = await getSite(request.params);
    const auth = await readDeployAuthBySlug(site.slug);
    return reply.type("text/html").send(renderDeployAuthEditor(site, auth));
  });

  app.post("/admin/sites/:id/deploy-auth", async (request, reply) => {
    const site = await getSite(request.params);
    await writeDeployAuthBySlug(site.slug, request.body);
    return reply.redirect("/admin/websites");
  });
}

async function getSite(params: unknown) {
  const raw = String((params as { id?: string }).id ?? "");
  if (!/^\d+$/.test(raw)) {
    throw new Error("Site not found");
  }
  const id = Number(raw);
  return getSiteById(id);
}

function websitesNavActive(currentPath: string) {
  return currentPath === "/admin/websites" || currentPath.startsWith("/admin/sites");
}

function renderAdminLayout(title: string, currentPath: string, content: string, siteCount?: number, domainCount?: number) {
  const headerContent =
    siteCount !== undefined && domainCount !== undefined
      ? `<div class="hero-note">
        <span class="pin"></span>
        <strong>${escapeHtml(siteCount)} live notes</strong>
        <span>${escapeHtml(domainCount)} domains tracked</span>
        <form method="post" action="/logout"><button class="button button-link">Log out</button></form>
      </div>`
      : `<div class="hero-note"><form method="post" action="/logout"><button class="button button-link">Log out</button></form></div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${renderFaviconTags()}
  <title>${escapeHtml(title)} - Someting Admin</title>
  <style>${renderAdminStyles()}</style>
</head>
<body>
  <nav class="top-menu">
    <div class="top-menu-inner">
      <a href="/admin" class="brand">Someting</a>
      <div class="menu-links">
        <a href="/admin" class="${currentPath === "/admin" ? "active" : ""}">Dashboard</a>
        <a href="/admin/websites" class="${websitesNavActive(currentPath) ? "active" : ""}">Websites</a>
        <a href="/admin/deployments" class="${currentPath.startsWith("/admin/deployments") ? "active" : ""}">Deployments</a>
      </div>
    </div>
  </nav>
  <main class="shell">
    <section class="hero paper paper-peach">
      <div>
        <p class="eyebrow">VPS control room</p>
        <h1>${escapeHtml(title)}</h1>
        <p class="lede">Manage sites, domains, deploys, generated Caddy routes, logs, and mail decisions without losing the handmade feel.</p>
      </div>
      ${headerContent}
    </section>
    ${content}
  </main>
</body>
</html>`;
}

function renderAdminDashboard(sites: SiteRow[], domains: any[], deployments: any[], mailNotes: any[]) {
  const latestDeployment = deployments[0];

  const content = `
    <section class="stats-grid" aria-label="Platform summary">
      ${renderStatCard("Sites", sites.length, "Apps registered", "mint")}
      ${renderStatCard("Domains", domains.length, "Routes to keep tidy", "lavender")}
      ${renderStatCard("Mail Notes", mailNotes.length, "Delivery decisions", "sky")}
      ${renderStatCard("Last Deploy", latestDeployment?.status ?? "None", latestDeployment ? `${latestDeployment.slug} at ${formatDate(latestDeployment.started_at)}` : "No deploys yet", "rose")}
    </section>

    <section class="form-grid">
      <section class="paper card paper-lavender">
        <p class="eyebrow">Traffic map</p>
        <h2>Add Domain</h2>
        <form method="post" action="/admin/domains">
          <label>Site <select name="site_id">${sites.map((site) => `<option value="${site.id}">${escapeHtml(site.slug)}</option>`).join("")}</select></label>
          <label>Hostname <input name="hostname" placeholder="example.com" required></label>
          <label class="check-row"><input type="checkbox" name="is_primary" value="true"> Primary domain</label>
          <button class="button">Add domain</button>
        </form>
        <h3>Configured Domains</h3>
        ${renderDomainList(domains)}
      </section>

      <section class="paper card paper-sky">
        <p class="eyebrow">Inbox decisions</p>
        <h2>Mail Notes</h2>
        <form method="post" action="/admin/mail-notes">
          <label>Domain <input name="domain" placeholder="example.com" required></label>
          <label>Mode
            <select name="mode"><option>external</option><option>forwarding</option><option>smtp-relay</option><option>self-hosted</option></select>
          </label>
          <label>Provider <input name="provider" placeholder="Migadu, Fastmail, Postmark, ..."></label>
          <label>Notes <textarea name="notes" rows="4" placeholder="Routing, ownership, or migration notes"></textarea></label>
          <button class="button">Save mail note</button>
        </form>
        ${renderMailNotes(mailNotes)}
      </section>
    </section>`;

  return renderAdminLayout("Someting Admin", "/admin", content, sites.length, domains.length);
}

function renderDeploymentsPage(deployments: any[]) {
  const content = `
    <section class="panel paper paper-rose">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Timeline</p>
          <h2>Recent Deployments</h2>
        </div>
        <a class="button button-ghost" href="/admin/websites">Back to websites</a>
      </div>
      ${renderDeployments(deployments)}
    </section>`;

  return renderAdminLayout("Deployments", "/admin/deployments", content);
}

function renderWebsitesPage(sites: SiteRow[], domains: any[], visitCounts: Record<string, number>) {
  const siteListHtml = sites.length === 0
    ? `<div class="empty-state">No sites yet. <a href="/admin/sites/new">Create your first site</a>.</div>`
    : `<div class="site-list">
        ${sites.map((site) => {
          const siteDomains = domains.filter(d => d.site_id === site.id);
          const domainList = siteDomains.length > 0 
            ? siteDomains.map(d => "<a href='https://" + escapeHtml(d.hostname) + "' target='_blank'>" + escapeHtml(d.hostname) + (d.is_primary ? " (Primary)" : "") + "</a>").join(", ")
            : "None";
          
          return `<article class="site-row paper paper-mint">
            <div class="site-row-header">
              <h3>${escapeHtml(site.slug)}</h3>
              <span class="status-pill ${statusTone(site.status)}">${escapeHtml(site.status)}</span>
            </div>
            <div class="site-row-details">
              <div class="detail-group">
                <span class="detail-label">Runtime</span>
                <span class="detail-value runtime-tag">${escapeHtml(site.runtime)}</span>
              </div>
              <div class="detail-group">
                <span class="detail-label">Domains</span>
                <span class="detail-value">${domainList}</span>
                <form method="post" action="/admin/domains" class="inline-domain-form">
                  <input type="hidden" name="site_id" value="${site.id}">
                  <input name="hostname" placeholder="example.com" required>
                  <label class="check-row"><input type="checkbox" name="is_primary" value="true"> Primary</label>
                  <button class="button button-soft">Add domain</button>
                </form>
              </div>
              <div class="detail-group">
                <span class="detail-label">Repository</span>
                <span class="detail-value"><a href="${escapeHtml(site.repo_url.replace(".git", ""))}" target="_blank">${escapeHtml(site.repo_url)}</a> (${escapeHtml(site.branch)})</span>
              </div>
              <div class="detail-group">
                <span class="detail-label">Visits</span>
                <span class="detail-value"><strong>${visitCounts[site.slug] || 0}</strong> hits</span>
              </div>
            </div>
            <div class="actions">
              <a class="button button-link" href="/admin/sites/${site.id}/edit">Edit</a>
              <form method="post" action="/admin/sites/${site.id}/deploy"><button class="button">Redeploy</button></form>
              <form method="post" action="/admin/sites/${site.id}/recreate"><button class="button button-soft">Recreate</button></form>
              <form method="post" action="/admin/sites/${site.id}/restart"><button class="button button-soft">Restart</button></form>
              <form method="post" action="/admin/sites/${site.id}/apply-route"><button class="button button-soft">Apply route</button></form>
              <form method="post" action="/admin/sites/${site.id}/apply-path-route"><button class="button button-soft">Path route</button></form>
              <a class="button button-link" href="/sites/${site.slug}/">Open path</a>
              <a class="button button-link" href="/admin/sites/${site.id}/deploy-auth">Deploy Auth</a>
              <a class="button button-link" href="/admin/sites/${site.id}/env">Env</a>
              <a class="button button-link" href="/admin/sites/${site.id}/storage">Storage</a>
              <a class="button button-link" href="/admin/sites/${site.id}/exec">Terminal</a>
              <a class="button button-link" href="/admin/sites/${site.id}/logs">Logs</a>
            </div>
          </article>`;
        }).join("")}
      </div>`;

  const content = `
    <section class="panel paper">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Workspace</p>
          <h2>Websites Overview</h2>
        </div>
        <a class="button button-ghost" href="/admin/sites/new">Add a site</a>
      </div>
      ${siteListHtml}
    </section>
  `;

  return renderAdminLayout("Websites", "/admin/websites", content);
}

function runtimeSelectOptions(selected: string) {
  const opts = ["html", "static", "node", "python", "php"] as const;
  return opts.map((r) => `<option${r === selected ? " selected" : ""}>${escapeHtml(r)}</option>`).join("");
}

function renderSiteEditorPage(site: SiteRow | null, currentPath: string) {
  const isCreate = site === null;
  const title = isCreate ? "Add site" : `${site.slug}`;
  const headline = isCreate ? "Create a website" : "Edit site metadata";
  const formAction = isCreate ? "/admin/sites" : `/admin/sites/${site.id}/update`;

  const slugBlock = isCreate
    ? `<label>Slug <input name="slug" placeholder="my-site" pattern="[a-z0-9][a-z0-9-]*[a-z0-9]" minlength="3" maxlength="64" required title="Lowercase letters, numbers, hyphens"></label>`
    : `<div class="readonly-block">
        <span class="detail-label">Slug</span>
        <div class="detail-value">${escapeHtml(site.slug)}</div>
        <small>Cannot change here; it ties to the provisioned folder and container name.</small>
      </div>`;

  const runtimeBlock = isCreate
    ? `<label>Runtime
          <select name="runtime" required>${runtimeSelectOptions("html")}</select>
        </label>`
    : `<div class="readonly-block">
        <span class="detail-label">Runtime</span>
        <div><span class="runtime-tag">${escapeHtml(site.runtime)}</span></div>
        <small>Set at provision time.</small>
      </div>`;

  const name = isCreate ? "" : escapeHtml(site.name);
  const repo = isCreate ? "" : escapeHtml(site.repo_url);
  const branch = isCreate ? "main" : escapeHtml(site.branch);
  const health = isCreate ? "/" : escapeHtml(site.healthcheck_path ?? "/");
  const build = isCreate ? "" : escapeHtml(site.build_command ?? "");
  const start = isCreate ? "" : escapeHtml(site.start_command ?? "");

  const content = `
    <section class="panel paper paper-mint site-editor-shell">
      <div class="section-heading">
        <div>
          <p class="eyebrow">${isCreate ? "New project" : "Existing site"}</p>
          <h2>${escapeHtml(headline)}</h2>
        </div>
        <a class="button button-ghost" href="/admin/websites">Back to websites</a>
      </div>
      <p class="lede">${isCreate ? "Runs provisioning on the server, registers the site in the database, and prepares compose from the runtime template." : "Change display name and deploy settings recorded in Postgres. Paths and slug stay as provisioned."}</p>
      <form method="post" action="${formAction}">
        ${slugBlock}
        ${runtimeBlock}
        <label>Name <input name="name" placeholder="My Site" value="${name}" required></label>
        <label>Repository URL <input name="repo_url" placeholder="https://github.com/user/repo.git or upload://my-site" value="${repo}" required></label>
        <div class="field-pair">
          <label>Branch <input name="branch" placeholder="main" value="${branch}" required></label>
          <label>Healthcheck path <input name="healthcheck_path" value="${health}" placeholder="/"></label>
        </div>
        <label>Build command <input name="build_command" placeholder="npm run build" value="${build}"></label>
        <label>Start command <input name="start_command" placeholder="npm start" value="${start}"></label>
        <div class="actions">
          <button type="submit" class="button">${isCreate ? "Create site" : "Save changes"}</button>
          <a class="button button-soft" href="/admin/websites">Cancel</a>
        </div>
      </form>
    </section>
  `;

  return renderAdminLayout(title, currentPath, content);
}

function renderStatCard(label: string, value: unknown, detail: string, tone: string) {
  return `<article class="stat-card paper paper-${tone}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
    <p>${escapeHtml(detail)}</p>
  </article>`;
}

function renderDomainList(domains: any[]) {
  if (domains.length === 0) {
    return `<div class="mini-empty">No domains configured yet.</div>`;
  }

  return `<ul class="stack-list">${domains
    .map(
      (domain) => `<li>
        <span>${escapeHtml(domain.hostname)}</span>
        <small>${escapeHtml(domain.slug)}${domain.is_primary ? " - primary" : ""}</small>
      </li>`,
    )
    .join("")}</ul>`;
}

function renderMailNotes(mailNotes: any[]) {
  if (mailNotes.length === 0) {
    return `<div class="mini-empty">No mail notes yet.</div>`;
  }

  return `<ul class="stack-list">${mailNotes
    .map(
      (note) => `<li>
        <span>${escapeHtml(note.domain)}</span>
        <small>${escapeHtml(note.mode)}${note.provider ? ` via ${escapeHtml(note.provider)}` : ""}</small>
      </li>`,
    )
    .join("")}</ul>`;
}

function renderDeployments(deployments: any[]) {
  if (deployments.length === 0) {
    return `<div class="empty-state">No deployments have run yet.</div>`;
  }

  return `<div class="deployment-list">${deployments
    .map(
      (deployment) => `<article class="deployment-row">
        <div>
          <strong>${escapeHtml(deployment.slug)}</strong>
          <span>${escapeHtml(formatDate(deployment.started_at))}</span>
        </div>
        <span class="status-pill ${statusTone(deployment.status)}">${escapeHtml(deployment.status)}</span>
        <div class="deployment-actions">
          <small>${escapeHtml(deployment.finished_at ? `Finished ${formatDate(deployment.finished_at)}` : "Still running")}</small>
          <a class="button button-link" href="/admin/deployments/${deployment.id}/logs">Deployment Logs</a>
        </div>
      </article>`,
    )
    .join("")}</div>`;
}

function renderAdminStyles() {
  return `
    :root {
      color-scheme: light;
      --ink: #263238;
      --muted: #687681;
      --line: #263238;
      --paper: rgba(255, 252, 244, .88);
      --peach: #ffe1d2;
      --mint: #dff5e8;
      --lavender: #e9e1ff;
      --sky: #d9efff;
      --rose: #ffdce8;
      --butter: #fff2b7;
      --shadow: 8px 10px 0 rgba(38, 50, 56, .13);
    }
    * { box-sizing: border-box; }
    body {
      background:
        radial-gradient(circle at 9% 12%, rgba(255, 225, 210, .9) 0 12rem, transparent 12.2rem),
        radial-gradient(circle at 86% 8%, rgba(217, 239, 255, .95) 0 14rem, transparent 14.2rem),
        linear-gradient(135deg, #fffaf0 0%, #f8fbff 50%, #fff7fb 100%);
      color: var(--ink);
      font: 15px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 0;
      min-height: 100vh;
    }
    body::before {
      background-image:
        linear-gradient(rgba(38, 50, 56, .045) 1px, transparent 1px),
        linear-gradient(90deg, rgba(38, 50, 56, .045) 1px, transparent 1px);
      background-size: 28px 28px;
      content: "";
      inset: 0;
      pointer-events: none;
      position: fixed;
    }
    a { color: inherit; }
    .top-menu {
      background: rgba(255, 255, 255, 0.6);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(38, 50, 56, 0.1);
      position: sticky;
      top: 0;
      z-index: 100;
      padding: 0 clamp(1rem, 3vw, 2rem);
      margin-bottom: 2rem;
    }
    .top-menu-inner {
      max-width: 1180px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      height: 60px;
      gap: 2rem;
    }
    .top-menu .brand {
      font-weight: 900;
      font-size: 1.25rem;
      text-decoration: none;
      letter-spacing: -.03em;
    }
    .top-menu .menu-links {
      display: flex;
      gap: 1.5rem;
      height: 100%;
    }
    .top-menu .menu-links a {
      display: flex;
      align-items: center;
      text-decoration: none;
      font-weight: 600;
      color: var(--muted);
      border-bottom: 2px solid transparent;
      padding-top: 2px; /* optical alignment with border */
    }
    .top-menu .menu-links a:hover {
      color: var(--ink);
    }
    .top-menu .menu-links a.active {
      color: var(--ink);
      border-bottom-color: var(--ink);
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 { font-size: clamp(2.8rem, 9vw, 6.5rem); letter-spacing: -.08em; line-height: .86; margin-bottom: 1rem; max-width: 8ch; }
    h2 { font-size: clamp(1.6rem, 4vw, 2.6rem); letter-spacing: -.05em; margin-bottom: 1rem; }
    h3 { font-size: 1.15rem; margin-bottom: .4rem; }
    form { display: grid; gap: .9rem; margin: 0; }
    label { color: var(--muted); display: grid; font-size: .8rem; font-weight: 800; gap: .35rem; letter-spacing: .04em; text-transform: uppercase; }
    input, select, textarea {
      background: rgba(255, 255, 255, .76);
      border: 2px solid rgba(38, 50, 56, .74);
      border-radius: 16px 14px 18px 13px;
      color: var(--ink);
      font: inherit;
      min-height: 2.85rem;
      padding: .75rem .9rem;
      width: 100%;
    }
    textarea { resize: vertical; }
    input:focus, select:focus, textarea:focus { box-shadow: 0 0 0 4px rgba(255, 242, 183, .85); outline: none; }
    .shell { isolation: isolate; margin: 0 auto; max-width: 1220px; padding: clamp(1rem, 3vw, 2rem); position: relative; }
    .paper {
      background: var(--paper);
      border: 2px solid var(--line);
      border-radius: 30px 24px 34px 22px;
      box-shadow: var(--shadow);
      position: relative;
    }
    .paper::after {
      border: 1px dashed rgba(38, 50, 56, .32);
      border-radius: inherit;
      content: "";
      inset: .55rem;
      pointer-events: none;
      position: absolute;
    }
    .paper-peach { background: linear-gradient(145deg, rgba(255, 225, 210, .94), rgba(255, 250, 240, .92)); }
    .paper-mint { background: linear-gradient(145deg, rgba(223, 245, 232, .94), rgba(255, 250, 240, .9)); }
    .paper-lavender { background: linear-gradient(145deg, rgba(233, 225, 255, .95), rgba(255, 250, 240, .9)); }
    .paper-sky { background: linear-gradient(145deg, rgba(217, 239, 255, .96), rgba(255, 250, 240, .9)); }
    .paper-rose { background: linear-gradient(145deg, rgba(255, 220, 232, .94), rgba(255, 250, 240, .9)); }
    .hero { align-items: end; display: grid; gap: 1.5rem; grid-template-columns: minmax(0, 1fr) minmax(210px, .34fr); margin-bottom: 1.5rem; overflow: hidden; padding: clamp(1.3rem, 4vw, 2.5rem); }
    .lede { color: var(--muted); font-size: 1.06rem; max-width: 58ch; }
    .eyebrow { color: #7d5a2a; font-size: .78rem; font-weight: 900; letter-spacing: .14em; margin-bottom: .55rem; text-transform: uppercase; }
    .hero-note { background: rgba(255, 255, 255, .62); border: 2px solid var(--line); border-radius: 24px 18px 22px 16px; display: grid; gap: .2rem; padding: 1.25rem; transform: rotate(1.2deg); }
    .hero-note strong { font-size: 1.4rem; letter-spacing: -.03em; }
    .hero-note span:last-child { color: var(--muted); }
    .pin { background: #ff8ba7; border: 2px solid var(--line); border-radius: 999px; height: 16px; position: absolute; right: 1.2rem; top: 1rem; width: 16px; }
    .stats-grid, .form-grid { display: grid; gap: 1rem; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 1.5rem; }
    .stat-card { min-height: 150px; padding: 1.2rem; }
    .stat-card span { color: var(--muted); font-size: .78rem; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; }
    .stat-card strong { display: block; font-size: clamp(2rem, 5vw, 3.5rem); letter-spacing: -.08em; line-height: .92; margin: .65rem 0 .5rem; overflow-wrap: anywhere; }
    .stat-card p { color: var(--muted); margin-bottom: 0; }
    .panel, .card { margin-bottom: 1.5rem; padding: clamp(1rem, 3vw, 1.5rem); }
    .section-heading { align-items: start; display: flex; gap: 1rem; justify-content: space-between; }
    .site-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    .site-card { background: rgba(255, 255, 255, .58); border: 2px solid rgba(38, 50, 56, .72); border-radius: 24px 18px 26px 20px; display: grid; gap: 1rem; padding: 1rem; }
    .site-card:nth-child(2n) { transform: rotate(.35deg); }
    .site-card:nth-child(3n) { transform: rotate(-.3deg); }
    .site-card-top { align-items: start; display: flex; gap: 1rem; justify-content: space-between; }
    .site-card h3 { font-size: 1.7rem; letter-spacing: -.06em; margin: .45rem 0 .1rem; overflow-wrap: anywhere; }
    .site-card p { color: var(--muted); margin-bottom: 0; }
    .site-list { display: grid; gap: 1rem; }
    .site-row { padding: 1.5rem; }
    .site-row-header { display: flex; justify-content: space-between; align-items: start; border-bottom: 2px dashed rgba(38, 50, 56, 0.15); padding-bottom: 1rem; margin-bottom: 1.25rem; }
    .site-row-header h3 { margin: 0; font-size: 1.8rem; letter-spacing: -.05em; }
    .site-row-details { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1.25rem; margin-bottom: 1.5rem; }
    .inline-domain-form { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; margin-top: .5rem; }
    .inline-domain-form input[name="hostname"] { flex: 1 1 140px; min-height: 2.2rem; padding: .35rem .55rem; font-size: .85rem; }
    .inline-domain-form .check-row { font-size: .7rem; }
    .inline-domain-form .button { min-height: 2.2rem; padding: .35rem .7rem; font-size: .8rem; }
    .detail-group { display: flex; flex-direction: column; gap: 0.35rem; }
    .detail-label { font-size: 0.75rem; font-weight: 900; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .detail-value { font-weight: 500; overflow-wrap: anywhere; }
    .detail-value a { text-decoration: underline; text-decoration-color: rgba(38, 50, 56, 0.3); text-underline-offset: 2px; }
    .detail-value a:hover { text-decoration-color: var(--ink); }
    .runtime-tag { background: var(--butter); border: 2px solid var(--line); border-radius: 999px; display: inline-flex; font-size: .72rem; font-weight: 900; letter-spacing: .08em; padding: .2rem .55rem; text-transform: uppercase; }
    .status-pill { align-items: center; border: 2px solid var(--line); border-radius: 999px; display: inline-flex; font-size: .75rem; font-weight: 900; letter-spacing: .04em; padding: .32rem .62rem; text-transform: uppercase; white-space: nowrap; }
    .status-pill.good { background: #bdf3cf; }
    .status-pill.warn { background: #ffe6a7; }
    .status-pill.bad { background: #ffb6c7; }
    .status-pill.neutral { background: #dbeafe; }
    .meta-list { display: grid; gap: .75rem; margin: 0; }
    .meta-list div { min-width: 0; }
    .meta-list dt { color: var(--muted); font-size: .72rem; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; }
    .meta-list dd { margin: .1rem 0 0; overflow-wrap: anywhere; }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
    .button {
      align-items: center;
      background: var(--ink);
      border: 2px solid var(--line);
      border-radius: 999px;
      box-shadow: 3px 4px 0 rgba(38, 50, 56, .18);
      color: #fffaf0;
      cursor: pointer;
      display: inline-flex;
      font: inherit;
      font-weight: 900;
      justify-content: center;
      min-height: 2.55rem;
      padding: .55rem .9rem;
      text-decoration: none;
    }
    .button:hover { transform: translateY(-1px) rotate(-.4deg); }
    .button-soft, .button-ghost { background: #fffaf0; color: var(--ink); }
    .button-link { background: transparent; box-shadow: none; color: var(--ink); }
    .form-grid { align-items: start; grid-template-columns: 1.2fr .9fr .9fr; }
    .field-pair { display: grid; gap: .8rem; grid-template-columns: 1fr 1fr; }
    .check-row { align-items: center; display: flex; flex-direction: row; gap: .65rem; text-transform: none; }
    .check-row input { min-height: auto; width: auto; }
    .stack-list { display: grid; gap: .55rem; list-style: none; margin: 1rem 0 0; padding: 0; }
    .stack-list li { background: rgba(255, 255, 255, .54); border: 1px dashed rgba(38, 50, 56, .38); border-radius: 16px; display: grid; padding: .7rem .8rem; }
    .stack-list span { font-weight: 900; overflow-wrap: anywhere; }
    .stack-list small { color: var(--muted); }
    .deployment-list { display: grid; gap: .65rem; }
    .deployment-row { align-items: center; background: rgba(255, 255, 255, .58); border: 2px solid rgba(38, 50, 56, .58); border-radius: 20px 16px 21px 15px; display: grid; gap: .75rem; grid-template-columns: minmax(0, 1fr) auto minmax(130px, auto); padding: .85rem 1rem; }
    .deployment-row strong { display: block; overflow-wrap: anywhere; }
    .deployment-row span:not(.status-pill), .deployment-row small { color: var(--muted); }
    .deployment-actions { align-items: end; display: grid; gap: .35rem; justify-items: end; }
    .empty-state, .mini-empty { background: rgba(255, 255, 255, .58); border: 2px dashed rgba(38, 50, 56, .42); border-radius: 20px; color: var(--muted); padding: 1rem; }
    .site-editor-shell { max-width: 720px; margin: 0 auto 2rem auto; }
    .site-editor-shell form > .actions { margin-top: .75rem; }
    .readonly-block { margin-bottom: 1.1rem; }
    .readonly-block .detail-value { font-weight: 800; }
    .readonly-block small { color: var(--muted); display: block; margin-top: .38rem; font-weight: 500; font-size: .82rem; letter-spacing: normal; text-transform: none; }
    @media (max-width: 900px) {
      .hero, .form-grid, .stats-grid { grid-template-columns: 1fr 1fr; }
      .hero { align-items: stretch; }
    }
    @media (max-width: 640px) {
      .hero, .form-grid, .stats-grid, .field-pair, .deployment-row { grid-template-columns: 1fr; }
      .section-heading, .site-card-top { display: grid; }
      h1 { max-width: 100%; }
    }
  `;
}

function statusTone(status: unknown) {
  const normalized = String(status ?? "").toLowerCase();

  if (["deployed", "succeeded", "success", "healthy"].some((value) => normalized.includes(value))) {
    return "good";
  }

  if (["failed", "error", "down"].some((value) => normalized.includes(value))) {
    return "bad";
  }

  if (["running", "queued", "created", "pending"].some((value) => normalized.includes(value))) {
    return "warn";
  }

  return "neutral";
}

function formatDate(value: unknown) {
  if (!value) {
    return "";
  }

  const date = value instanceof Date ? value : new Date(String(value));

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderLogin(next: string, error = "") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${renderFaviconTags()}
  <title>Someting Login</title>
  <style>${renderAdminStyles()}</style>
</head>
<body>
  <main class="shell env-shell">
    <section class="hero paper paper-peach">
      <div>
        <p class="eyebrow">Welcome back</p>
        <h1>Someting</h1>
        <p class="lede">Sign in to manage sites, domains, deployments, logs, env files, and deploy credentials.</p>
      </div>
    </section>
    <section class="panel paper paper-mint">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Admin access</p>
          <h2>Login</h2>
        </div>
      </div>
      ${error ? `<div class="empty-state">${escapeHtml(error)}</div>` : ""}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${escapeHtml(next)}">
        <label>Username <input name="username" autocomplete="username" required autofocus></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
        <button class="button">Login</button>
      </form>
    </section>
  </main>
</body>
</html>`;
}

function renderEnvEditor(site: SiteRow, contents: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${renderFaviconTags()}
  <title>${escapeHtml(site.slug)} Env</title>
  <style>${renderAdminStyles()}</style>
</head>
<body>
  <main class="shell env-shell">
    <section class="hero paper paper-sky">
      <div>
        <p class="eyebrow">Environment</p>
        <h1>${escapeHtml(site.slug)}</h1>
        <p class="lede">Values are written to the site container env file on the VPS. Redeploy or restart the site after changing runtime variables.</p>
      </div>
      <div class="hero-note">
        <span class="pin"></span>
        <strong>${escapeHtml(site.runtime)}</strong>
        <span>${escapeHtml(site.status)}</span>
      </div>
    </section>

    <section class="panel paper paper-mint">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Secrets sketchpad</p>
          <h2>Edit Env File</h2>
        </div>
        <a class="button button-ghost" href="/admin">Back to admin</a>
      </div>
      <form method="post" action="/admin/sites/${site.id}/env">
        <label>File contents
          <textarea class="env-editor" name="contents" spellcheck="false">${escapeHtml(contents)}</textarea>
        </label>
        <button class="button">Save env file</button>
      </form>
    </section>
  </main>
  <style>
    .env-shell { max-width: 980px; }
    .env-editor {
      background: rgba(255, 255, 255, .8);
      font: 14px/1.55 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      min-height: 460px;
      white-space: pre;
    }
  </style>
</body>
</html>`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function renderStoragePage(
  site: SiteRow,
  subPath: string,
  entries: { name: string; type: string; size: number }[],
  openFile: { path: string; contents: string } | null,
) {
  const join = (name: string) => (subPath ? `${subPath}/${name}` : name);
  const segments = subPath ? subPath.split("/").filter(Boolean) : [];
  const parent = segments.slice(0, -1).join("/");
  const dirField = `<input type="hidden" name="dir" value="${escapeHtml(subPath)}">`;

  const crumbs = [`<a href="/admin/sites/${site.id}/storage">/data</a>`];
  segments.forEach((seg, index) => {
    const path = segments.slice(0, index + 1).join("/");
    crumbs.push(`<a href="/admin/sites/${site.id}/storage?path=${encodeURIComponent(path)}">${escapeHtml(seg)}</a>`);
  });

  const sorted = [...entries].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
  );

  const rows = sorted.length === 0
    ? `<div class="mini-empty">This directory is empty.</div>`
    : `<ul class="stack-list">${sorted
        .map((entry) => {
          const path = join(entry.name);
          if (entry.type === "directory") {
            return `<li>
              <span>📁 <a href="/admin/sites/${site.id}/storage?path=${encodeURIComponent(path)}">${escapeHtml(entry.name)}/</a></span>
              <small>directory
                <form method="post" action="/admin/sites/${site.id}/storage/delete" onsubmit="return confirm('Delete ${escapeHtml(entry.name)}/ and everything in it?')" style="display:inline">
                  ${dirField}<input type="hidden" name="path" value="${escapeHtml(path)}">
                  <button class="button button-link">Delete</button>
                </form>
              </small>
            </li>`;
          }
          return `<li>
            <span>📄 <a href="/admin/sites/${site.id}/storage?path=${encodeURIComponent(subPath)}&file=${encodeURIComponent(path)}">${escapeHtml(entry.name)}</a></span>
            <small>${escapeHtml(formatBytes(entry.size))}
              <form method="post" action="/admin/sites/${site.id}/storage/delete" onsubmit="return confirm('Delete ${escapeHtml(entry.name)}?')" style="display:inline">
                ${dirField}<input type="hidden" name="path" value="${escapeHtml(path)}">
                <button class="button button-link">Delete</button>
              </form>
            </small>
          </li>`;
        })
        .join("")}</ul>`;

  const editorPath = openFile ? openFile.path : subPath ? `${subPath}/` : "";
  const editorContents = openFile ? openFile.contents : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${renderFaviconTags()}
  <title>${escapeHtml(site.slug)} Storage</title>
  <style>${renderAdminStyles()}</style>
</head>
<body>
  <main class="shell env-shell">
    <section class="hero paper paper-sky">
      <div>
        <p class="eyebrow">Persistent storage</p>
        <h1>${escapeHtml(site.slug)}</h1>
        <p class="lede">Files in <code>sites/${escapeHtml(site.slug)}/shared</code> on the host, mounted at <code>/data</code> inside the container. This data survives redeploys.</p>
      </div>
      <div class="hero-note">
        <span class="pin"></span>
        <strong>${escapeHtml(site.runtime)}</strong>
        <span>${escapeHtml(site.status)}</span>
      </div>
    </section>

    <section class="panel paper paper-mint">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Browse</p>
          <h2>${crumbs.join(' <span class="crumb-sep">/</span> ')}</h2>
        </div>
        <a class="button button-ghost" href="/admin/websites">Back to websites</a>
      </div>
      ${subPath ? `<p><a class="button button-soft" href="/admin/sites/${site.id}/storage${parent ? `?path=${encodeURIComponent(parent)}` : ""}">⬆ Up one level</a></p>` : ""}
      ${rows}
    </section>

    <section class="panel paper paper-lavender">
      <div class="section-heading">
        <div>
          <p class="eyebrow">${openFile ? "Editing file" : "New / overwrite file"}</p>
          <h2>${openFile ? escapeHtml(openFile.path) : "Write a file"}</h2>
        </div>
      </div>
      <p class="lede">Path is relative to <code>/data</code>. Missing parent directories are created automatically. Text files only here; max 1 MB.</p>
      <form method="post" action="/admin/sites/${site.id}/storage/write">
        ${dirField}
        <label>File path <input name="path" value="${escapeHtml(editorPath)}" placeholder="uploads/example.txt" required></label>
        <label>Contents
          <textarea class="env-editor" name="contents" spellcheck="false">${escapeHtml(editorContents)}</textarea>
        </label>
        <button class="button">Save file</button>
      </form>
    </section>
  </main>
  <style>
    .env-shell { max-width: 980px; }
    .crumb-sep { color: var(--muted); }
    .stack-list li { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
    .stack-list small form { margin: 0; }
    .stack-list small .button-link { padding: 0 .25rem; min-height: auto; }
    .env-editor {
      background: rgba(255, 255, 255, .8);
      font: 14px/1.55 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      min-height: 320px;
      white-space: pre;
    }
    code { background: rgba(38,50,56,.08); border-radius: 6px; padding: 0 .35rem; }
  </style>
</body>
</html>`;
}

function renderDeploymentLog(deployment: {
  id: string;
  slug: string;
  status: string;
  output: string;
  started_at: Date;
  finished_at: Date | null;
}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${renderFaviconTags()}
  <title>${escapeHtml(deployment.slug)} Deployment Log</title>
  <style>${renderAdminStyles()}</style>
</head>
<body>
  <main class="shell env-shell">
    <section class="hero paper paper-rose">
      <div>
        <p class="eyebrow">Deployment output</p>
        <h1>${escapeHtml(deployment.slug)}</h1>
        <p class="lede">Deployment #${escapeHtml(deployment.id)} started ${escapeHtml(formatDate(deployment.started_at))}.</p>
      </div>
      <div class="hero-note">
        <span class="pin"></span>
        <strong>${escapeHtml(deployment.status)}</strong>
        <span>${escapeHtml(deployment.finished_at ? `Finished ${formatDate(deployment.finished_at)}` : "Still running")}</span>
      </div>
    </section>

    <section class="panel paper paper-mint">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Raw output</p>
          <h2>Logs</h2>
        </div>
        <a class="button button-ghost" href="/admin">Back to admin</a>
      </div>
      <pre class="log-output">${escapeHtml(deployment.output || "No deployment output was captured.")}</pre>
    </section>
  </main>
  <style>
    .env-shell { max-width: 1100px; }
    .log-output {
      background: #1f2933;
      border-radius: 18px;
      color: #f8fafc;
      font: 13px/1.55 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      margin: 0;
      max-height: 70vh;
      overflow: auto;
      padding: 1rem;
      white-space: pre-wrap;
    }
  </style>
</body>
</html>`;
}

function renderExecPage(site: SiteRow, result: { command: string; exitCode: number | null; output: string } | null) {
  const resultBlock = result === null
    ? ""
    : `<section class="panel paper paper-mint">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Exit code ${escapeHtml(result.exitCode ?? "?")}</p>
            <h2>Output</h2>
          </div>
        </div>
        <p class="lede"><code>$ ${escapeHtml(result.command)}</code></p>
        <pre class="log-output">${escapeHtml(result.output || "(no output)")}</pre>
      </section>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${renderFaviconTags()}
  <title>${escapeHtml(site.slug)} Terminal</title>
  <style>${renderAdminStyles()}</style>
</head>
<body>
  <main class="shell env-shell">
    <section class="hero paper paper-sky">
      <div>
        <p class="eyebrow">One-shot exec</p>
        <h1>${escapeHtml(site.slug)}</h1>
        <p class="lede">Runs <code>docker exec site-${escapeHtml(site.slug)} sh -lc "&lt;command&gt;"</code> with a 60s timeout. Non-interactive: no prompts, no PTY, no streaming.</p>
      </div>
      <div class="hero-note">
        <span class="pin"></span>
        <strong>${escapeHtml(site.runtime)}</strong>
        <span>${escapeHtml(site.status)}</span>
      </div>
    </section>

    <section class="panel paper paper-mint">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Run a command</p>
          <h2>Command</h2>
        </div>
        <a class="button button-ghost" href="/admin/websites">Back to websites</a>
      </div>
      <form method="post" action="/admin/sites/${site.id}/exec">
        <label>Command
          <input name="command" placeholder="ls -la" autofocus value="${escapeHtml(result?.command ?? "")}" required>
        </label>
        <button class="button">Run</button>
      </form>
    </section>

    ${resultBlock}
  </main>
  <style>
    .env-shell { max-width: 1100px; }
    .log-output {
      background: #1f2933;
      border-radius: 18px;
      color: #f8fafc;
      font: 13px/1.55 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      margin: 0;
      max-height: 70vh;
      overflow: auto;
      padding: 1rem;
      white-space: pre-wrap;
    }
    code { background: rgba(38,50,56,.08); border-radius: 6px; padding: 0 .35rem; }
  </style>
</body>
</html>`;
}

function renderDeployAuthEditor(site: SiteRow, auth: { mode: string; username?: string; hasSecret: boolean; token?: string; privateKey?: string }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${renderFaviconTags()}
  <title>${escapeHtml(site.slug)} Deploy Auth</title>
  <style>${renderAdminStyles()}</style>
</head>
<body>
  <main class="shell env-shell">
    <section class="hero paper paper-lavender">
      <div>
        <p class="eyebrow">Private repository access</p>
        <h1>${escapeHtml(site.slug)}</h1>
        <p class="lede">Configure credentials used only when this site runs Git deploys. Saved secrets are hidden by default and can be revealed while editing this page.</p>
      </div>
      <div class="hero-note">
        <span class="pin"></span>
        <strong>${escapeHtml(auth.mode)}</strong>
        <span>${auth.hasSecret ? "Secret configured" : "No secret configured"}</span>
      </div>
    </section>

    <section class="form-grid">
      <section class="paper card paper-mint">
        <p class="eyebrow">GitHub token</p>
        <h2>HTTPS Token</h2>
        <form method="post" action="/admin/sites/${site.id}/deploy-auth">
          <input type="hidden" name="mode" value="https-token">
          <label>Username <input name="username" value="${escapeHtml(auth.username ?? "x-access-token")}" required></label>
          <label>Token
            <span class="secret-field">
              <input id="github-token" name="token" type="password" autocomplete="off" value="${escapeHtml(auth.mode === "https-token" ? auth.token ?? "" : "")}" required>
              <button class="button button-soft" type="button" data-reveal="github-token">Show</button>
            </span>
          </label>
          <button class="button">Save token</button>
        </form>
      </section>

      <section class="paper card paper-sky">
        <p class="eyebrow">Deploy key</p>
        <h2>SSH Private Key</h2>
        <form method="post" action="/admin/sites/${site.id}/deploy-auth">
          <input type="hidden" name="mode" value="ssh-key">
          <label>Private key
            <span class="secret-tools"><button class="button button-soft" type="button" data-reveal-textarea="ssh-private-key">Show / hide key</button></span>
            <textarea id="ssh-private-key" class="secret-textarea" name="private_key" rows="9" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" required>${escapeHtml(auth.mode === "ssh-key" ? auth.privateKey ?? "" : "")}</textarea>
          </label>
          <button class="button">Save SSH key</button>
        </form>
      </section>
    </section>

    <section class="panel paper paper-rose">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Clear access</p>
          <h2>Remove Deploy Credentials</h2>
        </div>
        <a class="button button-ghost" href="/admin">Back to admin</a>
      </div>
      <p class="lede">Use this when the repository becomes public, when you rotate credentials, or when this site is deployed by upload instead of Git.</p>
      <form method="post" action="/admin/sites/${site.id}/deploy-auth">
        <input type="hidden" name="mode" value="none">
        <button class="button">Clear credentials</button>
      </form>
    </section>
  </main>
  <style>
    .env-shell { max-width: 980px; }
    .secret-field { align-items: center; display: grid; gap: .5rem; grid-template-columns: minmax(0, 1fr) auto; }
    .secret-tools { display: flex; justify-content: end; }
    .secret-textarea { -webkit-text-security: disc; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .secret-textarea.revealed { -webkit-text-security: none; }
  </style>
  <script>
    document.querySelectorAll("[data-reveal]").forEach((button) => {
      button.addEventListener("click", () => {
        const input = document.getElementById(button.dataset.reveal);
        if (!input) return;
        input.type = input.type === "password" ? "text" : "password";
        button.textContent = input.type === "password" ? "Show" : "Hide";
      });
    });
    document.querySelectorAll("[data-reveal-textarea]").forEach((button) => {
      button.addEventListener("click", () => {
        const textarea = document.getElementById(button.dataset.revealTextarea);
        if (!textarea) return;
        textarea.classList.toggle("revealed");
      });
    });
  </script>
</body>
</html>`;
}
