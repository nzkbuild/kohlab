# Changelog

All notable changes to **Kohlab** are documented here.

The format follows Keep a Changelog,
and this project adheres to Semantic Versioning.

Kohlab's versioning philosophy:

- **1.x line is home.** Steady growth — features, fixes, improvements — stays on 1.x.

## [1.10.0] - 2026-09-17

The overhaul release: the frontend was rebuilt from scratch on a researched,
audited design system — and verifying it surfaced twelve backend defects, five
of them process-fatal. Full evaluation in `docs/EVAL-AND-REDESIGN.md`; sourcing
in `docs/research/`.

### Added

- **New design system.** OKLCH primitive → semantic token tiers, bridged to
  Tailwind through `@theme inline`. Every pair audited against WCAG 2.2 AA
  (`scripts/check-contrast.mjs` — 21 pairs, ratios unrounded). Zero colour
  literals in components.
- **URL routing.** `/`, `/workspaces`, `/w/:id`, `/settings`. Refresh preserves
  context, links are shareable, Back/Forward work. The server gained the SPA
  history fallback it never had.
- **Accept a clean workspace.** A stopped workspace with no changes could never
  leave the review queue — commit was the only exit and it failed on a clean
  index. It now records acceptance, from the API and from the UI, and the
  affordance is offered **only** to a workspace actually in review (an empty diff
  alone also matches a workspace that has never run).
- **Mobile drawer.** The rail becomes an off-canvas drawer with a real toggle;
  previously the toggle was `display: none` below 680px, leaving an unlabelled
  icon rail that could not be opened. Closed, it leaves the tab order.
- **Error containment.** Root, per-pane, and per-lazy-region boundaries; the
  root reports through `onUncaughtError`/`onCaughtError`.
- **Realtime honesty.** Connection chip driven by socket state, exponential
  backoff with jitter, visibility-gated polling, coalesced screen-reader
  announcements with a pause control in Settings.
- **A backend typecheck.** Root `tsconfig.json` — `server.ts`, `lib.ts` and
  `cli.ts` were never checked, which is how five missing imports shipped.

### Fixed

- **`/api/workspaces/:id/diff` 404'd** on every non-share request — the main
  action switch had no `case "diff"`. Review-before-merge, the headline
  feature, was dead.
- **Untracked files were invisible to review** while `git add -A` committed
  them. You could commit files you were never shown.
- **WebSockets were never authenticated.** With an access key configured — the
  documented deployment — the terminal and the done-ping were both rejected 401.
- **`markStarted` was called but never imported**, killing the server on the
  first terminal attach (since v1.4.1).
- **`ensurePtySession` was not idempotent**, killing the server on the second
  attach — a reload, a second tab, a re-open.
- **Unhandled rejections on the socket path were fatal.** One client could take
  the server down for everyone.
- **The PTY daemon had no `resize` handler** despite documenting one, so the PTY
  stayed at 120×36 and the agent never received SIGWINCH.
- **Every server restart orphaned the PTY daemon**, losing all live sessions.
  It now adopts a running daemon instead of replacing it.
- **The done-ping broadcast never sent**: it guarded on `c.OPEN`, which does not
  exist on Bun's `ServerWebSocket`.
- **`cwd()` and `saveState` were called without being imported** — two more
  crashes on reachable paths.
- **Monaco rendered the patch, not the change.** `original=""` and
  `modified={diff}` showed raw `@@` hunks as file content against a blank pane.
  Diffs are now split into two real documents.
- **Opening a finished workspace relaunched its agent.** The attach path spawned
  unconditionally, so merely looking at a stopped workspace started a new run —
  and when that run ended it put the workspace straight back into the review
  queue, which meant accepting it never stuck. Attach now only subscribes, and
  says so with a "start it" affordance instead of a blank terminal.

### Changed

- React 18.3 → 19.3. Terminal and editor chunks are lazily fetched; the entry
  chunk no longer pulls xterm on first paint.
- `web/dist` is rebuilt, and `docs/upgrade.md` no longer tells you to back up
  the wrong directory.

### Deployment notes

