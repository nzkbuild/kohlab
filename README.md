<div align="center">

# Kohlab

### Run your AI coding agents in parallel — from any device, from anywhere.

**Your agents keep working even when you disconnect. Check on them from your phone, review their work, and keep every project safe in its own isolated workspace.**

</div>

---

## Why Kohlab

If you're building with AI coding agents, you know the pain:

- **Disconnect = disaster.** Your laptop dies, your SSH drops, and the agent stops mid-task. All that work, gone.
- **One task at a time.** Running a second agent on the same code means they fight over files.
- **No visibility.** You can't tell what your agent is doing until you're sitting in front of a terminal.

Kohlab fixes all three — and stays out of your way.

## What Kohlab is

**A simple, self-hosted command center for AI coding agents.**

- **Parallel agents.** Spin up Claude Code, Codex, omp, or any agent that runs in a terminal — each in its own isolated workspace. They work side by side without touching each other.
- **Never loses work.** Every agent runs in a persistent session on your server. Close your laptop, switch devices, lose your connection — the agent keeps working. Reconnect anywhere and pick up exactly where you left off.
- **See everything from a browser.** A clean dashboard shows every workspace: what's running, what needs review, and what's committed. Attach to any live terminal from your laptop or your phone.
- **Review before you merge.** When an agent finishes, the workspace flips to *needs review* and pings you. Open the diff tab, review each changed file, and commit — no surprises landing in your code.

**Three things, once.**

1. **Install it on your server** (a $5 VPS is plenty — Kohlab is tiny, a few MB, no heavy infrastructure).
2. **Invite your team** (optional) — every member gets their own OS-isolated account; their agents run as them, so nobody can touch anyone else's data.
3. **Post a task.** Kohlab creates a clean, isolated workspace per task, launches the agent, and tells you when it's done.

That's it. No database to run, no containers, no desktop app to install. One small server, one browser tab.

```bash
kohlab new ~/my-project "fix the billing bug" claude
kohlab open
```

## Who it's for

Anyone who runs AI coding agents — developers, indie hackers, small teams — who wants their agents to run longer, run in parallel, and survive a flaky connection.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/nzkbuild/kohlab/main/install.sh | bash
```

That installs bun and git if they are missing, checks the repo out, builds the
dashboard, puts `kohlab` on your PATH, and creates + starts a systemd service.
Then:

```bash
kohlab status       # what is installed and what is running
kohlab open         # the dashboard URL for this machine
kohlab doctor       # dependencies, service, and the two things that break them
```

Options: `--no-systemd`, `--no-command`, `--key <secret>`, and the environment
variables listed by `bash install.sh --help`. Re-running it updates the checkout
and leaves your service, key and unit file alone.

## Daily use

`kohlab <command>`. Everything, on one screen, from any directory:

```bash
kohlab                                          # the command list
kohlab status                                   # installed, running, up to date?
kohlab create ~/my-project "fix the billing bug" claude
kohlab list                                     # what is running
kohlab start | stop | restart <id>
kohlab logs <id>                                # what the agent printed
kohlab diff <id>                                # review before you merge
kohlab commit <id> "message"
kohlab remove <id>
kohlab open                                     # the dashboard URL
kohlab update                                   # update kohlab — agents keep running
```

Names are standard, and the old ones still work as aliases:
`ls`=`list`, `new`=`create`, `rm`=`delete`=`remove`, `log`=`logs`,
`server`=`serve`, `install`=`doctor`.

`kohlab update` saves your uncommitted work to the stash first, and rolls the
checkout back if the new version fails to come up. Details:
[docs/upgrade.md](docs/upgrade.md).

## Releasing an update

Pushing is the release. There is no registry, no CI and no webhook:

```bash
# bump `version` in package.json, add the section to CHANGELOG.md, then:
git push origin main
```

Every instance running this repo then offers the update in **Settings → Updates**,
with the changelog above its own version as the release notes and one button to
take it. Agents keep running, and a release that fails to come up is rolled back
automatically. [docs/upgrade.md](docs/upgrade.md) has the details.

Full setup, systemd (auto-start on reboot), and every command are in docs/. How
the pieces fit together — the processes, the request path, and where the seams are
thin — is in [docs/architecture.md](docs/architecture.md).

## What's new in v1.10.0

- **Rebuilt frontend** — a researched, audited design system: OKLCH tokens in
  semantic tiers, every colour pair checked against WCAG 2.2 AA, zero hard-coded
  colours in components, dark-only with a real mobile drawer.
- **Shareable URLs** — `/workspaces`, `/w/<id>` and `/settings` are real routes:
  refresh keeps your place, links work, Back/Forward work.
- **Twelve backend defects fixed**, five of them crashing the server — including
  a `/diff` route that made review-before-merge unreachable, and a PTY daemon
  that was orphaned (losing every live agent) on each restart.
- **Review that tells the truth** — the diff pane now shows the actual change
  instead of the raw patch, new files are no longer hidden, and a clean
  workspace can be accepted out of the queue.
- **Reconnect honesty** — an explicit live/reconnecting/offline chip, backoff
  with jitter, and polling that stops while the tab is hidden.

Upgrading: add `KillMode=process` to your systemd unit first — see
[docs/upgrade.md](docs/upgrade.md) and [docs/systemd.md](docs/systemd.md).

Previous releases: v1.9.0 (the workbench), v1.8.0 (per-user OS isolation),
v1.7.0 (resource caps), v1.6.0 (users, roles, audit), v1.4.x (PTY + command
center).


**v1.10.0** — stable. Kohlab stays on the 1.x line through steady growth — the
major version only moves on a genuine breakthrough release. Evaluation and
redesign notes: `docs/EVAL-AND-REDESIGN.md`.
## License

MIT — free to use, modify, and self-host. Built for the community.
