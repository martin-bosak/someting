import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addDomain,
  addMailNote,
  applyPathRouteBySlug,
  applyRouteBySlug,
  changeSiteRuntime,
  createSite,
  provisionDatabase,
  deleteSiteBySlug,
  deleteSiteStorageEntry,
  deploySiteBySlug,
  execInSiteBySlug,
  getDeploymentLogById,
  getSiteBySlug,
  getSiteLogsBySlug,
  listDeploymentLogsForSite,
  listPlatformState,
  listSiteStorage,
  readDeployAuthBySlug,
  readSiteEnvBySlug,
  readSiteStorageFile,
  recreateSiteBySlug,
  restartSiteBySlug,
  updateSiteMetadata,
  writeDeployAuthBySlug,
  writeSiteEnvBySlug,
  writeSiteStorageFile,
} from "./platform.js";

export function createMcpServer() {
  const server = new McpServer({
    name: "someting-hosting",
    version: "0.1.0",
  });

  server.registerTool(
    "platform_status",
    {
      title: "Get platform status",
      description: "List configured sites, domains, recent deployments, and mail notes.",
    },
    async () => text(await listPlatformState()),
  );

  server.registerTool(
    "create_site",
    {
      title: "Create site",
      description: "Provision a site folder from a runtime template and register it in the platform database.",
      inputSchema: {
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/),
        name: z.string().min(1),
        runtime: z.enum(["php", "node", "python", "static", "html"]),
        repo_url: z.string().regex(/^(https:\/\/|git@|ssh:\/\/|upload:\/\/).+/),
        branch: z.string().min(1).default("main"),
        repo_subdir: z.string().default(""),
        build_command: z.string().optional(),
        start_command: z.string().optional(),
        healthcheck_path: z.string().startsWith("/").default("/"),
      },
    },
    async (input) => text(await createSite(input)),
  );

  server.registerTool(
    "add_domain",
    {
      title: "Add domain",
      description: "Attach a hostname to an existing site. Run apply_route afterwards to update Caddy.",
      inputSchema: {
        site_id: z.coerce.number().int().positive(),
        hostname: z.string().toLowerCase(),
        is_primary: z.boolean().default(false),
      },
    },
    async (input) => text(await addDomain(input)),
  );

  server.registerTool(
    "deploy_site",
    {
      title: "Deploy site",
      description: "Pull the configured Git repository, build the site container, and restart it.",
      inputSchema: {
        slug: z.string().min(1),
      },
      annotations: {
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ slug }) => text(await deploySiteBySlug(slug)),
  );

  server.registerTool(
    "apply_route",
    {
      title: "Apply route",
      description: "Generate the Caddy route for a site and reload Caddy.",
      inputSchema: {
        slug: z.string().min(1),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ slug }) => text(await applyRouteBySlug(slug)),
  );

  server.registerTool(
    "get_site_logs",
    {
      title: "Get site logs",
      description: "Return recent Docker logs for a hosted site container.",
      inputSchema: {
        slug: z.string().min(1),
        tail: z.number().int().positive().max(1000).default(250),
      },
    },
    async ({ slug, tail }) => text(await getSiteLogsBySlug(slug, tail)),
  );

  server.registerTool(
    "read_site_env",
    {
      title: "Read site env",
      description: "Read the runtime .env file for a hosted site. Treat returned values as secrets.",
      inputSchema: {
        slug: z.string().min(1),
      },
    },
    async ({ slug }) => text(await readSiteEnvBySlug(slug)),
  );

  server.registerTool(
    "write_site_env",
    {
      title: "Write site env",
      description: "Replace the runtime .env file for a hosted site.",
      inputSchema: {
        slug: z.string().min(1),
        contents: z.string(),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ slug, contents }) => text(await writeSiteEnvBySlug(slug, contents)),
  );

  server.registerTool(
    "get_site",
    {
      title: "Get site",
      description: "Fetch a single site's metadata by slug.",
      inputSchema: {
        slug: z.string().min(1),
      },
    },
    async ({ slug }) => text(await getSiteBySlug(slug)),
  );

  server.registerTool(
    "update_site",
    {
      title: "Update site",
      description:
        "Update editable site metadata: name, repo_url, branch, repo_subdir, build_command, start_command, healthcheck_path, and optionally runtime. Slug is fixed after provision. Changing runtime swaps the Dockerfile/compose template — run deploy_site or recreate_site afterwards.",
      inputSchema: {
        slug: z.string().min(1),
        name: z.string().min(1),
        runtime: z.enum(["php", "node", "python", "static", "html"]).optional(),
        repo_url: z.string().regex(/^(https:\/\/|git@|ssh:\/\/|upload:\/\/).+/),
        branch: z.string().min(1),
        repo_subdir: z.string().default(""),
        build_command: z.string().optional().nullable(),
        start_command: z.string().optional().nullable(),
        healthcheck_path: z.string().startsWith("/").default("/"),
      },
    },
    async ({ slug, ...rest }) => {
      const site = await getSiteBySlug(slug);
      return text(await updateSiteMetadata(Number(site.id), rest));
    },
  );

  server.registerTool(
    "change_runtime",
    {
      title: "Change site runtime",
      description:
        "Swap a site's runtime template (Dockerfile + compose.yaml) to html, static, node, python, or php and update the DB row. Does not rebuild the container — run deploy_site (rebuild) or recreate_site (no rebuild) afterwards.",
      inputSchema: {
        slug: z.string().min(1),
        runtime: z.enum(["php", "node", "python", "static", "html"]),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ slug, runtime }) => text(await changeSiteRuntime(slug, runtime)),
  );

  server.registerTool(
    "delete_site",
    {
      title: "Delete site",
      description:
        "Permanently delete a site: stops and removes its container, drops its Caddy route files and reloads Caddy, removes the on-disk site directory (including persistent /data storage), and deletes the DB row (cascades domains and deployments). Irreversible.",
      inputSchema: {
        slug: z.string().min(1),
      },
      annotations: {
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ slug }) => text(await deleteSiteBySlug(slug)),
  );

  server.registerTool(
    "list_deployments",
    {
      title: "List deployments",
      description: "List the 20 most recent deployments for a site, with status and build output.",
      inputSchema: {
        slug: z.string().min(1),
      },
    },
    async ({ slug }) => text(await listDeploymentLogsForSite(slug)),
  );

  server.registerTool(
    "get_deployment_log",
    {
      title: "Get deployment log",
      description:
        "Fetch the full build/deploy output for a specific deployment by id. Use this to debug failed deploys — distinct from get_site_logs which returns runtime container logs.",
      inputSchema: {
        deployment_id: z.coerce.number().int().positive(),
      },
    },
    async ({ deployment_id }) => text(await getDeploymentLogById(deployment_id)),
  );

  server.registerTool(
    "apply_path_route",
    {
      title: "Apply path route",
      description:
        "Generate a Caddy path route that serves the site under /sites/<slug>/ on the main host, and reload Caddy. Use when the site has no dedicated domain.",
      inputSchema: {
        slug: z.string().min(1),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ slug }) => text(await applyPathRouteBySlug(slug)),
  );

  server.registerTool(
    "read_deploy_auth",
    {
      title: "Read deploy auth",
      description:
        "Read Git deploy credentials configured for a site (https-token, ssh-key, or none). Treat returned token/private_key as secrets.",
      inputSchema: {
        slug: z.string().min(1),
      },
    },
    async ({ slug }) => text(await readDeployAuthBySlug(slug)),
  );

  server.registerTool(
    "write_deploy_auth",
    {
      title: "Write deploy auth",
      description:
        "Set Git deploy credentials for a site. mode=none clears credentials; mode=https-token requires token (and optional username); mode=ssh-key requires private_key.",
      inputSchema: {
        slug: z.string().min(1),
        mode: z.enum(["none", "https-token", "ssh-key"]),
        username: z.string().optional(),
        token: z.string().optional(),
        private_key: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ slug, ...rest }) => text(await writeDeployAuthBySlug(slug, rest)),
  );

  server.registerTool(
    "restart_site",
    {
      title: "Restart site",
      description: "Restart the running site container (same image, kicks the process). Does NOT pick up .env changes.",
      inputSchema: {
        slug: z.string().min(1),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ slug }) => text(await restartSiteBySlug(slug)),
  );

  server.registerTool(
    "recreate_site",
    {
      title: "Recreate site",
      description: "Recreate the site container without rebuilding the image. Picks up .env changes. Faster than deploy_site.",
      inputSchema: {
        slug: z.string().min(1),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ slug }) => text(await recreateSiteBySlug(slug)),
  );

  server.registerTool(
    "exec_in_site",
    {
      title: "Exec in site container",
      description: "Run a one-shot shell command inside a running site container and return stdout/stderr. Non-interactive (no PTY), 60s timeout.",
      inputSchema: {
        slug: z.string().min(1),
        command: z.string().min(1),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ slug, command }) => text(await execInSiteBySlug(slug, command)),
  );

  server.registerTool(
    "list_site_storage",
    {
      title: "List site storage",
      description:
        "List entries in a site's persistent storage directory (the ./shared dir, mounted at /data inside the site container). Data here survives redeploys.",
      inputSchema: {
        slug: z.string().min(1),
        path: z.string().default("").describe("Subdirectory relative to the storage root; empty for the root."),
      },
    },
    async ({ slug, path }) => text(await listSiteStorage(slug, path)),
  );

  server.registerTool(
    "read_site_file",
    {
      title: "Read site storage file",
      description:
        "Read a UTF-8 text file from a site's persistent storage (/data). Max 1 MB. Path is relative to the storage root.",
      inputSchema: {
        slug: z.string().min(1),
        path: z.string().min(1),
      },
    },
    async ({ slug, path }) => text(await readSiteStorageFile(slug, path)),
  );

  server.registerTool(
    "write_site_file",
    {
      title: "Write site storage file",
      description:
        "Create or overwrite a text file in a site's persistent storage (/data). Parent directories are created automatically. Path is relative to the storage root.",
      inputSchema: {
        slug: z.string().min(1),
        path: z.string().min(1),
        contents: z.string(),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ slug, path, contents }) => text(await writeSiteStorageFile(slug, path, contents)),
  );

  server.registerTool(
    "delete_site_file",
    {
      title: "Delete site storage entry",
      description:
        "Delete a file or directory (recursively) from a site's persistent storage (/data). Path is relative to the storage root.",
      inputSchema: {
        slug: z.string().min(1),
        path: z.string().min(1),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ slug, path }) => text(await deleteSiteStorageEntry(slug, path)),
  );

  server.registerTool(
    "provision_database",
    {
      title: "Provision database",
      description:
        "Create a new Postgres database and an owning login role in the shared cluster, intended for a hosted site. Returns the credentials and a connection string (host=postgres on the hosting Docker network). Treat the returned password as a secret. If password is omitted a random one is generated.",
      inputSchema: {
        name: z
          .string()
          .regex(/^[a-z][a-z0-9_]{1,62}$/)
          .describe(
            "Used as both the database name and the role name. Lowercase letters, digits, underscores; must start with a letter; 2-63 chars.",
          ),
        password: z.string().min(8).optional(),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async (input) => text(await provisionDatabase(input)),
  );

  server.registerTool(
    "add_mail_note",
    {
      title: "Add mail note",
      description: "Record the mail strategy for a domain: external, forwarding, SMTP relay, or self-hosted.",
      inputSchema: {
        domain: z.string().min(1),
        mode: z.enum(["external", "forwarding", "smtp-relay", "self-hosted"]),
        provider: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    async (input) => text(await addMailNote(input)),
  );

  return server;
}

function text(value: unknown) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);

  return {
    content: [
      {
        type: "text" as const,
        text: serialized,
      },
    ],
  };
}
