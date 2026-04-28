# First Site Migration

Start with a low-risk static or simple Node site. The first migration proves DNS, TLS, deploys, logs, and backups before moving PHP or database-backed apps.

## 1. Create The Site Folder

```bash
sudo HOSTING_ROOT=/srv/hosting /srv/hosting/bin/create-site.sh my-site static https://github.com/example/my-site.git main
```

Edit `/srv/hosting/sites/my-site/site.env`:

```bash
BUILD_COMMAND=npm run build
START_COMMAND=
```

Edit `/srv/hosting/sites/my-site/.env` with app runtime variables. Do not commit this file.

## 2. Register In The Management App

Create the same site slug in the admin UI, then add every hostname that should route to it, for example:

- `example.com`
- `www.example.com`
- `demo.example.com`

## 3. Deploy

```bash
sudo -u deploy /srv/hosting/bin/deploy-site.sh my-site
```

Use the admin UI logs link or:

```bash
docker logs --tail 250 site-my-site
```

## 4. Apply Route And DNS

In the admin UI, click `Apply route`. Then configure DNS:

```text
example.com      A      <vps-ipv4>
www.example.com  CNAME  example.com
```

Add an `AAAA` record too if you enable IPv6 on the VPS.

## 5. Verify

```bash
curl -I https://example.com
docker compose ps
```

If the deploy fails, fix the site template or commands and run the deploy again. The previous release directories are kept under `/srv/hosting/sites/my-site/releases`.
