# Changelog

All notable changes to **Kohlab** are documented here.

The format follows Keep a Changelog,
and this project adheres to Semantic Versioning.

Kohlab's versioning philosophy:

- **1.x line is home.** Steady growth — features, fixes, improvements — stays on 1.x.
- **The major version moves only on a breakthrough release** — a fundamental shift in what Kohlab can do, not just a big feature.

## [1.6.0] - 2026-09-05

The team release. Named users, roles, and an audit trail — still JSON files, no database.

### Team & security

- **Named users with roles** — `owner` / `member` / `viewer`, stored hashed (SHA-256) in `users.json`. A generated key is returned exactly once, never persisted or listed.
- **Role gating** — `viewer` is read-only (watch terminals, read diffs/logs/files); `member` can create/start/stop/commit/delete and install agents; `owner` alone manages users. Mutating routes return 403 for viewers.
- **Audit trail** — every mutation (create/start/stop/restart/delete/commit/share/user-manage/agent-install) appends one JSON line to `audit.log`, attributed to the named user. Served at `GET /api/audit` (owner/member only).
- **Backward compatible** — a bare `KOHLAB_KEY` still works (treated as `owner`); a keyless server stays open.

### CLI

- `kohlab user add <id> [--name 'N'] [--role R]` — prints the key once.
- `kohlab user rm <id>`, `kohlab user` (list), `kohlab audit`.

### Frontend

- Settings gains a **Team section** — list/add/revoke teammates, show the one-time key, and tail recent activity. Hidden when the caller lacks rights.

Full plan: RELEASE-PLAN.md

## [1.4.1] - 2026-09-05

The hardening + frontend-experience follow-up. Finishes the v1.4.0 plan's frontend half.

### Adoption & UX

