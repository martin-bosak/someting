import type { FastifyInstance } from "fastify";
import { clearSessionCookie, createSessionCookie, verifyAdminCredentials } from "./auth.js";
import { config } from "./config.js";
import {
  findSitesForGithubPush,
  verifyGithubSignature,
  type GithubPushEvent,
} from "./githubWebhook.js";
import {
  addDomain,
  addMailNote,
  applyPathRouteBySlug,
  applyRouteBySlug,
  createSite,
  provisionDatabase,
  deleteSiteBySlug,
  deleteSiteStorageEntry,
  deploySiteBySlug,
  execInSiteBySlug,
  getBackupStatus,
  getDeploymentLogById,
  getObservabilitySummary,
  getSiteById,
  getSiteLogsBySlug,
  getWeeklyVisits,
  listDeploymentLogsForSite,
  listSiteReleases,
  rollbackSiteBySlug,
  type WeeklyVisits,
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
import { createWedosARecord } from "./wapi.js";
import { createActive24ARecord } from "./active24.js";
import { listDnsAttempts, recordDnsAttempt, type DnsAttempt } from "./dnsLog.js";
import { listActivity, listActivityForSite, recordActivity, type ActivityRow } from "./activityLog.js";
import {
  addDnsDomain,
  DNS_PROVIDERS,
  listDnsDomains,
  listDomainsForProvider,
  removeDnsDomain,
  type DnsDomainRow,
} from "./dnsConfig.js";

export async function registerRoutes(app: FastifyInstance) {
  app.get("/healthz", async () => ({ ok: true }));

  app.post("/webhooks/github", async (request, reply) => {
    const rawBody = request.rawBody;
    if (!rawBody) {
      return reply.code(400).send({ ok: false, error: "Missing request body" });
    }
    if (!config.GITHUB_WEBHOOK_SECRET) {
      return reply.code(503).send({ ok: false, error: "GITHUB_WEBHOOK_SECRET is not configured" });
    }
    const signature = request.headers["x-hub-signature-256"];
    if (!verifyGithubSignature(rawBody, typeof signature === "string" ? signature : undefined)) {
      await recordActivity({
        category: "deploy",
        action: "GitHub webhook rejected",
        status: "error",
        detail: "Invalid X-Hub-Signature-256",
      });
      return reply.code(401).send({ ok: false, error: "Invalid signature" });
    }

    const event = request.headers["x-github-event"];
    if (event !== "push") {
      return reply.send({ ok: true, ignored: true, reason: `event=${String(event)}` });
    }

    let payload: GithubPushEvent;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as GithubPushEvent;
    } catch {
      return reply.code(400).send({ ok: false, error: "Invalid JSON payload" });
    }

    const sites = await findSitesForGithubPush(payload.repository ?? {}, payload.ref ?? "");
    if (sites.length === 0) {
      await recordActivity({
        category: "deploy",
        action: "GitHub webhook ignored",
        status: "info",
        detail: `No matching site for ${payload.repository?.full_name ?? "unknown"}@${payload.ref ?? ""}`,
      });
      return reply.send({ ok: true, ignored: true, reason: "no_matching_site" });
    }

    const results = [];
    for (const site of sites) {
      try {
        const result = await deploySiteBySlug(site.slug, {
          trigger: "github_webhook",
          expectedCommitSha: payload.head_commit?.id ?? undefined,
        });
        results.push({ slug: site.slug, status: result.status });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ slug: site.slug, status: "error", error: message });
        await recordActivity({
          category: "deploy",
          action: "GitHub webhook deploy failed",
          target: site.slug,
          status: "error",
          detail: message,
        });
      }
    }

    return reply.send({ ok: true, deployed: results });
  });

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
    const body = request.body as { username?: string; password?: string; next?: string; remember?: string };
    const next = body.next?.startsWith("/") ? body.next : "/admin";
    const remember = body.remember === "true" || body.remember === "on";

    if (!(await verifyAdminCredentials(body.username ?? "", body.password ?? ""))) {
      return reply.code(401).type("text/html").send(renderLogin(next, "Invalid username or password."));
    }

    return reply.header("Set-Cookie", createSessionCookie(body.username ?? "", remember)).redirect(next);
  });

  app.post("/logout", async (_request, reply) => {
    return reply.header("Set-Cookie", clearSessionCookie()).redirect("/login");
  });

  app.get("/", async (_request, reply) => reply.redirect("/admin"));

  app.get("/admin", async (_request, reply) => {
    const state = await listPlatformState();
    return reply
      .type("text/html")
      .send(renderAdminDashboard(state.sites, state.domains, state.deployments, state.mailNotes));
  });

  app.get("/admin/domains", async (_request, reply) => {
    const state = await listPlatformState();
    const dnsByProvider = await Promise.all(
      DNS_PROVIDERS.map(async (provider) => ({
        provider,
        domains: await listDomainsForProvider(provider.id),
      })),
    );
    return reply
      .type("text/html")
      .send(renderDomainsPage(state.sites, state.domains, dnsByProvider));
  });

  app.get("/admin/websites", async (_request, reply) => {
    const state = await listPlatformState();
    const visits: Record<string, WeeklyVisits> = {};
    await Promise.all(
      state.sites.map(async (site) => {
        visits[site.slug] = await getWeeklyVisits(site.slug);
      }),
    );
    return reply.type("text/html").send(renderWebsitesPage(state.sites, state.domains, visits));
  });

  app.get("/admin/sites/new", async (_request, reply) => {
    return reply.type("text/html").send(renderSiteEditorPage(null, "/admin/sites/new"));
  });

  app.get("/admin/sites/:id/edit", async (request, reply) => {
    const site = await getSite(request.params);
    return reply.type("text/html").send(renderSiteEditorPage(site, `/admin/sites/${site.id}/edit`));
  });

  app.get("/admin/sites/:id/detail", async (request, reply) => {
    const site = await getSite(request.params);
    const state = await listPlatformState();
    const siteDomains = state.domains.filter((d) => d.site_id === site.id);
    const [visits, deployments, activity, releases] = await Promise.all([
      getWeeklyVisits(site.slug),
      listDeploymentLogsForSite(site.slug).catch(() => []),
      listActivityForSite(site.slug, 40).catch(() => []),
      listSiteReleases(site.slug).catch(() => ({ activeRelease: null, releases: [] })),
    ]);
    let containerLogs = "";
    try {
      containerLogs = await getSiteLogsBySlug(site.slug, 200);
    } catch (err) {
      containerLogs = err instanceof Error ? err.message : String(err);
    }
    return reply
      .type("text/html")
      .send(renderSiteDetailPage(site, siteDomains, visits, deployments, activity, containerLogs, releases));
  });

  app.post("/admin/sites/:id/update", async (request, reply) => {
    const site = await getSite(request.params);
    await updateSiteMetadata(Number(site.id), request.body);
    return reply.redirect("/admin/websites");
  });

  app.post("/admin/sites/:id/delete", async (request, reply) => {
    const site = await getSite(request.params);
    await deleteSiteBySlug(site.slug);
    return reply.redirect("/admin/websites");
  });

  app.post("/admin/sites", async (request, reply) => {
    await createSite(request.body);
    return reply.redirect("/admin/websites");
  });

  app.post("/admin/domains", async (request, reply) => {
    await addDomain(request.body);
    return reply.redirect("/admin/domains");
  });

  app.post("/admin/mail-notes", async (request, reply) => {
    await addMailNote(request.body);
    return reply.redirect("/admin");
  });

  app.get("/admin/config", async (_request, reply) => {
    const domains = await listDnsDomains();
    return reply.type("text/html").send(renderConfigPage(domains));
  });

  app.post("/admin/config/dns-domains", async (request, reply) => {
    const body = request.body as { domain?: string; provider?: string };
    try {
      await addDnsDomain(body.domain ?? "", body.provider ?? "");
      await recordActivity({
        category: "dns",
        action: "Assign domain to provider",
        target: (body.domain ?? "").toLowerCase(),
        detail: `provider=${body.provider ?? ""}`,
      });
      return reply.redirect("/admin/config");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const domains = await listDnsDomains();
      return reply.code(400).type("text/html").send(renderConfigPage(domains, message));
    }
  });

  app.post("/admin/config/dns-domains/:id/delete", async (request, reply) => {
    const raw = String((request.params as { id?: string }).id ?? "");
    if (/^\d+$/.test(raw)) {
      await removeDnsDomain(Number(raw));
      await recordActivity({
        category: "dns",
        action: "Unassign domain from provider",
        target: `dns_domain#${raw}`,
      });
    }
    return reply.redirect("/admin/config");
  });

  app.post("/admin/dns/wedos/a-record", async (request, reply) => {
    const body = request.body as { domain?: string; subdomain?: string; ip?: string; ttl?: string };
    const started = Date.now();
    const domain = (body.domain ?? "").toLowerCase();
    const subdomain = (body.subdomain ?? "").toLowerCase();
    try {
      const result = await createWedosARecord({
        domain,
        subdomain,
        ip: body.ip,
        ttl: body.ttl ? Number(body.ttl) : undefined,
      });
      recordDnsAttempt({
        at: new Date().toISOString(),
        provider: "wedos",
        domain: result.domain,
        subdomain: result.subdomain,
        hostname: result.hostname,
        ip: result.ip,
        ttl: result.ttl,
        ok: true,
        durationMs: Date.now() - started,
      });
      await recordActivity({
        category: "dns",
        action: "Create A record (Wedos)",
        target: result.hostname,
        status: "ok",
        detail: `${result.hostname} → ${result.ip} (TTL ${result.ttl})`,
        durationMs: Date.now() - started,
      });
      return reply.type("application/json").send({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordDnsAttempt({
        at: new Date().toISOString(),
        provider: "wedos",
        domain,
        subdomain,
        hostname: subdomain && domain ? `${subdomain}.${domain}` : domain || subdomain,
        ip: body.ip,
        ok: false,
        error: message,
        durationMs: Date.now() - started,
      });
      await recordActivity({
        category: "dns",
        action: "Create A record (Wedos)",
        target: subdomain && domain ? `${subdomain}.${domain}` : domain || subdomain,
        status: "error",
        detail: message,
        durationMs: Date.now() - started,
      });
      return reply.code(400).type("application/json").send({ ok: false, error: message });
    }
  });

  app.post("/admin/dns/active24/a-record", async (request, reply) => {
    const body = request.body as { domain?: string; subdomain?: string; ip?: string; ttl?: string };
    const started = Date.now();
    const domain = (body.domain ?? "").toLowerCase();
    const subdomain = (body.subdomain ?? "").toLowerCase();
    try {
      const result = await createActive24ARecord({
        domain,
        subdomain,
        ip: body.ip,
        ttl: body.ttl ? Number(body.ttl) : undefined,
      });
      recordDnsAttempt({
        at: new Date().toISOString(),
        provider: "active24",
        domain: result.domain,
        subdomain: result.subdomain,
        hostname: result.hostname,
        ip: result.ip,
        ttl: result.ttl,
        ok: true,
        durationMs: Date.now() - started,
      });
      await recordActivity({
        category: "dns",
        action: "Create A record (Active24)",
        target: result.hostname,
        status: "ok",
        detail: `${result.hostname} → ${result.ip} (TTL ${result.ttl})`,
        durationMs: Date.now() - started,
      });
      return reply.type("application/json").send({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordDnsAttempt({
        at: new Date().toISOString(),
        provider: "active24",
        domain,
        subdomain,
        hostname: subdomain && domain ? `${subdomain}.${domain}` : domain || subdomain,
        ip: body.ip,
        ok: false,
        error: message,
        durationMs: Date.now() - started,
      });
      await recordActivity({
        category: "dns",
        action: "Create A record (Active24)",
        target: subdomain && domain ? `${subdomain}.${domain}` : domain || subdomain,
        status: "error",
        detail: message,
        durationMs: Date.now() - started,
      });
      return reply.code(400).type("application/json").send({ ok: false, error: message });
    }
  });

  app.get("/admin/dns/log.json", async (_request, reply) => {
    return reply.type("application/json").send({ attempts: listDnsAttempts() });
  });

  app.post("/admin/databases", async (request, reply) => {
    const result = await provisionDatabase(request.body);
    return reply.type("application/json").send(result);
  });

  app.post("/admin/sites/:id/rollback", async (request, reply) => {
    const site = await getSite(request.params);
    const body = request.body as { release_id?: string };
    const releaseId = (body.release_id ?? "").trim();
    if (!releaseId) {
      throw new Error("release_id is required");
    }
    await rollbackSiteBySlug(site.slug, releaseId);
    return reply.redirect(`/admin/sites/${site.id}/detail`);
  });

  app.get("/admin/backups", async (_request, reply) => {
    const backup = await getBackupStatus();
    return reply.type("text/html").send(renderBackupsPage(backup));
  });

  app.get("/admin/observability", async (_request, reply) => {
    const summary = await getObservabilitySummary();
    return reply.type("text/html").send(renderObservabilityPage(summary));
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

  app.get("/admin/logs", async (request, reply) => {
    const query = request.query as { category?: string };
    const category = ACTIVITY_CATEGORIES.includes(query.category as any)
      ? (query.category as ActivityRow["category"])
      : undefined;
    const entries = await listActivity({ limit: 300, category });
    return reply.type("text/html").send(renderLogsPage(entries, category));
  });

  app.get("/admin/logs.json", async (request, reply) => {
    const query = request.query as { category?: string };
    const category = ACTIVITY_CATEGORIES.includes(query.category as any)
      ? (query.category as ActivityRow["category"])
      : undefined;
    const entries = await listActivity({ limit: 300, category });
    return reply.type("application/json").send({ entries });
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
        <a href="/admin/domains" class="${currentPath.startsWith("/admin/domains") ? "active" : ""}">Domains</a>
        <a href="/admin/deployments" class="${currentPath.startsWith("/admin/deployments") ? "active" : ""}">Deployments</a>
        <a href="/admin/observability" class="${currentPath.startsWith("/admin/observability") ? "active" : ""}">Observability</a>
        <a href="/admin/backups" class="${currentPath.startsWith("/admin/backups") ? "active" : ""}">Backups</a>
        <a href="/admin/logs" class="${currentPath.startsWith("/admin/logs") ? "active" : ""}">Logs</a>
        <a href="/admin/config" class="${currentPath.startsWith("/admin/config") ? "active" : ""}">Config</a>
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

function renderAdminDashboard(
  sites: SiteRow[],
  domains: any[],
  deployments: any[],
  mailNotes: any[],
) {
  const latestDeployment = deployments[0];

  const content = `
    <section class="stats-grid" aria-label="Platform summary">
      ${renderStatCard("Sites", sites.length, "Apps registered", "mint")}
      ${renderStatCard("Domains", domains.length, "Routes to keep tidy", "lavender")}
      ${renderStatCard("Mail Notes", mailNotes.length, "Delivery decisions", "sky")}
      ${renderStatCard("Last Deploy", latestDeployment?.status ?? "None", latestDeployment ? `${latestDeployment.slug} at ${formatDate(latestDeployment.started_at)}` : "No deploys yet", "rose")}
    </section>

    <section class="panel paper">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Hosted</p>
          <h2>Sites</h2>
        </div>
        <a class="button button-ghost" href="/admin/sites/new">Add a site</a>
      </div>
      ${renderDashboardSitesList(sites, domains)}
    </section>

    <section class="form-grid">
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

function renderDashboardSitesList(sites: SiteRow[], domains: any[]) {
  if (sites.length === 0) {
    return `<div class="empty-state">No sites yet. <a href="/admin/sites/new">Create your first site</a>.</div>`;
  }

  const rows = sites
    .map((site) => {
      const siteDomains = domains.filter((d) => d.site_id === site.id);
      const primary = siteDomains.find((d) => d.is_primary) ?? siteDomains[0];
      const domainHtml = primary
        ? `<a class="dash-site-domain" href="https://${escapeHtml(primary.hostname)}" target="_blank">${escapeHtml(primary.hostname)}</a>`
        : `<span class="muted">No domain</span>`;

      return `<li class="dash-site">
        <div class="dash-site-main">
          <span class="status-dot ${statusTone(site.status)}" title="${escapeHtml(site.status)}"></span>
          <div class="dash-site-id">
            <strong>${escapeHtml(site.name || site.slug)}</strong>
            <small class="muted">${escapeHtml(site.slug)} · ${escapeHtml(site.runtime)}</small>
          </div>
        </div>
        <div class="dash-site-mid">
          <span class="status-pill ${statusTone(site.status)}">${escapeHtml(site.status)}</span>
          ${domainHtml}
        </div>
        <div class="dash-site-actions">
          <a class="button button-soft" href="/admin/sites/${site.id}/detail">Config</a>
        </div>
      </li>`;
    })
    .join("");

  return `<ul class="dash-site-list">${rows}</ul>`;
}

function renderDomainsPage(
  sites: SiteRow[],
  domains: any[],
  dnsByProvider: { provider: (typeof DNS_PROVIDERS)[number]; domains: string[] }[],
) {
  const dnsCards = dnsByProvider
    .map(({ provider, domains: providerDomains }) =>
      renderDnsCard({
        eyebrow: `${provider.label} DNS`,
        title: "Create A Record",
        hint: `${provider.hint} Manage which domains appear here on the <a href="/admin/config">Config</a> page.`,
        domains: providerDomains,
        endpoint: provider.endpoint,
        tone: provider.tone,
      }),
    )
    .join("\n");

  const content = `
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

      ${dnsCards}

      ${renderDnsAutomationScript()}
    </section>

    ${renderDnsLogPanel()}`;

  return renderAdminLayout("Domains", "/admin/domains", content, sites.length, domains.length);
}

function renderConfigPage(dnsDomains: DnsDomainRow[], error = "") {
  const providerOptions = DNS_PROVIDERS.map(
    (provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.label)}</option>`,
  ).join("");

  const providerCards = DNS_PROVIDERS.map((provider) => {
    const rows = dnsDomains.filter((row) => row.provider === provider.id);
    const list = rows.length === 0
      ? `<div class="mini-empty">No domains assigned to ${escapeHtml(provider.label)}.</div>`
      : `<ul class="stack-list">${rows
          .map(
            (row) => `<li class="config-domain-row">
              <span>${escapeHtml(row.domain)}</span>
              <form method="post" action="/admin/config/dns-domains/${row.id}/delete" onsubmit="return confirm('Remove ${escapeHtml(row.domain)} from ${escapeHtml(provider.label)}? Its A-record button disappears; existing DNS records are not touched.');">
                <button class="button button-danger">Remove</button>
              </form>
            </li>`,
          )
          .join("")}</ul>`;

    return `<section class="paper card paper-${provider.tone}">
      <p class="eyebrow">${escapeHtml(provider.label)}</p>
      <h3>Assigned domains</h3>
      ${list}
    </section>`;
  }).join("\n");

  const content = `
    <section class="panel paper paper-lavender">
      <div class="section-heading">
        <div>
          <p class="eyebrow">DNS registrars</p>
          <h2>Provider Domains</h2>
        </div>
        <a class="button button-ghost" href="/admin">Back to dashboard</a>
      </div>
      <p class="lede">Assign each managed domain to the registrar/provider that hosts its DNS. Only assigned domains get a "Create A Record" button on the dashboard, and a domain can only be driven through the provider it is assigned to.</p>
      ${error ? `<div class="empty-state">${escapeHtml(error)}</div>` : ""}
      <form method="post" action="/admin/config/dns-domains" class="config-add-form">
        <label>Domain <input name="domain" placeholder="example.com" required></label>
        <label>Provider <select name="provider" required>${providerOptions}</select></label>
        <button class="button">Add / assign domain</button>
      </form>
    </section>

    <section class="form-grid config-provider-grid">
      ${providerCards}
    </section>`;

  return renderAdminLayout("Config", "/admin/config", content);
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

const ACTIVITY_CATEGORIES = ["dns", "route", "domain", "deploy", "site", "database", "mail", "system"] as const;

const ACTIVITY_CATEGORY_LABELS: Record<string, string> = {
  dns: "DNS",
  route: "Routing",
  domain: "Domains",
  deploy: "Deploys",
  site: "Sites",
  database: "Databases",
  mail: "Mail",
  system: "System",
};

function activityCategoryTone(category: string) {
  switch (category) {
    case "dns":
      return "lavender";
    case "route":
      return "sky";
    case "deploy":
      return "rose";
    case "domain":
      return "mint";
    default:
      return "peach";
  }
}

function renderLogsPage(entries: ActivityRow[], active?: string) {
  const filters = [
    `<a class="log-filter${active ? "" : " active"}" href="/admin/logs">All</a>`,
    ...ACTIVITY_CATEGORIES.map(
      (cat) =>
        `<a class="log-filter${active === cat ? " active" : ""}" href="/admin/logs?category=${cat}">${escapeHtml(
          ACTIVITY_CATEGORY_LABELS[cat],
        )}</a>`,
    ),
  ].join("");

  const body =
    entries.length === 0
      ? `<div class="empty-state">No activity recorded yet${active ? ` in "${escapeHtml(ACTIVITY_CATEGORY_LABELS[active] ?? active)}"` : ""}. DNS changes, route/path applies, deploys, and site actions show up here as they happen.</div>`
      : `<ul class="log-list">${entries.map(renderLogItem).join("")}</ul>`;

  const content = `
    <section class="panel paper">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Audit trail</p>
          <h2>Activity Logs</h2>
        </div>
        <button type="button" class="button button-soft" id="logs-refresh">Refresh</button>
      </div>
      <p class="lede">Everything Someting does on your behalf — DNS A-records, Caddy route &amp; path applies, deploys, and site lifecycle — newest first. Persisted in Postgres so it survives restarts. Container logs (<code>docker logs</code>) keep the raw lines too.</p>
      <div class="log-filters">${filters}</div>
      <div id="logs-body" data-endpoint="/admin/logs.json${active ? `?category=${active}` : ""}">${body}</div>
    </section>
    ${renderLogsScript()}`;

  return renderAdminLayout("Logs", "/admin/logs", content);
}

function renderLogItem(entry: ActivityRow) {
  const tone = activityCategoryTone(entry.category);
  const statusClass = entry.status === "error" ? "bad" : entry.status === "info" ? "warn" : "good";
  const duration = entry.duration_ms != null ? ` · ${entry.duration_ms} ms` : "";
  const detail = entry.detail
    ? `<details class="log-detail"><summary>Detail</summary><pre>${escapeHtml(entry.detail)}</pre></details>`
    : "";
  return `<li class="log-item">
    <div class="log-head">
      <span class="log-cat log-cat-${tone}">${escapeHtml(ACTIVITY_CATEGORY_LABELS[entry.category] ?? entry.category)}</span>
      <span class="status-pill ${statusClass}">${escapeHtml(entry.status)}</span>
      <strong class="log-action">${escapeHtml(entry.action)}</strong>
      <span class="log-target">${escapeHtml(entry.target ?? "")}</span>
      <time class="log-time">${escapeHtml(formatDate(entry.at))}${escapeHtml(duration)}</time>
    </div>
    ${detail}
  </li>`;
}

function renderLogsScript() {
  return `<script>
  (function () {
    var btn = document.getElementById("logs-refresh");
    var bodyEl = document.getElementById("logs-body");
    if (!btn || !bodyEl) return;

    function esc(v) {
      return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    var labels = ${JSON.stringify(ACTIVITY_CATEGORY_LABELS)};
    var tones = { dns: "lavender", route: "sky", deploy: "rose", domain: "mint" };
    function tone(c) { return tones[c] || "peach"; }

    function render(entries) {
      if (!entries.length) return '<div class="empty-state">No activity recorded yet.</div>';
      return '<ul class="log-list">' + entries.map(function (e) {
        var statusClass = e.status === "error" ? "bad" : e.status === "info" ? "warn" : "good";
        var dur = e.duration_ms != null ? " · " + e.duration_ms + " ms" : "";
        var when = new Date(e.at).toLocaleString();
        var detail = e.detail ? '<details class="log-detail"><summary>Detail</summary><pre>' + esc(e.detail) + '</pre></details>' : "";
        return '<li class="log-item"><div class="log-head">'
          + '<span class="log-cat log-cat-' + tone(e.category) + '">' + esc(labels[e.category] || e.category) + '</span>'
          + '<span class="status-pill ' + statusClass + '">' + esc(e.status) + '</span>'
          + '<strong class="log-action">' + esc(e.action) + '</strong>'
          + '<span class="log-target">' + esc(e.target || "") + '</span>'
          + '<time class="log-time">' + esc(when) + esc(dur) + '</time>'
          + '</div>' + detail + '</li>';
      }).join("") + '</ul>';
    }

    btn.addEventListener("click", async function () {
      btn.disabled = true;
      try {
        var res = await fetch(bodyEl.dataset.endpoint, { headers: { Accept: "application/json" } });
        var data = await res.json();
        bodyEl.innerHTML = render(data.entries || []);
      } catch (err) {
        // leave existing content
      } finally {
        btn.disabled = false;
      }
    });
  })();
  </script>`;
}

function renderVisitsChart(visits: WeeklyVisits | undefined) {
  const series = visits?.weeks ?? [];
  if (series.length === 0) {
    return `<span class="site-visits-meta muted">no traffic data</span>`;
  }
  const max = Math.max(1, ...series.map((w) => w.count));
  const barW = 9;
  const gap = 4;
  const h = 30;
  const width = series.length * (barW + gap) - gap;

  const bars = series
    .map((w, i) => {
      const bh = w.count === 0 ? 2 : Math.round((w.count / max) * (h - 3)) + 3;
      const x = i * (barW + gap);
      const y = h - bh;
      const opacity = (0.35 + 0.65 * ((i + 1) / series.length)).toFixed(2);
      const when = new Date(w.start).toLocaleDateString();
      const label = `${w.count} visit${w.count === 1 ? "" : "s"} · week of ${when}`;
      return `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="2" fill-opacity="${opacity}"><title>${escapeHtml(label)}</title></rect>`;
    })
    .join("");

  return `<svg class="visits-chart" viewBox="0 0 ${width} ${h}" width="${width}" height="${h}" role="img" aria-label="Visits per week, last ${series.length} weeks">${bars}</svg>`;
}

function renderHealthBadge(site: SiteRow) {
  const status = site.last_health_status ?? "unknown";
  const tone = status === "healthy" ? "good" : status === "unhealthy" ? "bad" : "neutral";
  const title = site.last_health_error
    ? escapeHtml(site.last_health_error)
    : site.last_health_checked_at
      ? `Checked ${formatDate(site.last_health_checked_at)}`
      : "Not checked yet";
  return `<span class="status-pill ${tone}" title="${title}">health: ${escapeHtml(status)}</span>`;
}

function renderGithubWebhookInfo() {
  const configured = Boolean(config.GITHUB_WEBHOOK_SECRET);
  const host = config.MANAGEMENT_HOST === "localhost" ? "your-admin-host" : config.MANAGEMENT_HOST;
  const endpoint = `https://${host}/webhooks/github`;
  return `<div class="webhook-box">
    <p class="lede">Configure a GitHub repository webhook with content type <code>application/json</code>, secret matching <code>GITHUB_WEBHOOK_SECRET</code>, and events: <strong>Just the push event</strong>.</p>
    <p><span class="detail-label">Endpoint</span> <code>${escapeHtml(endpoint)}</code></p>
    <p><span class="detail-label">Secret configured</span> <span class="status-pill ${configured ? "good" : "warn"}">${configured ? "yes" : "no"}</span></p>
  </div>`;
}

function renderSiteCard(site: SiteRow, siteDomains: any[], visits: WeeklyVisits | undefined) {
  const domainList = siteDomains.length > 0
    ? siteDomains
        .map((d) => `<a href="https://${escapeHtml(d.hostname)}" target="_blank">${escapeHtml(d.hostname)}${d.is_primary ? " ★" : ""}</a>`)
        .join(" ")
    : `<span class="muted">No domains</span>`;

  const recent = visits?.recentTotal ?? 0;
  const allTime = visits?.allTime ?? 0;

  return `<article class="site-row paper paper-mint">
    <div class="site-row-top">
      <div class="site-row-id">
        <h3>${escapeHtml(site.slug)}</h3>
        <span class="status-pill ${statusTone(site.status)}">${escapeHtml(site.status)}</span>
        ${renderHealthBadge(site)}
        <span class="runtime-tag">${escapeHtml(site.runtime)}</span>
      </div>
      <div class="site-visits">
        ${renderVisitsChart(visits)}
        <span class="site-visits-meta"><strong>${recent}</strong> in 10 wk · ${allTime} total</span>
      </div>
    </div>

    <div class="site-meta-line">
      <span class="site-meta-item"><span class="detail-label">Domains</span> ${domainList}</span>
      <span class="site-meta-item"><span class="detail-label">Repo</span> <a href="${escapeHtml(site.repo_url.replace(".git", ""))}" target="_blank">${escapeHtml(site.repo_url)}</a> <small class="muted">(${escapeHtml(site.branch)}${site.repo_subdir ? ` · ${escapeHtml(site.repo_subdir)}/` : ""})</small></span>
    </div>

    <details class="site-domain-add">
      <summary>+ Add domain</summary>
      <form method="post" action="/admin/domains" class="inline-domain-form">
        <input type="hidden" name="site_id" value="${site.id}">
        <input name="hostname" placeholder="example.com" required>
        <label class="check-row"><input type="checkbox" name="is_primary" value="true"> Primary</label>
        <button class="button button-soft">Add domain</button>
      </form>
    </details>

    <div class="action-bar">
      <div class="action-group">
        <span class="action-group-label">Deploy</span>
        <div class="action-group-buttons">
          <form method="post" action="/admin/sites/${site.id}/deploy"><button class="button">Redeploy</button></form>
          <form method="post" action="/admin/sites/${site.id}/recreate"><button class="button button-soft">Recreate</button></form>
          <form method="post" action="/admin/sites/${site.id}/restart"><button class="button button-soft">Restart</button></form>
        </div>
      </div>
      <div class="action-group">
        <span class="action-group-label">Routing</span>
        <div class="action-group-buttons">
          <form method="post" action="/admin/sites/${site.id}/apply-route"><button class="button button-soft">Apply route</button></form>
          <form method="post" action="/admin/sites/${site.id}/apply-path-route"><button class="button button-soft">Path route</button></form>
          <a class="button button-soft" href="/sites/${site.slug}/">Open path</a>
        </div>
      </div>
      <div class="action-group">
        <span class="action-group-label">Manage</span>
        <div class="action-group-buttons">
          <a class="button button-link" href="/admin/sites/${site.id}/edit">Edit</a>
          <a class="button button-link" href="/admin/sites/${site.id}/env">Env</a>
          <a class="button button-link" href="/admin/sites/${site.id}/storage">Storage</a>
          <a class="button button-link" href="/admin/sites/${site.id}/deploy-auth">Deploy Auth</a>
          <a class="button button-link" href="/admin/sites/${site.id}/exec">Terminal</a>
          <a class="button button-link" href="/admin/sites/${site.id}/logs">Logs</a>
        </div>
      </div>
      <div class="action-group action-group-danger">
        <span class="action-group-label">Danger</span>
        <div class="action-group-buttons">
          <form method="post" action="/admin/sites/${site.id}/delete" onsubmit="return confirm('Permanently delete ${escapeHtml(site.slug)}? This destroys its container, storage, and database row.');"><button class="button button-danger">Delete</button></form>
        </div>
      </div>
    </div>
  </article>`;
}

function renderWebsitesPage(sites: SiteRow[], domains: any[], visits: Record<string, WeeklyVisits>) {
  const siteListHtml = sites.length === 0
    ? `<div class="empty-state">No sites yet. <a href="/admin/sites/new">Create your first site</a>.</div>`
    : `<div class="site-list">
        ${sites
          .map((site) => renderSiteCard(site, domains.filter((d) => d.site_id === site.id), visits[site.slug]))
          .join("")}
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

function renderSiteDetailPage(
  site: SiteRow,
  siteDomains: any[],
  visits: WeeklyVisits | undefined,
  deployments: any[],
  activity: ActivityRow[],
  containerLogs: string,
  releases: { activeRelease: string | null; releases: { id: string; active: boolean }[] },
) {
  const primary = siteDomains.find((d) => d.is_primary) ?? siteDomains[0];
  const repoUrlClean = site.repo_url.replace(".git", "");

  const detailCells = [
    ["Status", `<span class="status-pill ${statusTone(site.status)}">${escapeHtml(site.status)}</span>`],
    ["Runtime", `<span class="runtime-tag">${escapeHtml(site.runtime)}</span>`],
    ["Slug", `<code>${escapeHtml(site.slug)}</code>`],
    [
      "Repository",
      site.repo_url
        ? `<a href="${escapeHtml(repoUrlClean)}" target="_blank">${escapeHtml(site.repo_url)}</a>`
        : `<span class="muted">none</span>`,
    ],
    ["Branch", `<code>${escapeHtml(site.branch)}</code>`],
    ["Subdirectory", site.repo_subdir ? `<code>${escapeHtml(site.repo_subdir)}/</code>` : `<span class="muted">repo root</span>`],
    ["Healthcheck", `<code>${escapeHtml(site.healthcheck_path ?? "/")}</code>`],
    ["Health status", renderHealthBadge(site)],
    ["Build command", site.build_command ? `<code>${escapeHtml(site.build_command)}</code>` : `<span class="muted">none</span>`],
    ["Start command", site.start_command ? `<code>${escapeHtml(site.start_command)}</code>` : `<span class="muted">none</span>`],
  ]
    .map(
      ([label, value]) => `<div class="detail-cell">
        <span class="detail-label">${escapeHtml(label)}</span>
        <div class="detail-value">${value}</div>
      </div>`,
    )
    .join("");

  const domainsHtml = siteDomains.length > 0
    ? `<ul class="stack-list">${siteDomains
        .map(
          (d) => `<li>
            <span><a href="https://${escapeHtml(d.hostname)}" target="_blank">${escapeHtml(d.hostname)}</a>${d.is_primary ? ` <span class="status-pill good">primary</span>` : ""}</span>
          </li>`,
        )
        .join("")}</ul>`
    : `<div class="mini-empty">No domains configured yet.</div>`;

  const recent = visits?.recentTotal ?? 0;
  const allTime = visits?.allTime ?? 0;

  const activityHtml = activity.length > 0
    ? `<ul class="log-list">${activity.map(renderLogItem).join("")}</ul>`
    : `<div class="mini-empty">No activity recorded for this site yet.</div>`;

  const deploymentsHtml = deployments.length > 0
    ? `<ul class="stack-list">${deployments
        .map(
          (d) => `<li>
            <span>
              <span class="status-pill ${statusTone(d.status)}">${escapeHtml(d.status)}</span>
              ${d.commit_sha ? `<code>${escapeHtml(String(d.commit_sha).slice(0, 7))}</code>` : ""}
              ${d.release_id ? `<small class="muted">release ${escapeHtml(d.release_id)}</small>` : ""}
              ${d.trigger ? `<small class="muted">${escapeHtml(d.trigger)}</small>` : ""}
              <a href="/admin/deployments/${d.id}/logs">View logs</a>
            </span>
            <small>${escapeHtml(formatDate(d.started_at))}${d.health_status ? ` · health ${escapeHtml(d.health_status)}` : ""}</small>
          </li>`,
        )
        .join("")}</ul>`
    : `<div class="mini-empty">No deployments have run for this site yet.</div>`;

  const releasesHtml = releases.releases.length > 0
    ? `<ul class="stack-list">${releases.releases
        .map(
          (release) => `<li>
            <span>
              <code>${escapeHtml(release.id)}</code>
              ${release.active ? `<span class="status-pill good">active</span>` : ""}
            </span>
            ${
              release.active
                ? `<small class="muted">current release</small>`
                : `<form method="post" action="/admin/sites/${site.id}/rollback" onsubmit="return confirm('Roll back ${escapeHtml(site.slug)} to release ${escapeHtml(release.id)}?');">
                    <input type="hidden" name="release_id" value="${escapeHtml(release.id)}">
                    <button class="button button-soft">Rollback</button>
                  </form>`
            }
          </li>`,
        )
        .join("")}</ul>`
    : `<div class="mini-empty">No retained releases yet. Git deploys keep the latest five release folders.</div>`;

  const content = `
    <section class="panel paper paper-mint site-detail-head">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Site detail</p>
          <h2>${escapeHtml(site.name || site.slug)}</h2>
          <p class="lede">${primary ? `<a href="https://${escapeHtml(primary.hostname)}" target="_blank">${escapeHtml(primary.hostname)}</a>` : `<a href="/sites/${escapeHtml(site.slug)}/">/sites/${escapeHtml(site.slug)}/</a>`}</p>
        </div>
        <div class="detail-head-actions">
          <a class="button button-ghost" href="/admin">Back to dashboard</a>
          <a class="button" href="/admin/sites/${site.id}/edit">Edit</a>
        </div>
      </div>

      <div class="action-bar">
        <div class="action-group">
          <span class="action-group-label">Deploy</span>
          <div class="action-group-buttons">
            <form method="post" action="/admin/sites/${site.id}/deploy"><button class="button">Redeploy</button></form>
            <form method="post" action="/admin/sites/${site.id}/recreate"><button class="button button-soft">Recreate</button></form>
            <form method="post" action="/admin/sites/${site.id}/restart"><button class="button button-soft">Restart</button></form>
          </div>
        </div>
        <div class="action-group">
          <span class="action-group-label">Routing</span>
          <div class="action-group-buttons">
            <form method="post" action="/admin/sites/${site.id}/apply-route"><button class="button button-soft">Apply route</button></form>
            <form method="post" action="/admin/sites/${site.id}/apply-path-route"><button class="button button-soft">Path route</button></form>
            <a class="button button-soft" href="/sites/${site.slug}/">Open path</a>
          </div>
        </div>
        <div class="action-group">
          <span class="action-group-label">Manage</span>
          <div class="action-group-buttons">
            <a class="button button-link" href="/admin/sites/${site.id}/env">Env</a>
            <a class="button button-link" href="/admin/sites/${site.id}/storage">Storage</a>
            <a class="button button-link" href="/admin/sites/${site.id}/deploy-auth">Deploy Auth</a>
            <a class="button button-link" href="/admin/sites/${site.id}/exec">Terminal</a>
          </div>
        </div>
      </div>
    </section>

    <section class="detail-columns">
      <section class="panel paper">
        <div class="section-heading"><div><p class="eyebrow">Configuration</p><h2>Overview</h2></div></div>
        <div class="detail-grid">${detailCells}</div>
      </section>

      <section class="panel paper paper-lavender">
        <div class="section-heading"><div><p class="eyebrow">Traffic</p><h2>Visits</h2></div></div>
        <div class="detail-visits">
          ${renderVisitsChart(visits)}
          <p class="site-visits-meta"><strong>${recent}</strong> in last 10 weeks · ${allTime} all-time</p>
        </div>
        <h3>Domains</h3>
        ${domainsHtml}
        <details class="site-domain-add">
          <summary>+ Add domain</summary>
          <form method="post" action="/admin/domains" class="inline-domain-form">
            <input type="hidden" name="site_id" value="${site.id}">
            <input name="hostname" placeholder="example.com" required>
            <label class="check-row"><input type="checkbox" name="is_primary" value="true"> Primary</label>
            <button class="button button-soft">Add domain</button>
          </form>
        </details>
      </section>
    </section>

    <section class="panel paper">
      <div class="section-heading">
        <div><p class="eyebrow">Runtime</p><h2>Container Logs</h2></div>
        <button type="button" class="button button-soft" id="site-logs-refresh">Refresh</button>
      </div>
      <p class="lede">Last 200 lines from <code>docker logs site-${escapeHtml(site.slug)}</code>.</p>
      <pre class="logbox" id="site-logs-box" data-endpoint="/admin/sites/${site.id}/logs">${escapeHtml(containerLogs || "No logs returned.")}</pre>
    </section>

    <section class="detail-columns">
      <section class="panel paper">
        <div class="section-heading"><div><p class="eyebrow">Audit</p><h2>Recent Activity</h2></div></div>
        ${activityHtml}
      </section>
      <section class="panel paper">
        <div class="section-heading"><div><p class="eyebrow">History</p><h2>Deployments</h2></div></div>
        ${deploymentsHtml}
      </section>
    </section>

    <section class="detail-columns">
      <section class="panel paper paper-sky">
        <div class="section-heading"><div><p class="eyebrow">Releases</p><h2>Rollback</h2></div></div>
        <p class="lede">Each Git deploy keeps up to five timestamped releases. Roll back by repointing <code>current</code> and recreating the container.</p>
        ${releasesHtml}
      </section>
      <section class="panel paper paper-peach">
        <div class="section-heading"><div><p class="eyebrow">Automation</p><h2>GitHub Webhook</h2></div></div>
        ${renderGithubWebhookInfo()}
      </section>
    </section>

    <script>
    (function () {
      var btn = document.getElementById("site-logs-refresh");
      var box = document.getElementById("site-logs-box");
      if (!btn || !box) return;
      btn.addEventListener("click", async function () {
        btn.disabled = true;
        try {
          var res = await fetch(box.dataset.endpoint, { headers: { Accept: "text/plain" } });
          box.textContent = await res.text();
        } catch (err) {
          // keep current content
        } finally {
          btn.disabled = false;
        }
      });
    })();
    </script>`;

  return renderAdminLayout(site.name || site.slug, `/admin/sites/${site.id}/detail`, content);
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
    : `<label>Runtime
          <select name="runtime" required>${runtimeSelectOptions(site.runtime)}</select>
          <small class="hint">Swaps the Dockerfile/compose template. Redeploy or recreate the site afterwards to rebuild the container with the new runtime.</small>
        </label>`;

  const name = isCreate ? "" : escapeHtml(site.name);
  const repo = isCreate ? "" : escapeHtml(site.repo_url);
  const branch = isCreate ? "main" : escapeHtml(site.branch);
  const repoSubdir = isCreate ? "" : escapeHtml(site.repo_subdir ?? "");
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
          <label>Repository subdirectory
            <input name="repo_subdir" placeholder="frontend (leave empty for repo root)" value="${repoSubdir}">
            <small class="hint">For monorepos: only this folder is built and deployed. Use the same repo URL on multiple sites with different subdirectories.</small>
          </label>
        </div>
        <label>Healthcheck path <input name="healthcheck_path" value="${health}" placeholder="/"></label>
        <label>Build command <input name="build_command" placeholder="npm run build" value="${build}"></label>
        <label>Start command <input name="start_command" placeholder="npm start" value="${start}"></label>
        <div class="actions">
          <button type="submit" class="button">${isCreate ? "Create site" : "Save changes"}</button>
          <a class="button button-soft" href="/admin/websites">Cancel</a>
        </div>
      </form>
      ${isCreate ? "" : `
      <section class="danger-zone">
        <div>
          <p class="eyebrow">Danger zone</p>
          <h3>Delete site</h3>
          <p class="lede">Stops the container, removes its Caddy route, deletes <code>${escapeHtml(site!.slug)}</code>'s on-disk directory (including persistent /data storage) and its database row. This cannot be undone.</p>
        </div>
        <form method="post" action="/admin/sites/${site!.id}/delete" onsubmit="return confirm('Permanently delete ${escapeHtml(site!.slug)}? This destroys its container, storage, and database row.');">
          <button type="submit" class="button button-danger">Delete site</button>
        </form>
      </section>`}
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

function renderDnsLogPanel() {
  const attempts = listDnsAttempts();
  return `<section class="panel paper paper-lavender">
    <div class="section-heading">
      <div>
        <p class="eyebrow">DNS automation</p>
        <h2>Recent A-record attempts</h2>
      </div>
      <button type="button" class="button button-soft" id="dns-log-refresh">Refresh</button>
    </div>
    <p class="dns-record-hint">Last ${attempts.length} attempts since the control-plane started. Failures keep the full API response so you can see what went wrong. Also written to container logs (<code>docker logs</code>).</p>
    <div id="dns-log-body">${renderDnsLogBody(attempts)}</div>
  </section>`;
}

function renderDnsLogBody(attempts: DnsAttempt[]) {
  if (attempts.length === 0) {
    return `<div class="mini-empty">No DNS attempts yet.</div>`;
  }
  return `<ul class="dns-log-list">${attempts
    .map((attempt) => renderDnsLogItem(attempt))
    .join("")}</ul>`;
}

function renderDnsLogItem(attempt: DnsAttempt) {
  const tone = attempt.ok ? "good" : "bad";
  const label = attempt.ok ? "OK" : "FAIL";
  const errorBlock = attempt.error
    ? `<details class="dns-log-error"><summary>Error detail</summary><pre>${escapeHtml(attempt.error)}</pre></details>`
    : "";
  return `<li class="dns-log-item">
    <div class="dns-log-head">
      <span class="status-pill ${tone}">${escapeHtml(label)}</span>
      <strong>${escapeHtml(attempt.hostname || "(no hostname)")}</strong>
      <span class="dns-log-provider">${escapeHtml(attempt.provider)}</span>
      <span class="dns-log-meta">${escapeHtml(attempt.ip ?? "—")} · TTL ${escapeHtml(attempt.ttl ?? "—")} · ${attempt.durationMs} ms</span>
      <time class="dns-log-time">${escapeHtml(formatDate(attempt.at))}</time>
    </div>
    ${errorBlock}
  </li>`;
}

function renderDnsCard(opts: {
  eyebrow: string;
  title: string;
  hint: string;
  domains: readonly string[];
  endpoint: string;
  tone: "mint" | "peach" | "lavender" | "sky" | "rose";
}) {
  const rows = opts.domains
    .map(
      (domain) => `<form class="dns-record-form" data-domain="${escapeHtml(domain)}" data-endpoint="${escapeHtml(opts.endpoint)}">
        <div class="dns-record-row">
          <input name="subdomain" placeholder="app" pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*" required>
          <span class="dns-record-suffix">.${escapeHtml(domain)}</span>
          <button class="button button-soft" type="submit">Create A</button>
        </div>
        <div class="dns-record-status" aria-live="polite"></div>
        <details class="dns-record-detail" hidden><summary>Error detail</summary><pre></pre></details>
      </form>`,
    )
    .join("");

  const body = opts.domains.length
    ? rows
    : `<div class="mini-empty">No domains assigned. Add one on the <a href="/admin/config">Config</a> page.</div>`;

  return `<section class="paper card paper-${opts.tone}">
    <p class="eyebrow">${escapeHtml(opts.eyebrow)}</p>
    <h2>${escapeHtml(opts.title)}</h2>
    <p class="dns-record-hint">${opts.hint}</p>
    ${body}
  </section>`;
}

function renderDnsAutomationScript() {
  return `<script>
  (function () {
    if (window.__dnsRecordFormsBound) return;
    window.__dnsRecordFormsBound = true;

    function setDetail(form, message) {
      var detail = form.querySelector(".dns-record-detail");
      if (!detail) return;
      var pre = detail.querySelector("pre");
      if (message) {
        pre.textContent = message;
        detail.hidden = false;
      } else {
        pre.textContent = "";
        detail.hidden = true;
        detail.open = false;
      }
    }

    async function refreshLogPanel() {
      var body = document.getElementById("dns-log-body");
      if (!body) return;
      try {
        var res = await fetch("/admin/dns/log.json", { headers: { Accept: "application/json" } });
        if (!res.ok) return;
        var data = await res.json();
        body.innerHTML = renderAttempts(data.attempts || []);
      } catch (err) {
        // ignore — panel just stays stale
      }
    }

    function renderAttempts(attempts) {
      if (!attempts.length) {
        return '<div class="mini-empty">No DNS attempts yet.</div>';
      }
      return '<ul class="dns-log-list">' + attempts.map(renderAttempt).join("") + '</ul>';
    }

    function escapeHtml(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function renderAttempt(a) {
      var tone = a.ok ? "good" : "bad";
      var label = a.ok ? "OK" : "FAIL";
      var when = a.at ? new Date(a.at).toLocaleString() : "";
      var detail = a.error
        ? '<details class="dns-log-error"><summary>Error detail</summary><pre>' + escapeHtml(a.error) + '</pre></details>'
        : '';
      return '<li class="dns-log-item">'
        + '<div class="dns-log-head">'
        + '<span class="status-pill ' + tone + '">' + label + '</span>'
        + '<strong>' + escapeHtml(a.hostname || "(no hostname)") + '</strong>'
        + '<span class="dns-log-provider">' + escapeHtml(a.provider) + '</span>'
        + '<span class="dns-log-meta">' + escapeHtml(a.ip || "—") + ' · TTL ' + escapeHtml(a.ttl || "—") + ' · ' + (a.durationMs || 0) + ' ms</span>'
        + '<time class="dns-log-time">' + escapeHtml(when) + '</time>'
        + '</div>'
        + detail
        + '</li>';
    }

    document.querySelectorAll(".dns-record-form").forEach(function (form) {
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        var domain = form.dataset.domain;
        var endpoint = form.dataset.endpoint;
        var input = form.querySelector('[name="subdomain"]');
        var subdomain = (input.value || "").trim();
        var status = form.querySelector(".dns-record-status");
        var button = form.querySelector("button");
        if (!subdomain) { return; }
        status.className = "dns-record-status pending";
        status.textContent = "Creating " + subdomain + "." + domain + "…";
        setDetail(form, "");
        button.disabled = true;
        try {
          var body = new URLSearchParams({ domain: domain, subdomain: subdomain });
          var res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body,
          });
          var data;
          var raw = await res.text();
          try { data = JSON.parse(raw); } catch (e) { data = { ok: false, error: raw }; }
          if (res.ok && data && data.ok) {
            status.className = "dns-record-status ok";
            status.textContent = "Created " + data.hostname + " → " + data.ip + " (TTL " + data.ttl + ")";
            input.value = "";
          } else {
            var message = (data && data.error) || ("HTTP " + res.status + " " + raw);
            status.className = "dns-record-status err";
            // Short summary in the status line; full text in <details>.
            var firstLine = String(message).split("\\n")[0];
            status.textContent = firstLine.length > 200 ? firstLine.slice(0, 200) + "…" : firstLine;
            setDetail(form, message);
          }
        } catch (err) {
          var message = (err && (err.stack || err.message)) || String(err);
          status.className = "dns-record-status err";
          status.textContent = (err && err.message) || String(err);
          setDetail(form, message);
        } finally {
          button.disabled = false;
          refreshLogPanel();
        }
      });
    });

    var refreshBtn = document.getElementById("dns-log-refresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", refreshLogPanel);
    }
  })();
  </script>`;
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
          ${deployment.commit_sha ? `<small><code>${escapeHtml(String(deployment.commit_sha).slice(0, 7))}</code></small>` : ""}
          ${deployment.trigger ? `<small class="muted">${escapeHtml(deployment.trigger)}</small>` : ""}
        </div>
        <span class="status-pill ${statusTone(deployment.status)}">${escapeHtml(deployment.status)}</span>
        <div class="deployment-actions">
          <small>${escapeHtml(deployment.finished_at ? `Finished ${formatDate(deployment.finished_at)}` : "Still running")}${deployment.health_status ? ` · health ${escapeHtml(deployment.health_status)}` : ""}</small>
          <a class="button button-link" href="/admin/deployments/${deployment.id}/logs">Deployment Logs</a>
        </div>
      </article>`,
    )
    .join("")}</div>`;
}

function renderBackupsPage(backup: Awaited<ReturnType<typeof getBackupStatus>>) {
  const filesHtml = backup.files.length
    ? `<ul class="stack-list">${backup.files
        .map(
          (file) => `<li>
            <span><code>${escapeHtml(file.name)}</code></span>
            <small>${escapeHtml(formatBytes(file.size))} · ${escapeHtml(formatDate(file.modifiedAt))}</small>
          </li>`,
        )
        .join("")}</ul>`
    : `<div class="mini-empty">No backup files found in <code>${escapeHtml(backup.backupDir)}</code>.</div>`;

  const content = `
    <section class="panel paper paper-sky">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Disaster recovery</p>
          <h2>Backup Status</h2>
        </div>
      </div>
      <p class="lede">Read-only view of VPS-side Postgres dumps and backup log output. Full snapshots from your Windows host still live under <code>_BACKUP/</code>.</p>
      <div class="detail-grid">
        <div class="detail-cell"><span class="detail-label">Backup directory</span><div class="detail-value"><code>${escapeHtml(backup.backupDir)}</code></div></div>
        <div class="detail-cell"><span class="detail-label">Latest Postgres dump</span><div class="detail-value">${backup.latestPostgres ? `<code>${escapeHtml(backup.latestPostgres.name)}</code>` : `<span class="muted">none</span>`}</div></div>
        <div class="detail-cell"><span class="detail-label">Freshness</span><div class="detail-value"><span class="status-pill ${backup.stale ? "warn" : "good"}">${backup.stale ? "stale or missing" : "recent"}</span></div></div>
      </div>
    </section>

    <section class="detail-columns">
      <section class="panel paper">
        <div class="section-heading"><div><p class="eyebrow">On-server files</p><h2>Available Backups</h2></div></div>
        ${filesHtml}
      </section>
      <section class="panel paper paper-lavender">
        <div class="section-heading"><div><p class="eyebrow">Cron output</p><h2>Backup Log</h2></div></div>
        <pre class="logbox">${escapeHtml(backup.backupLogTail || "No backup log yet.")}</pre>
      </section>
    </section>

    <section class="panel paper paper-peach">
      <div class="section-heading"><div><p class="eyebrow">Manual restore</p><h2>Restore Guidance</h2></div></div>
      <ol class="restore-steps">
        <li>Postgres: open an SSH tunnel, then restore the latest <code>postgres-*.sql.gz</code> with <code>pg_restore</code> or <code>psql</code>.</li>
        <li>Site volumes: extract each site's <code>shared/</code> tarball back under <code>/srv/hosting/sites/&lt;slug&gt;/</code>.</li>
        <li>Deployed code: restore <code>sites-code.tar.gz</code> and <code>caddy.tar.gz</code> from a local <code>_BACKUP/&lt;stamp&gt;/</code> folder, then reload Caddy.</li>
      </ol>
      <p class="lede">See <code>docs/backup.md</code> for exact commands. Destructive restore actions are intentionally not exposed in the admin UI.</p>
    </section>`;

  return renderAdminLayout("Backups", "/admin/backups", content);
}

function renderObservabilityPage(summary: Awaited<ReturnType<typeof getObservabilitySummary>>) {
  const unhealthyHtml = summary.unhealthySites.length
    ? `<ul class="stack-list">${summary.unhealthySites
        .map(
          (site) => `<li>
            <span><strong>${escapeHtml(site.slug)}</strong> ${renderHealthBadge(site)}</span>
            <small>${escapeHtml(site.last_health_error ?? "No error detail")}</small>
          </li>`,
        )
        .join("")}</ul>`
    : `<div class="mini-empty">All checked sites are healthy.</div>`;

  const failedDeployHtml = summary.recentFailedDeployments.length
    ? `<ul class="stack-list">${summary.recentFailedDeployments
        .map(
          (deployment) => `<li>
            <span><strong>${escapeHtml(deployment.slug)}</strong> <span class="status-pill ${statusTone(deployment.status)}">${escapeHtml(deployment.status)}</span></span>
            <small>${escapeHtml(formatDate(deployment.started_at))}</small>
          </li>`,
        )
        .join("")}</ul>`
    : `<div class="mini-empty">No recent failed deployments.</div>`;

  const runtimeHtml = summary.runtimeStats.length
    ? `<ul class="stack-list">${summary.runtimeStats
        .map(
          (stat) => `<li>
            <span><strong>${escapeHtml(stat.slug)}</strong> <span class="status-pill ${stat.running ? "good" : "bad"}">${stat.running ? "running" : "stopped"}</span></span>
            <small>${stat.running ? `CPU ${escapeHtml(stat.cpuPercent ?? "—")} · RAM ${escapeHtml(stat.memoryUsage ?? "—")} (${escapeHtml(stat.memoryPercent ?? "—")})` : "Container not running"}</small>
          </li>`,
        )
        .join("")}</ul>`
    : `<div class="mini-empty">No runtime stats available.</div>`;

  const trafficHtml = Object.keys(summary.visitTotals).length
    ? `<ul class="stack-list">${Object.entries(summary.visitTotals)
        .map(
          ([slug, count]) => `<li><span><strong>${escapeHtml(slug)}</strong></span><small>${count} visits in last 10 weeks</small></li>`,
        )
        .join("")}</ul>`
    : `<div class="mini-empty">No traffic data yet.</div>`;

  const content = `
    <section class="stats-grid" aria-label="Observability summary">
      ${renderStatCard("Unhealthy sites", summary.unhealthySites.length, "Failed latest health check", "rose")}
      ${renderStatCard("Failed deploys", summary.recentFailedDeployments.length, "Recent deploy/rollback issues", "peach")}
      ${renderStatCard("Backup freshness", summary.backup.stale ? "Stale" : "OK", summary.backup.latestPostgres?.name ?? "No dump found", "sky")}
      ${renderStatCard("Alert webhook", config.ALERT_WEBHOOK_URL ? "Configured" : "Off", config.ALERT_WEBHOOK_URL ? "Outbound alerts enabled" : "Set ALERT_WEBHOOK_URL to enable", "lavender")}
    </section>

    <section class="detail-columns">
      <section class="panel paper paper-rose">
        <div class="section-heading"><div><p class="eyebrow">Health</p><h2>Unhealthy Sites</h2></div></div>
        ${unhealthyHtml}
      </section>
      <section class="panel paper">
        <div class="section-heading"><div><p class="eyebrow">Deploys</p><h2>Recent Failures</h2></div></div>
        ${failedDeployHtml}
      </section>
    </section>

    <section class="detail-columns">
      <section class="panel paper paper-mint">
        <div class="section-heading"><div><p class="eyebrow">Containers</p><h2>Runtime Usage</h2></div></div>
        ${runtimeHtml}
      </section>
      <section class="panel paper paper-lavender">
        <div class="section-heading"><div><p class="eyebrow">Traffic</p><h2>Recent Visits</h2></div></div>
        ${trafficHtml}
      </section>
    </section>`;

  return renderAdminLayout("Observability", "/admin/observability", content);
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
    .site-list { display: grid; gap: .85rem; }
    .site-row { padding: 1rem 1.15rem; }
    .muted { color: var(--muted); }
    .site-row-top { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .site-row-id { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
    .site-row-id h3 { margin: 0; font-size: 1.35rem; letter-spacing: -.04em; }
    .site-visits { display: flex; align-items: center; gap: .55rem; }
    .visits-chart { display: block; overflow: visible; }
    .visits-chart rect { fill: var(--ink); }
    .site-visits-meta { color: var(--muted); font-size: .76rem; white-space: nowrap; }
    .site-visits-meta strong { color: var(--ink); }
    .site-meta-line { display: flex; flex-wrap: wrap; gap: .35rem 1.5rem; margin: .7rem 0 .15rem; font-size: .88rem; }
    .site-meta-item { overflow-wrap: anywhere; }
    .site-meta-item .detail-label { display: inline; margin-right: .3rem; }
    .site-meta-item a { text-decoration: underline; text-decoration-color: rgba(38, 50, 56, 0.3); text-underline-offset: 2px; }
    .site-meta-item a:hover { text-decoration-color: var(--ink); }
    .site-domain-add { margin: .35rem 0 .75rem; }
    .site-domain-add > summary { cursor: pointer; color: var(--muted); font-size: .8rem; font-weight: 800; width: max-content; }
    .site-domain-add[open] > summary { margin-bottom: .5rem; }
    .action-bar { display: flex; flex-wrap: wrap; gap: .5rem .9rem; border-top: 2px dashed rgba(38, 50, 56, 0.15); padding-top: .8rem; }
    .action-group { display: grid; gap: .3rem; }
    .action-group-label { font-size: .65rem; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
    .action-group-buttons { display: flex; flex-wrap: wrap; gap: .35rem; }
    .action-group-buttons form { margin: 0; }
    .action-group-buttons .button { min-height: 2.1rem; padding: .35rem .7rem; font-size: .8rem; box-shadow: 2px 3px 0 rgba(38, 50, 56, .15); }
    .action-group-danger { margin-left: auto; }
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
    .status-dot { border: 2px solid var(--line); border-radius: 999px; display: inline-block; flex: 0 0 auto; height: 14px; width: 14px; }
    .status-dot.good { background: #5fd08a; }
    .status-dot.warn { background: #ffce5c; }
    .status-dot.bad { background: #ff7b9c; }
    .status-dot.neutral { background: #9ec5ff; }

    /* Dashboard Sites list */
    .dash-site-list { display: grid; gap: .6rem; list-style: none; margin: 0; padding: 0; }
    .dash-site { align-items: center; background: rgba(255,255,255,.6); border: 2px solid rgba(38,50,56,.5); border-radius: 16px 14px 18px 13px; display: flex; flex-wrap: wrap; gap: .75rem 1rem; justify-content: space-between; padding: .7rem .9rem; }
    .dash-site-main { align-items: center; display: flex; gap: .65rem; min-width: 180px; }
    .dash-site-id { display: flex; flex-direction: column; line-height: 1.25; }
    .dash-site-id strong { font-size: 1.02rem; letter-spacing: -.02em; }
    .dash-site-mid { align-items: center; display: flex; flex: 1 1 auto; flex-wrap: wrap; gap: .55rem; justify-content: flex-end; }
    .dash-site-domain { font-weight: 700; overflow-wrap: anywhere; }
    .dash-site-actions { flex: 0 0 auto; }

    /* Site detail page */
    .detail-head-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
    .detail-columns { display: grid; gap: 1.1rem; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); margin-top: 1.1rem; }
    .detail-grid { display: grid; gap: .85rem 1.2rem; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
    .detail-cell { display: flex; flex-direction: column; gap: .3rem; min-width: 0; }
    .detail-cell code { background: rgba(38,50,56,.08); border-radius: 6px; overflow-wrap: anywhere; padding: 0 .3rem; }
    .detail-visits { align-items: center; display: flex; flex-wrap: wrap; gap: .6rem 1rem; margin-bottom: .4rem; }
    .logbox { background: #1f2933; border-radius: 14px; color: #f8fafc; font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; margin: 0; max-height: 460px; overflow: auto; padding: 1rem; white-space: pre-wrap; word-break: break-word; }
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
    .button-danger { background: #c0392b; color: #fffaf0; }
    .button-danger:hover { background: #962d22; }
    .danger-zone {
      margin-top: 2rem;
      padding: 1.25rem;
      border: 2px dashed #c0392b;
      border-radius: 22px 18px 24px 16px;
      background: rgba(255, 220, 220, 0.35);
      display: grid;
      gap: 1rem;
    }
    .danger-zone h3 { color: #962d22; margin-bottom: .3rem; }
    .danger-zone .eyebrow { color: #962d22; }
    .hint {
      display: block;
      margin-top: .35rem;
      color: var(--muted);
      font-weight: 500;
      font-size: .78rem;
      letter-spacing: normal;
      text-transform: none;
    }
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
    .log-filters { display: flex; flex-wrap: wrap; gap: .45rem; margin: 0 0 1.2rem; }
    .log-filter { background: rgba(255,255,255,.6); border: 2px solid rgba(38,50,56,.45); border-radius: 999px; color: var(--ink); font-size: .78rem; font-weight: 800; padding: .3rem .75rem; text-decoration: none; }
    .log-filter:hover { background: #fffaf0; }
    .log-filter.active { background: var(--ink); color: #fffaf0; }
    .log-list { display: grid; gap: .55rem; list-style: none; margin: 0; padding: 0; }
    .log-item { background: rgba(255,255,255,.62); border: 2px solid rgba(38,50,56,.5); border-radius: 16px 14px 18px 13px; padding: .7rem .85rem; }
    .log-head { align-items: center; display: flex; flex-wrap: wrap; gap: .55rem; }
    .log-cat { border: 2px solid var(--line); border-radius: 999px; font-size: .68rem; font-weight: 900; letter-spacing: .06em; padding: .15rem .5rem; text-transform: uppercase; }
    .log-cat-lavender { background: var(--lavender); }
    .log-cat-sky { background: var(--sky); }
    .log-cat-rose { background: var(--rose); }
    .log-cat-mint { background: var(--mint); }
    .log-cat-peach { background: var(--peach); }
    .log-action { font-size: 1rem; letter-spacing: -.02em; }
    .log-target { color: var(--muted); font-weight: 700; overflow-wrap: anywhere; }
    .log-time { color: var(--muted); font-size: .8rem; margin-left: auto; white-space: nowrap; }
    .log-detail { margin-top: .5rem; }
    .log-detail summary { color: var(--muted); cursor: pointer; font-size: .8rem; font-weight: 800; }
    .log-detail pre { background: #1f2933; border-radius: 12px; color: #f8fafc; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; margin: .5rem 0 0; max-height: 320px; overflow: auto; padding: .8rem; white-space: pre-wrap; }
    .dns-record-hint { color: var(--muted); font-size: .85rem; margin-bottom: .9rem; }
    .dns-record-hint code { background: rgba(38,50,56,.08); border-radius: 6px; padding: 0 .3rem; }
    .dns-record-form { display: grid; gap: .35rem; margin-bottom: .9rem; }
    .dns-record-row { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
    .dns-record-row input[name="subdomain"] { flex: 1 1 110px; min-height: 2.2rem; padding: .35rem .55rem; font-size: .85rem; }
    .dns-record-suffix { color: var(--muted); font-weight: 700; font-size: .85rem; }
    .dns-record-row .button { min-height: 2.2rem; padding: .35rem .7rem; font-size: .8rem; }
    .dns-record-status { font-size: .8rem; min-height: 1em; overflow-wrap: anywhere; }
    .dns-record-status.pending { color: var(--muted); }
    .dns-record-status.ok { color: #1e7a3a; font-weight: 700; }
    .dns-record-status.err { color: #962d22; font-weight: 700; }
    .dns-record-detail summary { cursor: pointer; color: #962d22; font-size: .75rem; font-weight: 700; }
    .dns-record-detail pre {
      background: #1f2933; color: #f8fafc; border-radius: 12px; margin: .35rem 0 0;
      padding: .6rem .75rem; max-height: 14rem; overflow: auto; white-space: pre-wrap; word-break: break-word;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
    }
    .dns-log-list { list-style: none; margin: 0; padding: 0; display: grid; gap: .55rem; }
    .dns-log-item { background: rgba(255, 255, 255, .58); border: 1px dashed rgba(38, 50, 56, .38); border-radius: 16px; padding: .65rem .8rem; }
    .dns-log-head { display: flex; flex-wrap: wrap; align-items: center; gap: .55rem; }
    .dns-log-head strong { font-weight: 800; }
    .dns-log-provider { background: var(--butter); border: 2px solid var(--line); border-radius: 999px; font-size: .68rem; font-weight: 900; letter-spacing: .08em; padding: .12rem .5rem; text-transform: uppercase; }
    .dns-log-meta { color: var(--muted); font-size: .8rem; }
    .dns-log-time { color: var(--muted); font-size: .75rem; margin-left: auto; }
    .dns-log-error summary { cursor: pointer; color: #962d22; font-size: .78rem; font-weight: 700; margin-top: .35rem; }
    .dns-log-error pre {
      background: #1f2933; color: #f8fafc; border-radius: 12px; margin: .35rem 0 0;
      padding: .6rem .75rem; max-height: 18rem; overflow: auto; white-space: pre-wrap; word-break: break-word;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
    }
    .config-add-form { grid-template-columns: 2fr 1fr auto; align-items: end; gap: .8rem; }
    .config-add-form .button { min-height: 2.85rem; }
    .config-provider-grid { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
    .config-domain-row { flex-direction: row !important; align-items: center; justify-content: space-between; gap: 1rem; }
    .config-domain-row form { margin: 0; }
    .config-domain-row .button { min-height: 2rem; padding: .3rem .7rem; font-size: .78rem; }
    @media (max-width: 640px) { .config-add-form { grid-template-columns: 1fr; } }
    .readonly-block { margin-bottom: 1.1rem; }
    .readonly-block .detail-value { font-weight: 800; }
    .readonly-block small { color: var(--muted); display: block; margin-top: .38rem; font-weight: 500; font-size: .82rem; letter-spacing: normal; text-transform: none; }
    .webhook-box { display: grid; gap: .65rem; }
    .restore-steps { color: var(--muted); margin: 0; padding-left: 1.2rem; display: grid; gap: .45rem; }
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

  if (["deployed", "succeeded", "success", "healthy", "rolled_back"].some((value) => normalized.includes(value))) {
    return "good";
  }

  if (["failed", "error", "down", "unhealthy", "rollback_unhealthy"].some((value) => normalized.includes(value))) {
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
        <label class="check-row"><input type="checkbox" name="remember" value="true"> Remember me on this device for 30 days</label>
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
  commit_sha?: string | null;
  release_id?: string | null;
  trigger?: string | null;
  health_status?: string | null;
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
        <p class="lede">Deployment #${escapeHtml(deployment.id)} started ${escapeHtml(formatDate(deployment.started_at))}.${deployment.commit_sha ? ` Commit <code>${escapeHtml(String(deployment.commit_sha).slice(0, 7))}</code>.` : ""}${deployment.release_id ? ` Release <code>${escapeHtml(deployment.release_id)}</code>.` : ""}</p>
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
