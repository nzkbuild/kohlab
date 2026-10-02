# Reverse proxy

The dashboard is not meant to be exposed publicly without TLS. Put it behind
a reverse proxy (Caddy or nginx) that terminates HTTPS.

Kohlab serves both HTTP and WebSocket on the same port (7676), the terminal
streaming runs over the WebSocket, so the proxy must upgrade connections.

## Caddy (simplest)

Caddyfile:

```
kohlab.example.com {
    reverse_proxy localhost:7676
}
```

Caddy upgrades WebSockets automatically.

## nginx

```
server {
    listen 443 ssl;
    server_name kohlab.example.com;

    location / {
        proxy_pass http://127.0.0.1:7676;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

## Security

- Set `KOHLAB_KEY` (see [install.md](install.md)) so the dashboard is not open.
- Share links (`?share=…`) are read-only by design and stay public-read.
  If that's a concern, keep the proxy private (VPN / tailscale).

## Tailscale serve

The simplest private setup: TLS with an automatic certificate, reachable only
from your tailnet. Kohlab stays bound to loopback.

```sh
tailscale serve --bg --https=8444 http://127.0.0.1:7676
# then open https://<machine>.<tailnet>.ts.net:8444
```

Kohlab sends `Content-Security-Policy`, `X-Content-Type-Options` and
`Referrer-Policy` itself. HSTS is the TLS terminator's job (here, Tailscale):
the app cannot tell whether it is behind TLS.