- **Fix false access-key prompt** — the login gate now only appears when the server actually requires a key (`GET /api/auth/required`); an open (keyless) server goes straight to the app. Keyed deployment still prompts and still enforces.
- **One-line installer** — `curl -fsSL https://raw.githubusercontent.com/nzkbuild/kohlab/main/install.sh | bash` clones, installs deps, and builds the dashboard.
- **`kohlab install` subcommand** — checks git/bun, generates a suggested `KOHLAB_KEY`, prints start + tunnel + auto-start steps.
- **`docs/` directory** — install, systemd, reverse-proxy, upgrade, and security guides (the README referenced these but the dir didn't exist).
- **CLI text consistency** — every user-facing `works …` command now reads `kohlab …`, matching the actual binary name.
- **Onboarding close-the-loop** — after "create & launch", the flow shows a share-link button that copies a read-only URL to the clipboard.

### Backend

- **State mutex** — all `state.json` read-modify-write now serializes through one lock (`mutateState`), eliminating lost-update races between concurrent API handlers and the completion watcher.
- **Daemon self-healing** — a watchdog respawns the PTY daemon if it dies, dropping the stale socket so the next op starts fresh instead of failing forever. `ptyList` returns `null` (not `[]`) when the daemon is unreachable, so the watcher never misreads an outage as "everything done".
- **Intentional-stop tracking** — stop/delete mark a workspace so its daemon `exit` isn't reported as an agent completion.
- **Completion-watcher fix** — session IDs are matched by exact id instead of `split("-")`, which broke on workspace ids containing dashes.
- **Path containment** — static serving and the `file` endpoint use `resolve`+`relative` checks; a crafted path can no longer escape its root.
- **PTY log endpoint** — `/log` now tails the daemon's buffered output instead of a legacy `session.log` file.

### Frontend

- **Bundle split (F1)** — Monaco and xterm are now in their own chunks via `manualChunks`; the entry dropped from 728 KB → 275 KB raw (207 KB → 86 KB gzip). Workspace list + shell paint before the editor/terminal load.
- **Command center** — new dashboard with KPIs, agent availability, and a recent-activity feed.
- **Guided onboarding** — a three-step first-run flow (install agent → create workspace → launch) replaces the bare empty list; the workspace-creation step only activates once an agent is installed.
- **Command palette** — ⌘K quick actions (start/stop/new/navigate) across workspaces.
- **Settings** — agent management + server info in one place.
- **Session log view** — live tail of a workspace's main-session output.
- **Scrollback persistence** — xterm instances are cached (bounded) so scrollback and fit survive tab switches and remounts.
- **Terminal reconnect with backoff** — exponential backoff (500ms → 10s cap) resets on successful connect, and a drop announces "disconnected" once instead of spamming each retry.
- **Image upload** — paste/send a PNG/JPEG/GIF/WebP into a workspace's terminal.

## [1.4.0] - 2026-08-25

The PTY cutover release. The node-pty daemon is now the single source of truth for session state.

### Backend

- **PTY cutover completion** — running status, stop, delete, and completion all derive from the PTY daemon, not tmux. (tmux is fully out of the hot path.)
- **Session lifecycle hardening** — stop/delete terminate the real PTY process tree (SIGKILL to the whole tree, not just the shell); orphaned child processes are reliably killed.
- **Event-driven completion** — the watcher listens to daemon exit events and marks workspaces done immediately; polling remains as a fallback.
- **State consistency** — started/stopped timestamps reflect daemon session open/close; start now spawns the agent's PTY immediately instead of waiting for the first browser attach.
- **Shared daemon client** — the socket connection moved into lib.ts, shared by the server (terminal streaming) and lib (lifecycle). No more dual connections or drift.
- **Fixes** — stop/delete now actually work (routes were missing cases); stop/delete no longer lose state writes (double-load bug fixed).

### Deferred

Frontend work (bundle split, onboarding polish, terminal reconnect) is planned but not in this release.

Full plan: RELEASE-PLAN.md

## [1.3.0] - 2026-08-25

The "from zero to running agent" release. Functional parity with the core Superset loop, on a real frontend.

- **React + Vite + TypeScript frontend** — replaces the hand-rolled HTML/JS dashboard.
- **Agent installer** — detect missing agents (codex, opencode, pi) and install from the UI.
- **Agent login walkthrough** — guided setup per agent (claude setup, codex API key).
- **GitHub integration** — repo browser + clone-to-workspace flow.
- **Monaco editor + diff** — real code editing and review, not plain text.
- **Multi-terminal tabs** — one terminal per workspace, tabbed.
- **Guided workspace creation** — pick repo, branch, agent, task in one flow.

## [1.2.0] - 2026-08-25

### Added

- **File tree & code view** — browse any workspace's repo in the dashboard; click a file to read it with line numbers. No more SSH-ing in to look at code.
- **Clone from GitHub** — paste a repo URL in the dashboard and kohlab clones it into a workspace. New projects take seconds, not setup.
- **Agent availability** — the dashboard shows which agents (omp, claude, codex, …) are installed on the host at a glance.
- **`kohlab` launcher** — typing `kohlab` opens the dashboard in your browser; closing the tab never stops the agents.
- **Keyboard shortcuts** — ⌘/Ctrl+1/2/3 jump between files/terminal/diff; `n` focuses new-workspace; `r` refreshes.
- **Access-key prompt** — the dashboard asks for the access key once and remembers it, instead of a bare 401.

### Fixed

- **Security**: WebSocket terminal connections are now gated by the access key — previously unauthenticated sockets could attach.

## [1.1.0] - 2026-08-25

### Added

- **Completion notifications** — the moment an agent finishes its work, the dashboard shows it as done and (optionally) fires a webhook. Walk away and trust it.
- **Workspace sharing** — share a read-only link to any workspace; a teammate (or your other device) can watch the live terminal and review the diff without touching controls.
- **Scoped access key** — optional `KOHLAB_KEY`; when set, the dashboard and API require it. Deploy safely behind a reverse proxy. Share links stay public-read.

### Fixed

- Workspace creation now uses a unique branch per workspace, so multiple workspaces on the same repo no longer collide.
- Completion detection now catches short-lived sessions and persists the finished timestamp.

## [1.0.0] - 2026-08-25

### Added

- **Parallel agent workspaces** — run Claude Code, Codex, omp, or any terminal agent, each isolated in its own git worktree.
- **Persistent sessions** — agents run in durable tmux sessions; they survive disconnects, device switches, and server restarts.
- **Browser dashboard** — live workspace list, attach to any agent terminal in real time, from any device.
- **Diff viewer** — review each agent's changes before committing, with one-click commit.
- **CLI** — full control from any shell: `new`, `ls`, `start`, `stop`, `restart`, `attach`, `diff`, `commit`, `delete`.
- **Custom agent launchers** — register any terminal command as an agent.
- **Lightweight by design** — single server process, JSON state file, no database, no containers.

### Security

- Access is designed for SSH tunneling; the dashboard is not intended to be exposed publicly without a reverse proxy.
