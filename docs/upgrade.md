# Upgrade

Kohlab has no self-updater; upgrades are `git pull`.

```bash
cd /root/kohlab
git pull
bun install                # backend (node-pty is pinned)
(cd web && bun install)    # frontend deps, if changed
(cd web && bun run build)  # rebuild the dashboard
```

If running under systemd, restart it:

```bash
sudo systemctl restart kohlab
```

## Before you upgrade

- Workspaces and state live in `.works/` (gitignored). `git pull` does not
  touch it, but back it up if it matters:
  ```bash
  tar czf kohlab-works-$(date +%Y%m%d).tgz .works
  ```
- Running agent sessions are owned by the PTY daemon and survive a
  server restart; verify with `kohlab ls` after the upgrade.

## Version check

The current version is in `package.json` (`version` field) and `CHANGELOG.md`
at the top.