- **Add `KillMode=process` to your unit** (`docs/systemd.md`). Without it,
  systemd's default `control-group` kills the detached PTY daemon on every
  restart, taking all live agent sessions with it — which defeats the point of
  the daemon-adoption fix.
- Restarting the daemon itself still ends every live session; its PTYs are its
  children.

### Known limitations

- PTY replay of a full-screen TUI lands on the final frame rather than the
  scrollback; it needs terminal-state capture, not a frontend change.
- No bulk dismiss for the review queue — accept one at a time.

## [1.9.0] - 2026-09-09

The workbench release: one visual language across every screen, plus the usage
model — task lifecycle, per-file review, and done-ping.

- **One status language** — carbon-black surfaces, emerald running, amber
  *needs review*, zinc stopped. Encoded once in `lib/status.ts`, shared by the
  sidebar, dashboard, cockpit header, and ⌘K palette (docs/ux-v1.9.0.md).
- **Per-file diff review** — the diff tab lists every changed file (the diff
  API now returns per-file patches); review each and commit in one click.
- **Review queue** — when an agent stops with an uncommitted diff, the
  workspace derives *needs review* (`lastCommitAt` on the record) and surfaces
  first on the dashboard.
- **Done-ping** — the server's `workspace.done` push is now consumed: title
  flash plus a browser notification (on first grant) when an agent finishes.
- **Token-complete CSS** — sidebar/chart/radius/shadow/spacing tokens added to
  `index.css` (Darkmatter shape, kohlab palette), so 21st.dev components drop
  in without collisions.
- **Polished chrome** — confirm dialog on delete, count badges on cockpit
  tabs, session-log live marker, activity-feed status dots, audit tail dots,
  toast restyle, sidebar active indicator + workspace groups.
- **Front door** — README and onboarding copy now tell the task-loop story
  (post a task → watch → review → commit) and mention team isolation.

Plans: docs/ux-v1.9.0.md, docs/product-v1.10.0.md



## [1.8.0] - 2026-09-07

The isolation release: one VPS, N safe users. Every named member gets a real
OS account, and their agents run as that user — the OS, not just the role
check, keeps members out of each other's data.

- **One OS user per member** — `user add` (CLI, API, Settings → Team) provisions `koh-<user>` (uid 10000+, private group, `0700` home + `~/.config`) and records the mapping in `users.json`. Revoke removes the account, home, and worktrees.
- **Sessions run as the owner** — the PTY daemon spawns each workspace's agent with the owner's `uid`/`gid` and `$HOME` (node-pty setuid). Alice's agent cannot read Bob's home, `~/.config`, or repos; cannot list or signal his sessions; cannot read `/root`.
- **Isolated workspaces** — members create from a git URL; the workspace is checked out under `/home/<user>/works/<id>/` (`admin/` bare clone + `tree/` + `images/`), all chowned to the member. Path-based creation stays the legacy root flow.
- **One spawn choke point** — `spawnAgentSession()` in lib.ts now carries caps (v1.7) *and* identity for both the CLI/API start path and the browser-attach path, so they can never drift.
- **Image pasting works in isolated sessions** — pasted screenshots land in the workspace's private `images/` dir, readable by the agent.
- **Team UI** — members see the team roster + audit tail; add/revoke stay owner-only.
- **Docs** — `docs/isolation.md`.

Full plan: ROADMAP.md

## [1.7.0] - 2026-09-05

The shared-box safety release. Per-workspace resource caps.

- **Resource caps** — workspaces carry optional `limits` (`timeoutSec`, `maxMemoryMb`, `maxProcs`), applied at agent spawn via `timeout` + `ulimit -d`/`-u` in `pty-daemon.cjs`.
- **Wall-clock timeout** — a `--timeout <sec>` cap kills a runaway agent and cleans its process tree.
- **Memory cap** — `--max-mem <mb>` uses `ulimit -d` (RLIMIT_DATA), which actually constrains Node agents' heap (unlike `-v`, which V8's address-space reservation bypasses).
- **Process cap** — `--max-procs <n>` via `ulimit -u`.
- **CLI + UI** — `kohlab new … --timeout/--max-mem/--max-procs`; the dashboard create form gains max-mem + timeout fields.
- **Docs** — `docs/resource-limits.md`.

Full plan: ROADMAP.md

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
