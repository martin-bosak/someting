# Site Inventory Template

Use this before migrating each site. Store real secrets outside Git.

## Site

- Name:
- Slug:
- Current host:
- Runtime: `php`, `node`, `python`, or `static`
- Repository:
- Branch:
- Domains:
- DNS provider:

## Runtime

- Build command:
- Start command:
- Public port expected by app:
- Cron/background workers:
- Upload/storage paths:
- Required system packages:

## Database

- Engine: PostgreSQL, MySQL/MariaDB, SQLite, or none
- Database name:
- Current backup/export location:
- Migration command:

## Deployment

- Accepts short restart: yes/no
- Healthcheck path:
- Rollback notes:
- Special environment variables:
