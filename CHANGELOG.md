# Changelog

All notable changes to **Kohlab** are documented here.

The format follows Keep a Changelog,
and this project adheres to Semantic Versioning.

Kohlab's versioning philosophy:

- **1.x line is home.** Steady growth — features, fixes, improvements — stays on 1.x.
- **The major version moves only on a breakthrough release** — a fundamental shift in what Kohlab can do, not just a big feature.
- **Every change is a disciplined bump**: patch (1.0.1) for fixes, minor (1.1.0) for new features, major (2.0.0) only for a breakthrough.

## [Unreleased]

### Planned — v1.1.0 (see RELEASE-PLAN.md)

- **Completion notifications** — get notified the moment an agent finishes.
- **Workspace sharing** — share a workspace with a teammate and see it live.
- **Scoped access key** — deploy the dashboard behind a reverse proxy safely.

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
