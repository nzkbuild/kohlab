# Changelog

All notable changes to **Kohlab** are documented here.

The format follows Keep a Changelog,
and this project adheres to Semantic Versioning.

Kohlab's versioning philosophy:

- **1.x line is home.** Steady growth — features, fixes, improvements — stays on 1.x.
- **The major version moves only on a breakthrough release** — a fundamental shift in what Kohlab can do, not just a big feature.
## [Unreleased] — v1.3.0 (planned)

The "from zero to running agent" release. Functional parity with the core Superset loop, on a real frontend.

- **React + Vite + TypeScript frontend** — replaces the hand-rolled HTML/JS dashboard.
- **Agent installer** — detect missing agents (codex, opencode, pi) and install from the UI.
- **Agent login walkthrough** — guided setup per agent (claude setup, codex API key).
- **GitHub integration** — repo browser + clone-to-workspace flow.
- **Monaco editor + diff** — real code editing and review, not plain text.
- **Multi-terminal tabs** — one terminal per workspace, tabbed.
- **Guided workspace creation** — pick repo, branch, agent, task in one flow.

Full plan: RELEASE-PLAN.md

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
