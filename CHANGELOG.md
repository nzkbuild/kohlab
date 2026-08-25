# Changelog

All notable changes to **Kohlab** are documented here.

The format follows Keep a Changelog,
and this project adheres to Semantic Versioning.

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
