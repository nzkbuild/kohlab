# Security model

Kohlab is a self-hosted tool for your own server. Its posture follows from where
it runs.

## Trust boundary

- **An open server is only possible on loopback.** With no `KOHLAB_KEY` and no
  named users, anonymous requests count as the owner — so the server will not
  stay that way anywhere it can be reached from off the box. Bound beyond
  loopback it generates a key, stores it at `$WORKS_DIR/key` (mode 0600) and says
  so in the journal. `HOST=127.0.0.1` keeps it local and keyless; the installer
  always sets a key. This is the one dangerous combination, and it is made
  impossible rather than documented.
- **Losing the key is not losing the box.** `kohlab key` prints it — from the
  environment, from the unit, or from the generated file, and says which —
  and `kohlab key rotate` issues a new one. Both run on the machine only, so
  neither can be reached over the network.
- **`KOHLAB_KEY`** is the single-operator key. When set, every `/api/*` route and
  the terminal WebSocket require a key. The dashboard sends it in an
  `Authorization: Bearer` header, never in a URL — the sockets carry theirs in a
  WebSocket subprotocol, because a browser cannot set a header on an upgrade. The
  old `?key=` form still works for bookmarks and curl, and is never sent by the
  app. Comparison is constant-time. It is treated as an **owner**, so single-user
  installs keep working unchanged.
- **Repeated wrong keys are throttled** — 20 refusals per address per minute, in
  memory. The key is checked before the throttle is consulted, so a correct key
  still works after a run of wrong ones, and one address cannot lock out another.
  A revoked key reports 429 rather than 401 while a window is open: the throttle
  cannot tell a revoked key from a guessed one.
- **Every gate answers 401 before 403**, through one predicate rather than a
  convention at each route. A request with no credentials is told it sent nothing;
  a request with insufficient credentials is told it is not enough. Ten routes used
  to answer 403 to an anonymous caller, which is how one route ended up with no
  gate at all — see the 1.13.1 notes above.
- **A member rotates their own key** from **Settings → Account**, without an owner
  handing them a new one. The old key dies the instant the server answers.
- **Named users** (`kohlab user add <id> [--role owner|member|viewer]`) each get
  their own key — shown once, stored only as a hash. Roles gate the API: viewers
  read, members act on their own workspaces, owners run the box (members, updates,
  settings).
- **Per-member isolation.** Every member maps to an OS account (`koh-<user>`, uid
  10000+). Their agent sessions drop to that uid/gid with `$HOME` set, and their
  worktrees live under a `0700` home. A member reads and writes their own work and
  nothing else — enforced by the kernel, not by the role check. See
  [isolation.md](isolation.md).
- **Share links** (`?share=<token>`) are public-read by design: one workspace's
  terminal, diff and log. They can never start, stop, commit or delete.
- **Over-the-air updates** (`POST /api/release/update`) are owner-only and
  audited: 401 without credentials, 403 with the wrong role.

## What you must do

1. Claim the server, or set `KOHLAB_KEY` to a long random secret.
2. Never bind the dashboard to `0.0.0.0` without a reverse proxy (TLS). Prefer SSH
   tunneling or a private network such as Tailscale.
3. Give teammates their own accounts instead of sharing the owner key — separate
   accounts are what make the isolation real.

## Known limits

- **No namespaces.** Agents run without `bwrap` or containers, so an agent can
  `ps` the whole host and see that other members' processes exist. It cannot read
  their files or signal their processes. `bwrap` per session is the next rung.
- **Provisioning needs root.** Without it, members get a key and a role but no OS
  account: their sessions run as the server user and only the role check separates
  them. The server logs `not root; skipping OS-user provisioning for '<id>'`.
- **One shared state file and audit log.** Data isolation is per-home, not
  per-namespace: the server still manages a single `state.json`, `users.json` and
  `audit.log` for the whole box.
- **The commit gate is a workflow, not a sandbox.** In a legacy (path-repository)
  workspace the agent shares the server's git object store and runs as the server
  user, so with credentials present it could push or rewrite branches. Isolation
  comes from a member's own OS account, not from the review step. Treat
  agent-authored commits as untrusted input — which is why review exists.
- **Agent installs** are whitelisted (`npm i -g` / `curl -fsSL` prefixes only);
  arbitrary shell on the host is rejected.
- **Image uploads** are MIME-sniffed, capped at 20 MiB, and path-contained so a
  crafted name cannot escape its directory.
