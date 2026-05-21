# HTTPS with Caddy on Someting

Caddy obtains and renews **Let's Encrypt** (or ZeroSSL) certificates automatically for every hostname that resolves to your VPS — **including** the management host (`MANAGEMENT_HOST`) and **every site domain** you add in the admin and apply with **Apply route**.

You do not need a separate HTTPS toggle in the platform: use **DNS hostnames** (not IPs for public sites), **open ports 80 and 443**, then use `https://` in the browser.

## Why the browser shows "Not secure"

Common causes:

1. **Opening `http://` instead of `https://`**  
   Bookmark `https://yoursite.example`. Once the cert exists, Caddy redirects HTTP to HTTPS.

2. **Using the raw VPS IP in the URL**  
   Public CAs normally do **not** issue certificates for IPs. Use a **hostname** plus **DNS A/AAAA** to your server.

3. **`MANAGEMENT_HOST` is wrong for production**  
   If `.env` has `MANAGEMENT_HOST=:80`, `MANAGEMENT_HOST=localhost`, or the bare IP, the main server block may not match `someting.somesoft.net` or may be HTTP-focused.  
   For admin UI on `https://someting.somesoft.net/`, set on the VPS `.env`:
   ```env
   MANAGEMENT_HOST=someting.somesoft.net
   ```
   No `http://`, no `:443`.

4. **DNS or firewall blocking ACME validation**  
   issuance usually needs inbound **TCP port 80** (and 443 afterward). Allow **TCP 80, 443** and **UDP 443** (HTTP/3) on the VPS and cloud firewall.

5. **`www` vs apex mismatch**  
   Add both `example.com` and `www.example.com` in Domains if you need both; click **Apply route** again after adding.

## Checklist per hosted site

- Domain added in admin for that site (`example.com`).
- **Apply route** so `caddy/sites/<slug>.caddy` lists that hostname (no `http://` in the snippet).
- DNS **A** record for that name points at the VPS.
- Reload Caddy after changes: `docker compose restart caddy` or reload via `docker exec hosting-caddy caddy reload --config /etc/caddy/Caddyfile`.

## Checklist for admin on a hostname

- `MANAGEMENT_HOST=someting.somesoft.net` in VPS `.env` (example).
- DNS for that hostname to the VPS.
- Restart stack: `docker compose up -d` (pick up env).
- Open `https://someting.somesoft.net/`.

## Debugging

```bash
cd /opt/someting
docker compose logs caddy --tail 200
```

Look for certificate success versus challenge failures.

## Local development

Keep `MANAGEMENT_HOST=:80` (or `:80`-style setup) — that avoids Let's Encrypt failures for non-public hostnames while you hack locally.
