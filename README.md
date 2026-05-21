# Someting

Someting is a small single-VPS hosting platform for personal websites. It is designed for a Hetzner CX23-sized server and uses Docker Compose, Caddy, PostgreSQL, and a lightweight management app to host PHP, Node/React, Python, and static sites from Git repositories.

## What This Repo Contains

- `compose.yaml` runs the platform services: Caddy, PostgreSQL, and the management app.
- `src/` contains the TypeScript management app for sites, domains, deploys, logs, and route generation.
- `scripts/` contains VPS bootstrap, site creation, deployment, and backup scripts.
- `templates/` contains starter runtime templates for PHP, Node, Python, and static React-style sites.
- `infra/` contains reverse-proxy and operational configuration.
- `docs/` contains migration, DNS, mail, and operations notes.
- `src/mcp.ts` exposes an MCP server for agent-based platform management over stdio.

## Recommended VPS Layout

The production server layout is intentionally boring and reproducible:

```text
/srv/hosting
  /sites          # one folder per hosted site
  /caddy/sites    # generated Caddy host configs
  /postgres       # PostgreSQL data volume
  /backups        # local backup staging
  /logs           # script and deploy logs
```

## Quick Start Locally

```bash
cp .env.example .env
npm install
docker compose up -d --build
```

For local Docker testing, set `HOSTING_ROOT_HOST=./runtime` in `.env`.

For a VPS deployment, copy this repository to the server, review `.env.example`, keep `HOSTING_ROOT_HOST=/srv/hosting`, then run:

```bash
sudo ./scripts/bootstrap-vps.sh
docker compose up -d --build
```

The management app is protected with HTTP Basic Auth using `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
It also has a `/login` page that stores a short-lived admin session cookie for browser use.
Before a real admin domain is configured, access it through an SSH tunnel:

```bash
ssh -L 3000:127.0.0.1:3000 root@your-vps
```

Then open `http://localhost:3000/admin`.

## HTTPS (production)

**Caddy issues TLS certificates automatically** for:

- **`MANAGEMENT_HOST`** (the admin reverse-proxy block in `infra/caddy/Caddyfile`), and  
- Every hostname you attach to a site and **Apply route** (`caddy/sites/*.caddy`).

On the VPS, set **`MANAGEMENT_HOST`** to your real admin hostname (e.g. `someting.somesoft.net`): no `http://` prefix and not the bare IP. Ensure **TCP 80 and 443** (and UDP 443 if you care about HTTP/3) are open so Let's Encrypt can validate. Use **`https://`** in the browser.

Full checklist and troubleshooting: [docs/https.md](docs/https.md).

## First Site Flow

```bash
sudo ./scripts/create-site.sh my-site node https://github.com/example/my-site.git main
sudo ./scripts/deploy-site.sh my-site
```

Then add the site and domain in the management app, apply the Caddy route, and point DNS `A`/`AAAA` records at the VPS.

## Upload Plain Static Files

For a local folder with `index.html`, CSS, and assets, no Git repository is required:

```powershell
.\deploy\upload-static-site.ps1 -Slug my-page -Path C:\path\to\site -Name "My Page"
```

This creates or updates an `html` runtime site from the folder contents. See `docs/upload-static-sites.md`.

## Path-Based Preview

Before DNS is configured, a site can be exposed through the admin host/IP at `/sites/<slug>/`. Click `Path route` on a site card, then open:

```text
http://95.217.223.133/sites/my-page/
```

See `docs/path-routing.md`.

## Persistent Storage

Every site container gets one writable directory that survives redeploys:
**`/data`** inside the container, backed by `sites/<slug>/shared/` on the host.

Everything else is ephemeral — each deploy is a fresh `git clone` and image
rebuild, so anything written outside `/data` is wiped. Site authors should write
uploads, SQLite databases, and generated files under `/data` (read the path
from a `DATA_DIR` env var rather than hardcoding it).

The directory is created by `create-site.sh` and bind-mounted via each runtime
template's `compose.yaml` (`./shared:/data`). Manage its contents from the admin
app (the **Storage** button on a site card) or over MCP (`list_site_storage`,
`read_site_file`, `write_site_file`, `delete_site_file`).

**`HOSTING_ROOT` and `HOSTING_ROOT_HOST` must be identical absolute paths** for
this to work — the `./shared` bind mount is resolved by the host Docker daemon,
not the control-plane container. Production uses `/srv/hosting` for both. The
local-dev value `HOSTING_ROOT_HOST=./runtime` differs from the in-container
`HOSTING_ROOT`, so per-site `/data` mounts do not resolve locally; set both to
the same absolute path if you need to exercise site storage on a dev machine.

## MCP Access

Agents can manage the platform through external HTTP MCP:

```text
http://95.217.223.133/mcp
```

Use HTTP Basic Auth with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

Agents can also connect through SSH stdio:

```bat
deploy\someting-mcp.cmd
```

See `docs/mcp.md` for the Cursor MCP configuration snippet and available tools.

## Private Repositories

For private GitHub repos, open a site in the admin UI and choose `Deploy Auth`. You can configure either an HTTPS token or an SSH deploy key per site. See `docs/private-repos.md`.