# MCP Connectivity

Someting includes MCP access so an agent can manage the hosting platform without using the web UI.

There are two supported transports:

- External Streamable HTTP at `/mcp`, protected by HTTP Basic Auth.
- Stdio over SSH for clients that do not support authenticated remote HTTP MCP yet.

## Available Tools

- `platform_status`: list sites, domains, recent deployments, and mail notes.
- `create_site`: provision a site folder from a runtime template and register it.
- `add_domain`: attach a hostname to a site.
- `deploy_site`: pull, build, and restart a site.
- `apply_route`: generate the Caddy route and reload Caddy.
- `get_site_logs`: read recent Docker logs for a hosted site.
- `read_site_env`: read a site's runtime `.env` file.
- `write_site_env`: replace a site's runtime `.env` file.
- `add_mail_note`: record mail handling for a domain.
- `list_site_releases`: list retained release directories for rollback.
- `rollback_site`: repoint a site to a previous release and recreate its container.
- `check_site_health`: probe a site over its configured healthcheck path.
- `get_backup_status`: list on-server backup files and backup log tail.
- `get_observability_summary`: aggregate health, deploy failures, runtime stats, and traffic.

Many additional tools also exist for storage, deploy auth, database provisioning, site deletion, and metadata updates. Run `platform_status` or inspect `src/mcpServer.ts` for the full surface.

## External HTTP MCP

The VPS exposes:

```text
http://95.217.223.133/mcp
```

Authenticate with HTTP Basic Auth:

- Username: `ADMIN_USERNAME` from `/opt/someting/.env`
- Password: `ADMIN_PASSWORD` from `/opt/someting/.env`

Example request:

```bash
curl -u admin:<password> \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  http://95.217.223.133/mcp \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.1"}}}'
```

For MCP clients that support remote Streamable HTTP, use URL `http://95.217.223.133/mcp` and configure Basic Auth with the admin username and password.

## SSH Stdio MCP Config

Add a server like this to your MCP configuration:

```json
{
  "mcpServers": {
    "someting-hosting": {
      "command": "ssh",
      "args": [
        "-i",
        "C:\\Users\\marti\\.ssh\\allio_hetzner",
        "root@95.217.223.133",
        "cd /opt/someting && docker compose exec -T control-plane node dist/mcp.js"
      ]
    }
  }
}
```

On this machine, the same command is available as:

```bat
deploy\someting-mcp.cmd
```

## Local Development

Build first:

```bash
npm run build
```

Then run the MCP server with environment variables that point at a reachable PostgreSQL instance:

```bash
npm run mcp
```

## Security Notes

The external MCP endpoint can deploy code, edit env files, read logs, and reload routing. Basic Auth over plain HTTP is acceptable only for initial testing. Before regular use, point a domain at the VPS and use HTTPS through Caddy.
