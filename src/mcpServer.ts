import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addDomain,
  addMailNote,
  applyRouteBySlug,
  createSite,
  deploySiteBySlug,
  getSiteLogsBySlug,
  listPlatformState,
  readSiteEnvBySlug,
  writeSiteEnvBySlug,
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
