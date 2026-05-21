#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type ToolArgs = Record<string, unknown>;

const HELP = `Usage: someting <command> [options]

Inspection
  status                                  Platform overview (sites, domains, deployments, mail notes)
  site <slug>                             Show one site
  deployments <slug>                      List recent deployments for a site
  deploy-log <id>                         Full build output for a deployment id
  logs <slug> [--tail N]                  Runtime container logs (default 250)
  env <slug>                              Read site .env

Lifecycle
  create <slug> --name N --runtime R --repo URL [--branch B] [--build CMD] [--start CMD] [--health PATH]
  update <slug> [--name N] [--repo URL] [--branch B] [--build CMD] [--start CMD] [--health PATH]
  deploy <slug>                           Pull repo, build, restart
  recreate <slug>                         Recreate container without rebuilding image (picks up .env)
  restart <slug>                          Restart container (does not pick up .env changes)
  exec <slug> -- <cmd...>                 Run a one-shot shell command inside the site container
  env:set <slug> --file PATH              Replace site .env from a local file

Routing
  domain <slug-or-id> <hostname> [--primary]   Attach a domain to a site
  route <slug>                                  Generate host-based Caddy route and reload
  path-route <slug>                             Serve site under /sites/<slug>/

Deploy credentials (private repos)
  auth <slug>                                          Show configured deploy auth (secrets included)
  auth:clear <slug>                                    Remove deploy credentials
  auth:token <slug> --token T [--username U]           Set HTTPS token auth
  auth:ssh <slug> --key-file PATH                      Set SSH private-key auth

Other
  mail <domain> <mode> [--provider P] [--notes N]      Record mail strategy

Connection (defaults read from .mcp.json in the working directory)
  --url URL          Override MCP HTTP endpoint
  --auth HEADER      Override Authorization header value
  --json             Print raw tool result as JSON
`;

async function loadDefaultsFromMcpJson() {
  try {
    const raw = await readFile(".mcp.json", "utf8");
    const parsed = JSON.parse(raw);
    const entry = parsed?.mcpServers?.["someting-hosting"];
    if (!entry) return { url: undefined, auth: undefined };
    return {
      url: entry.url as string | undefined,
      auth: entry.headers?.Authorization as string | undefined,
    };
  } catch {
    return { url: undefined, auth: undefined };
  }
}

