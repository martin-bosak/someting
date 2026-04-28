# Someting

Someting is a small single-VPS hosting platform for personal websites. It is designed for a Hetzner CX23-sized server and uses Docker Compose, Caddy, PostgreSQL, and a lightweight management app to host PHP, Node/React, Python, and static sites from Git repositories.

## What This Repo Contains

- `compose.yaml` runs the platform services: Caddy, PostgreSQL, and the management app.
- `src/` contains the TypeScript management app for sites, domains, deploys, logs, and route generation.
- `scripts/` contains VPS bootstrap, site creation, deployment, and backup scripts.
- `templates/` contains starter runtime templates for PHP, Node, Python, and static React-style sites.
- `infra/` contains reverse-proxy and operational configuration.
- `docs/` contains migration, DNS, mail, and operations notes.

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

## First Site Flow

```bash
sudo ./scripts/create-site.sh my-site node https://github.com/example/my-site.git main
sudo ./scripts/deploy-site.sh my-site
```

Then add the site and domain in the management app, apply the Caddy route, and point DNS `A`/`AAAA` records at the VPS.