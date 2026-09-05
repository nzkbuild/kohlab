# Security model

Kohlab is a self-hosted tool for your own server. Its security posture follows
from where it runs.

## Trust boundary

- **By default the server is open** — anyone who can reach port 7676 controls
  workspaces. This is fine for `localhost` and SSH-tunnel use.
- **`KOHLAB_KEY`** turns on auth. When set, every `/api/*` route and the
  terminal WebSocket require `?key=<key>` or `Authorization: Bearer <key>`.
  The key comparison is constant-time.
- **Share links** (`?share=<token>`) stay public-read by design: they expose a
  read-only terminal view + diff + log, never start/stop/commit.

## What you must do

1. Set `KOHLAB_KEY` to a long random secret.
2. Never bind the dashboard to `0.0.0.0` without a reverse proxy (TLS).
3. Prefer SSH tunneling or a private network (tailscale) over public exposure.

## Known limits

- **No per-user accounts.** One key = one trust domain. Teams that need
  per-member roles + audit see the roadmap (named users are planned, not
  shipped).
- **Agents run as the server's user** with full access to that user's files and
  git repos. Isolate Kohlab under a dedicated OS user for anything you don't
  fully trust.
- **Agent installs** are whitelisted (`npm i -g` / `curl -fsSL` prefixes only)
  — arbitrary shell on the host is rejected.
- **Image uploads** are MIME-sniffed and capped at 20 MiB; paths are
  resolve-contained so a crafted name can't escape its directory.