async function connect(url: string, auth: string | undefined) {
  const headers: Record<string, string> = {};
  if (auth) headers.Authorization = auth;

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
  const client = new Client({ name: "someting-cli", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function callTool(client: Client, name: string, args: ToolArgs, asJson: boolean) {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content.map((c) => c.text ?? "").join("\n");

  if (asJson) {
    try {
      const parsed = JSON.parse(text);
      process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
      return;
    } catch {
      process.stdout.write(`${text}\n`);
      return;
    }
  }
  process.stdout.write(`${text}\n`);
}

function requireFlag(values: Record<string, unknown>, key: string, hint: string): string {
  const value = values[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required --${key} (${hint})`);
  }
  return value;
}

function optionalFlag(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      url: { type: "string" },
      auth: { type: "string" },
      json: { type: "boolean" },
      name: { type: "string" },
      runtime: { type: "string" },
      repo: { type: "string" },
      branch: { type: "string" },
      build: { type: "string" },
      start: { type: "string" },
      health: { type: "string" },
      tail: { type: "string" },
      file: { type: "string" },
      "key-file": { type: "string" },
      primary: { type: "boolean" },
      token: { type: "string" },
      username: { type: "string" },
      provider: { type: "string" },
      notes: { type: "string" },
    },
  });

  const [command, ...rest] = positionals;
  const defaults = await loadDefaultsFromMcpJson();
  const url = (values.url as string | undefined) ?? process.env.SOMETING_MCP_URL ?? defaults.url;
  const auth = (values.auth as string | undefined) ?? process.env.SOMETING_MCP_AUTH ?? defaults.auth;

  if (!url) {
    throw new Error("No MCP URL configured. Set --url, SOMETING_MCP_URL, or .mcp.json.");
  }

  const client = await connect(url, auth);
  const asJson = Boolean(values.json);

  try {
    await dispatch(client, command, rest, values as Record<string, unknown>, asJson);
  } finally {
    await client.close();
  }
}

async function dispatch(
  client: Client,
  command: string | undefined,
  rest: string[],
  values: Record<string, unknown>,
  asJson: boolean,
) {
  switch (command) {
    case "status":
      return callTool(client, "platform_status", {}, asJson);

    case "site": {
      const slug = rest[0] ?? throwUsage("site <slug>");
      return callTool(client, "get_site", { slug }, asJson);
    }

    case "create": {
      const slug = rest[0] ?? throwUsage("create <slug> --name N --runtime R --repo URL");
      const args: ToolArgs = {
        slug,
        name: requireFlag(values, "name", "display name"),
        runtime: requireFlag(values, "runtime", "php|node|python|static|html"),
        repo_url: requireFlag(values, "repo", "https://... or upload://..."),
        branch: optionalFlag(values, "branch") ?? "main",
        healthcheck_path: optionalFlag(values, "health") ?? "/",
      };
      const build = optionalFlag(values, "build");
      const start = optionalFlag(values, "start");
      if (build) args.build_command = build;
      if (start) args.start_command = start;
      return callTool(client, "create_site", args, asJson);
    }

    case "update": {
      const slug = rest[0] ?? throwUsage("update <slug> [flags]");
      const args: ToolArgs = { slug };
      const passthrough: Array<[string, string]> = [
        ["name", "name"],
        ["repo", "repo_url"],
        ["branch", "branch"],
        ["build", "build_command"],
        ["start", "start_command"],
        ["health", "healthcheck_path"],
      ];
      for (const [flag, key] of passthrough) {
        const value = optionalFlag(values, flag);
        if (value !== undefined) args[key] = value;
      }
      if (Object.keys(args).length === 1) {
        throw new Error("update needs at least one of --name --repo --branch --build --start --health");
      }
      return callTool(client, "update_site", args, asJson);
    }

    case "deploy": {
      const slug = rest[0] ?? throwUsage("deploy <slug>");
      return callTool(client, "deploy_site", { slug }, asJson);
    }

    case "recreate": {
      const slug = rest[0] ?? throwUsage("recreate <slug>");
      return callTool(client, "recreate_site", { slug }, asJson);
    }

    case "restart": {
      const slug = rest[0] ?? throwUsage("restart <slug>");
      return callTool(client, "restart_site", { slug }, asJson);
    }

    case "exec": {
      const slug = rest[0] ?? throwUsage("exec <slug> -- <command...>");
      const command = rest.slice(1).join(" ").trim();
      if (!command) throwUsage("exec <slug> -- <command...>");
      return callTool(client, "exec_in_site", { slug, command }, asJson);
    }

    case "deployments": {
      const slug = rest[0] ?? throwUsage("deployments <slug>");
      return callTool(client, "list_deployments", { slug }, asJson);
    }

    case "deploy-log": {
      const id = rest[0] ?? throwUsage("deploy-log <id>");
      return callTool(client, "get_deployment_log", { deployment_id: id }, asJson);
    }

    case "logs": {
      const slug = rest[0] ?? throwUsage("logs <slug> [--tail N]");
      const tail = optionalFlag(values, "tail");
      const args: ToolArgs = { slug };
      if (tail) args.tail = Number(tail);
      return callTool(client, "get_site_logs", args, asJson);
    }

    case "env": {
      const slug = rest[0] ?? throwUsage("env <slug>");
      return callTool(client, "read_site_env", { slug }, asJson);
    }

    case "env:set": {
      const slug = rest[0] ?? throwUsage("env:set <slug> --file PATH");
      const file = requireFlag(values, "file", "path to local .env to upload");
      const contents = await readFile(file, "utf8");
      return callTool(client, "write_site_env", { slug, contents }, asJson);
    }

    case "domain": {
      const siteRef = rest[0] ?? throwUsage("domain <slug-or-id> <hostname>");
      const hostname = rest[1] ?? throwUsage("domain <slug-or-id> <hostname>");
      const siteId = /^\d+$/.test(siteRef)
        ? Number(siteRef)
        : Number((await fetchSite(client, siteRef)).id);
      return callTool(
        client,
        "add_domain",
        { site_id: siteId, hostname, is_primary: Boolean(values.primary) },
        asJson,
      );
    }

    case "route": {
      const slug = rest[0] ?? throwUsage("route <slug>");
      return callTool(client, "apply_route", { slug }, asJson);
    }

    case "path-route": {
      const slug = rest[0] ?? throwUsage("path-route <slug>");
      return callTool(client, "apply_path_route", { slug }, asJson);
    }

    case "auth": {
      const slug = rest[0] ?? throwUsage("auth <slug>");
      return callTool(client, "read_deploy_auth", { slug }, asJson);
    }

    case "auth:clear": {
      const slug = rest[0] ?? throwUsage("auth:clear <slug>");
      return callTool(client, "write_deploy_auth", { slug, mode: "none" }, asJson);
    }

    case "auth:token": {
      const slug = rest[0] ?? throwUsage("auth:token <slug> --token T [--username U]");
      const token = requireFlag(values, "token", "GitHub/Gitlab access token");
      const username = optionalFlag(values, "username") ?? "x-access-token";
      return callTool(
        client,
        "write_deploy_auth",
        { slug, mode: "https-token", token, username },
        asJson,
      );
    }

    case "auth:ssh": {
      const slug = rest[0] ?? throwUsage("auth:ssh <slug> --key-file PATH");
      const keyFile = requireFlag(values, "key-file", "path to OpenSSH private key");
      const privateKey = await readFile(keyFile, "utf8");
      return callTool(
        client,
        "write_deploy_auth",
        { slug, mode: "ssh-key", private_key: privateKey },
        asJson,
      );
    }

    case "mail": {
      const domain = rest[0] ?? throwUsage("mail <domain> <mode>");
      const mode = rest[1] ?? throwUsage("mail <domain> <mode>");
      const args: ToolArgs = { domain, mode };
      const provider = optionalFlag(values, "provider");
      const notes = optionalFlag(values, "notes");
      if (provider) args.provider = provider;
      if (notes) args.notes = notes;
      return callTool(client, "add_mail_note", args, asJson);
    }

    default:
      throw new Error(`Unknown command: ${command ?? "(none)"}. Run 'someting help' for usage.`);
  }
}

async function fetchSite(client: Client, slug: string): Promise<{ id: string }> {
  const result = await client.callTool({ name: "get_site", arguments: { slug } });
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content.map((c) => c.text ?? "").join("\n");
  return JSON.parse(text);
}

function throwUsage(usage: string): never {
  throw new Error(`Usage: someting ${usage}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
