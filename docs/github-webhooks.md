# GitHub Auto-Deploy

Someting can deploy sites automatically when GitHub sends a `push` webhook.

## Setup

1. Set a strong secret in the VPS `.env`:

```env
GITHUB_WEBHOOK_SECRET=change-me-to-a-long-random-string
```

2. Restart the control plane:

```bash
docker compose up -d --build
```

3. In each GitHub repository, open **Settings → Webhooks → Add webhook**:

- **Payload URL:** `https://<MANAGEMENT_HOST>/webhooks/github`
- **Content type:** `application/json`
- **Secret:** same value as `GITHUB_WEBHOOK_SECRET`
- **Events:** Just the `push` event`

4. Ensure the site in Someting uses the same repository URL and branch as the push event.

## Matching rules

- Event type must be `push`.
- Branch must match the site's configured `branch` (`refs/heads/main` → `main`).
- Repository URL is normalized and matched against the site's `repo_url` (HTTPS or `git@github.com:` forms).

## Security

- The webhook route bypasses admin login but rejects requests without a valid `X-Hub-Signature-256`.
- If `GITHUB_WEBHOOK_SECRET` is unset, the endpoint returns HTTP 503.

## Deployment behavior

Webhook deploys use the same pipeline as manual deploys:

- clone/build via `deploy-site.sh`
- store `commit_sha`, `release_id`, and `trigger=github_webhook` on the deployment row
- run a post-deploy health check against `healthcheck_path`
- roll back to the previous release if the health check fails after a successful build

Webhook attempts are recorded in the activity log.
