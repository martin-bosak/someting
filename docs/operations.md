# Operations

## Server Hardening

Run `scripts/bootstrap-vps.sh` once on a fresh Ubuntu VPS. It installs Docker, enables UFW for SSH/HTTP/HTTPS, enables fail2ban and unattended upgrades, creates `/srv/hosting`, installs helper scripts, and configures basic log rotation plus nightly PostgreSQL dumps.

Keep SSH key-only login configured at the provider/server level. Do not expose the management app on an unguessable hostname as the only protection; it must use a strong `ADMIN_PASSWORD`.

## Resource Limits

This platform targets a 2 vCPU / 4 GB RAM VPS. Keep the base stack small:

- One PostgreSQL container.
- One Caddy container.
- One control-plane container.
- One container per hosted app.

Avoid running heavy log stacks, CI runners, Kubernetes, or full mail filtering on the same VPS. For larger Node/Python apps, prefer building artifacts in GitHub Actions and keeping the VPS deploy step short.

## Backups

`backup-postgres.sh` creates compressed PostgreSQL dumps in `/srv/hosting/backups`. Copy that directory off-server with Hetzner Storage Box, S3-compatible storage, restic, rclone, or another backup tool.

Minimum backup set:

- PostgreSQL dumps.
- `/srv/hosting/sites/*/site.env`.
- `/srv/hosting/sites/*/.env`.
- `/srv/hosting/caddy/sites`.
- This Git repository revision.

## Logs

Start with Docker logs and deploy logs:

```bash
docker logs --tail 250 site-my-site
tail -f /srv/hosting/logs/deploy-my-site.log
```

Add Loki or another log stack only after disk and memory usage are well understood.

## Database Isolation

Use one PostgreSQL instance with separate database users and databases per site:

```sql
create user my_site with password 'change-me';
create database my_site owner my_site;
```

Add MariaDB/MySQL only for apps that cannot be moved to PostgreSQL.
