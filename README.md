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
- **See everything from a browser.** A clean dashboard shows every workspace: what's running, what's done, and what needs your attention. Attach to any live terminal from your laptop or your phone.
- **Review before you merge.** A built-in diff view shows exactly what each agent changed. Review, approve, and commit — no surprises landing in your code.

## How it works

**Three things, once.**

1. **Install it on your server** (a $5 VPS is plenty — Kohlab is tiny, a few MB, no heavy infrastructure).
2. **Point it at your project.** Kohlab creates a clean, isolated workspace for every task.
3. **Tell it which agent to run.** Launch any agent CLI in a workspace, then go. Check in from any browser.

That's it. No database to run, no containers, no desktop app to install. One small server, one browser tab.

```bash
kohlab new ~/my-project "fix the billing bug" claude
kohlab open
```

## Who it's for

Anyone who runs AI coding agents — developers, indie hackers, small teams — who wants their agents to run longer, run in parallel, and survive a flaky connection.

## Get started

```bash
# 1. Install the CLI (requires bun + tmux + git on your server)
curl -fsSL https://bun.sh/install | bash
sudo apt-get install -y tmux git

# 2. Clone and run
git clone https://github.com/nzkbuild/kohlab.git
cd kohlab
bun run cli.ts server

# 3. Open the dashboard from your laptop
ssh -L 7676:localhost:7676 user@your-server
# → http://localhost:7676
```

Full setup, systemd (auto-start on reboot), and every command are in docs/.

## Project status

**v1.0.0** — a solid baseline. We ship disciplined, semantic releases; see CHANGELOG.md. Kohlab stays on the 1.x line through steady growth — the major version only moves on a genuine breakthrough release.

## License

MIT — free to use, modify, and self-host. Built for the community.
