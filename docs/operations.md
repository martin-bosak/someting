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

## Auto-Deploy, Health, Rollback, Alerts

- GitHub push webhooks can trigger deploys when `GITHUB_WEBHOOK_SECRET` is set. See `docs/github-webhooks.md`.
- Each site should configure a realistic `healthcheck_path` (for example `/` or `/health`).
- Failed health checks after deploy attempt to restore the previous release automatically.
- Retained releases can also be rolled back manually from the site detail page.
- Optional `ALERT_WEBHOOK_URL` sends best-effort JSON alerts for deploy failures, unhealthy rollbacks, and stale backups.
- `/admin/backups` and `/admin/observability` surface backup freshness and runtime health without destructive restore buttons.

## Database Isolation

Use one PostgreSQL instance with separate database users and databases per site:

```sql
create user my_site with password 'change-me';
create database my_site owner my_site;
```

Add MariaDB/MySQL only for apps that cannot be moved to PostgreSQL.
