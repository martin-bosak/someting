# DNS And Domains

Each hosted site can have second-level and third-level domains as long as their DNS records point to the VPS.

## Records

For apex/root domains:

```text
example.com  A     <vps-ipv4>
example.com  AAAA  <vps-ipv6>
```

For subdomains:

```text
www.example.com   CNAME  example.com
demo.example.com  CNAME  example.com
```

You can also use direct `A`/`AAAA` records for subdomains if your DNS provider does not allow the CNAME shape you want.

## TLS

Caddy requests certificates automatically after:

- DNS points at the VPS.
- Ports `80` and `443` are open.
- The management app has generated a Caddy route for the site.

## Route Generation

The management app writes one generated file per site under:

```text
/srv/hosting/caddy/sites/<slug>.caddy
```

Example:

```caddy
example.com, www.example.com {
	encode zstd gzip
	reverse_proxy site-my-site:8080
}
```

Hosted app containers must listen on port `8080` inside the shared `someting_hosting` Docker network.
