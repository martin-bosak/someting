# Backups

`deploy/backup-platform.ps1` runs from your local Windows host and pulls a full
snapshot of the VPS into a timestamped folder under `_BACKUP/` (git-ignored).

## What it captures

```
_BACKUP/2026-06-09_140300/
  postgres/
    someting.dump          # pg_dump custom format (-Fc), or someting.sql.gz fallback
  deployed/
    sites-code.tar.gz      # /srv/hosting/sites: releases + per-site config
                           #   (excludes node_modules and the shared/ volumes)
    caddy.tar.gz           # Caddy routes, config, and TLS certs (no access logs)
  sites/
    <slug>/volume.tar.gz   # each site's persistent shared/ storage (the /data mount)
  manifest.txt
```

1. **Postgres** is dumped over a local SSH tunnel to the VPS loopback Postgres
   (`127.0.0.1:15432`). Credentials are read from the VPS `.env`
   (`/opt/someting/.env`). If a local `pg_dump` is missing or version-incompatible,
   it automatically falls back to running `pg_dump` inside the container over SSH
   and produces `someting.sql.gz` instead.
2. **Deployed code** is the `sites/` tree (what is actually running) plus the
   Caddy config and certificates.
3. **Mounted volumes** are each site's `shared/` directory, one tarball per site.

## Usage

```powershell
# Full backup (uses SOMETING_VPS_HOST / _USER / _SSH_KEY, defaults baked in)
powershell -ExecutionPolicy Bypass -File deploy/backup-platform.ps1

# Keep only the 7 most recent backup folders
powershell -ExecutionPolicy Bypass -File deploy/backup-platform.ps1 -KeepBackups 7

# Skip parts
powershell -ExecutionPolicy Bypass -File deploy/backup-platform.ps1 -SkipVolumes
```

Or run the VS Code task **"Someting: Backup platform to local _BACKUP"**.

A local `pg_dump` (PostgreSQL 16+ client) gives the most portable dump. Without
it the script still works via the in-container fallback.

## Restore

Postgres (custom-format dump, over the same tunnel):

```powershell
# In one terminal: open the tunnel
powershell -ExecutionPolicy Bypass -File deploy/db-tunnel.ps1

# In another: restore (drops & recreates objects)
$env:PGPASSWORD = "<POSTGRES_PASSWORD from VPS .env>"
pg_restore -h 127.0.0.1 -p 15432 -U someting -d someting --clean --if-exists "_BACKUP/<stamp>/postgres/someting.dump"
```

If you have the `.sql.gz` fallback instead:

```powershell
# gunzip, then pipe to psql over the tunnel
psql "postgres://someting:<pw>@127.0.0.1:15432/someting" -f someting.sql
```

Deployed code / volumes (copy a tarball up and extract on the VPS):

```bash
scp _BACKUP/<stamp>/sites/<slug>/volume.tar.gz root@<vps>:/tmp/
ssh root@<vps> "tar -xzf /tmp/volume.tar.gz -C /srv/hosting/sites/<slug> && rm /tmp/volume.tar.gz"
```

The `sites-code.tar.gz` extracts under `/srv/hosting` (its top-level entry is
`sites/`); `caddy.tar.gz` extracts under `/srv/hosting` (top-level `caddy/`).
After restoring Caddy config, reload it:

```bash
docker exec hosting-caddy caddy reload --config /etc/caddy/Caddyfile
```

## Admin visibility

The control plane exposes a read-only **Backups** page at `/admin/backups` with:

- files under `/srv/hosting/backups`
- latest Postgres dump age
- tail of `/srv/hosting/logs/backup.log`
- manual restore guidance

Destructive restore actions remain manual by design.
