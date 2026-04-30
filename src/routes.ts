import type { FastifyInstance } from "fastify";
import { clearSessionCookie, createSessionCookie, verifyAdminCredentials } from "./auth.js";
import {
  addDomain,
  addMailNote,
  applyPathRouteBySlug,
  applyRouteBySlug,
  createSite,
  deploySiteBySlug,
  getDeploymentLogById,
  getSiteById,
  getSiteLogsBySlug,
  listPlatformState,
  readDeployAuthBySlug,
  readSiteEnvBySlug,
  type SiteRow,
  writeDeployAuthBySlug,
  writeSiteEnvBySlug,
} from "./platform.js";

export async function registerRoutes(app: FastifyInstance) {
  app.get("/healthz", async () => ({ ok: true }));

  app.get("/login", async (request, reply) => {
    const next = typeof (request.query as { next?: string }).next === "string" ? (request.query as { next: string }).next : "/admin";
    return reply.type("text/html").send(renderLogin(next));
  });

  app.post("/login", async (request, reply) => {
    const body = request.body as { username?: string; password?: string; next?: string };
    const next = body.next?.startsWith("/") ? body.next : "/admin";

    if (!verifyAdminCredentials(body.username ?? "", body.password ?? "")) {
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
    return reply.type("text/html").send(renderAdmin(state.sites, state.domains, state.deployments, state.mailNotes));
  });

  app.post("/admin/sites", async (request, reply) => {
    await createSite(request.body);
    return reply.redirect("/admin");
  });

  app.post("/admin/domains", async (request, reply) => {
    await addDomain(request.body);
    return reply.redirect("/admin");
  });

  app.post("/admin/mail-notes", async (request, reply) => {
    await addMailNote(request.body);
    return reply.redirect("/admin");
  });

  app.post("/admin/sites/:id/deploy", async (request, reply) => {
    const site = await getSite(request.params);
    await deploySiteBySlug(site.slug);
    return reply.redirect("/admin");
  });

  app.post("/admin/sites/:id/apply-route", async (request, reply) => {
    const site = await getSite(request.params);
    await applyRouteBySlug(site.slug);
    return reply.redirect("/admin");
  });

  app.post("/admin/sites/:id/apply-path-route", async (request, reply) => {
    const site = await getSite(request.params);
    await applyPathRouteBySlug(site.slug);
    return reply.redirect("/admin");
  });

  app.get("/admin/sites/:id/logs", async (request, reply) => {
    const site = await getSite(request.params);
    const logs = await getSiteLogsBySlug(site.slug);
    return reply.type("text/plain").send(logs);
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
    return reply.redirect("/admin");
  });

  app.get("/admin/sites/:id/deploy-auth", async (request, reply) => {
    const site = await getSite(request.params);
    const auth = await readDeployAuthBySlug(site.slug);
    return reply.type("text/html").send(renderDeployAuthEditor(site, auth));
  });

  app.post("/admin/sites/:id/deploy-auth", async (request, reply) => {
    const site = await getSite(request.params);
    await writeDeployAuthBySlug(site.slug, request.body);
    return reply.redirect("/admin");
  });
}

async function getSite(params: unknown) {
  const id = Number((params as { id?: string }).id);
  return getSiteById(id);
}

function renderAdmin(sites: SiteRow[], domains: any[], deployments: any[], mailNotes: any[]) {
  const siteOptions = sites.map((site) => `<option value="${site.id}">${escapeHtml(site.slug)}</option>`).join("");
  const latestDeployment = deployments[0];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Someting Admin</title>
  <style>${renderAdminStyles()}</style>
</head>
<body>
  <main class="shell">
    <section class="hero paper paper-peach">
      <div>
        <p class="eyebrow">VPS control room</p>
        <h1>Someting Admin</h1>
        <p class="lede">Manage sites, domains, deploys, generated Caddy routes, logs, and mail decisions without losing the handmade feel.</p>
      </div>
      <div class="hero-note">
        <span class="pin"></span>
        <strong>${escapeHtml(sites.length)} live notes</strong>
        <span>${escapeHtml(domains.length)} domains tracked</span>
        <form method="post" action="/logout"><button class="button button-link">Log out</button></form>
      </div>
    </section>

    <section class="stats-grid" aria-label="Platform summary">
      ${renderStatCard("Sites", sites.length, "Apps registered", "mint")}
      ${renderStatCard("Domains", domains.length, "Routes to keep tidy", "lavender")}
      ${renderStatCard("Mail Notes", mailNotes.length, "Delivery decisions", "sky")}
      ${renderStatCard("Last Deploy", latestDeployment?.status ?? "None", latestDeployment ? `${latestDeployment.slug} at ${formatDate(latestDeployment.started_at)}` : "No deploys yet", "rose")}
    </section>

    <section class="panel paper">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Workspace</p>
          <h2>Sites</h2>
        </div>
        <a class="button button-ghost" href="#add-site">Add a site</a>
      </div>
      ${
        sites.length === 0
          ? `<div class="empty-state">No sites yet. Create the first one below, then add a domain and apply its route.</div>`
          : `<div class="site-grid">
              ${sites
                .map(
                  (site) => `<article class="site-card">
                    <div class="site-card-top">
                      <div>
                        <span class="runtime-tag">${escapeHtml(site.runtime)}</span>
                        <h3>${escapeHtml(site.slug)}</h3>
                        <p>${escapeHtml(site.name)}</p>
                      </div>
                      <span class="status-pill ${statusTone(site.status)}">${escapeHtml(site.status)}</span>
                    </div>
                    <dl class="meta-list">
                      <div><dt>Repository</dt><dd>${escapeHtml(site.repo_url)}</dd></div>
                      <div><dt>Branch</dt><dd>${escapeHtml(site.branch)}</dd></div>
                      <div><dt>Health</dt><dd>${escapeHtml(site.healthcheck_path ?? "/")}</dd></div>
                    </dl>
                    <div class="actions">
                      <form method="post" action="/admin/sites/${site.id}/deploy"><button class="button">Redeploy</button></form>
                      <form method="post" action="/admin/sites/${site.id}/apply-route"><button class="button button-soft">Apply route</button></form>
                      <form method="post" action="/admin/sites/${site.id}/apply-path-route"><button class="button button-soft">Path route</button></form>
                      <a class="button button-link" href="/sites/${site.slug}/">Open path</a>
                      <a class="button button-link" href="/admin/sites/${site.id}/deploy-auth">Deploy Auth</a>
                      <a class="button button-link" href="/admin/sites/${site.id}/env">Env</a>
                      <a class="button button-link" href="/admin/sites/${site.id}/logs">Logs</a>
                    </div>
                  </article>`,
                )
                .join("")}
            </div>`
      }
    </section>

    <section class="form-grid">
      <section class="paper card paper-mint" id="add-site">
        <p class="eyebrow">New project</p>
        <h2>Add Site</h2>
        <form method="post" action="/admin/sites">
          <label>Slug <input name="slug" placeholder="my-site" required></label>
          <label>Name <input name="name" placeholder="My Site" required></label>
          <label>Runtime
          <select name="runtime"><option>html</option><option>static</option><option>node</option><option>python</option><option>php</option></select>
          </label>
          <label>Repository URL <input name="repo_url" placeholder="https://github.com/user/repo.git or upload://my-site" required></label>
          <div class="field-pair">
            <label>Branch <input name="branch" value="main" required></label>
            <label>Healthcheck path <input name="healthcheck_path" value="/"></label>
          </div>
          <label>Build command <input name="build_command" placeholder="npm run build"></label>
          <label>Start command <input name="start_command" placeholder="npm start"></label>
          <button class="button">Create site</button>
        </form>
      </section>

      <section class="paper card paper-lavender">
        <p class="eyebrow">Traffic map</p>
        <h2>Add Domain</h2>
        <form method="post" action="/admin/domains">
          <label>Site <select name="site_id">${siteOptions}</select></label>
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
    </section>

    <section class="panel paper paper-rose">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Timeline</p>
          <h2>Recent Deployments</h2>
        </div>
      </div>
      ${renderDeployments(deployments)}
    </section>
  </main>
</body>
</html>`;
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

function renderDeployAuthEditor(site: SiteRow, auth: { mode: string; username?: string; hasSecret: boolean; token?: string; privateKey?: string }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
