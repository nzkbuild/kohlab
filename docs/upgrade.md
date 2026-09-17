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

- **Back up the right directory.** Workspaces and state live in the directory the
  server was started with as `WORKS_DIR` — **not** necessarily the repo-local
  `.works/`. Check which one your deployment actually uses:

  ```bash
  # systemd: read it from the unit
  systemctl show kohlab -p Environment | tr ' ' '\n' | grep WORKS_DIR
  # or, for a foreground server, whatever you exported when starting it
  ```

  Then back up *that* path. Backing up the default while your real state lives
  elsewhere silently protects nothing:

  ```bash
  WORKS_DIR=$(systemctl show kohlab -p Environment | tr ' ' '\n' | sed -n 's/^WORKS_DIR=//p')
  tar czf kohlab-works-$(date +%Y%m%d).tgz -C "$(dirname "$WORKS_DIR")" "$(basename "$WORKS_DIR")"
  ```

  `git pull` never touches it either way.

- **Running agent sessions survive a restart of the *server* — but only if the
  daemon is left alive.** The PTY daemon is detached and holds every live
  session, and the server now adopts it on start. systemd's default
  `KillMode=control-group`, however, signals the whole unit cgroup, so
  `systemctl restart kohlab` kills the daemon too and every live agent with it.
  Set `KillMode=process` (see [systemd.md](systemd.md)) if you want a restart to
  be session-preserving. Verify with `kohlab ls` after the upgrade either way.

- **Restarting the daemon itself always ends every live session**, since the
  PTYs are its children. Do that only when you accept losing running agents.
  Any workspace whose session is gone is reported as stopped and can be started
  again.

## Version check

The current version is in `package.json` (`version` field) and `CHANGELOG.md`
at the top.
