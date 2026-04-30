# Path-Based Site Routing

Someting can expose a site through the admin host/IP at:

```text
http://95.217.223.133/sites/<slug>/
```

This is useful for testing a site before DNS is configured.

## How To Enable

In the admin UI, use the site card action:

```text
Path route
```

This writes a generated Caddy snippet under:

```text
/srv/hosting/caddy/paths/<slug>.caddy
```

and reloads Caddy.

## Limitations

Path routing strips `/sites/<slug>/` before forwarding to the app container. Sites that use relative assets usually work. Sites that hard-code absolute asset paths like `/styles.css` may still request assets from the admin root instead of `/sites/<slug>/styles.css`.

For production use, prefer a real domain route.
