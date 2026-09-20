# Upgrade

**Publishing a release is a push.** Nothing else — no registry, no CI, no webhook.

```bash
# in your checkout of this repo, on your machine
#   1. bump `version` in package.json
#   2. add the section to CHANGELOG.md
git commit -am "feat: v1.12.0 — ..."
git push origin main
```

Every instance running that repo now sees it in **Settings → Updates**: the
published version, the changelog for exactly the gap being closed (everything
above its own version's heading), and one button to take it. `kohlab update` does
the same thing from a terminal.

## Over the air, from the dashboard

- The server checks the upstream branch for new commits (cached for
  `RELEASE_CHECK_TTL`, default 5 minutes; the panel's re-check forces it). The
  dashboard needs to reach `origin` — that is the only requirement.
- Applying an update is an **owner** action and is written to the audit trail.
  Without credentials the endpoint answers 401; with the wrong role, 403.
- The run outlives its own restart: the reload kills the server that started the
  update, so the script records `started … pid …` and `finished … exit …` markers
  in `$WORKS_DIR/update.log` and the panel reads the outcome back from there.
  A run that stops without finishing is shown as unfinished, with its log.

```bash
kohlab update           # or: bash scripts/update.sh
kohlab update --check   # say what would happen, change nothing
```

**Running agents are not interrupted.** Workspaces are separate git worktrees
with their own branches, so no step here touches an agent's files. The reload
restarts only the server process; the detached PTY daemon — and every live
session — keeps running, which is what `KillMode=process` in the unit is for.

One command, six steps:

| Step | What it does |
| --- | --- |
| **save** | uncommitted changes go to the stash (HEAD never moves), and commits that were never pushed are pushed. |
| **check** | fetches, and stops if there are no new commits behind upstream. |
| **download** | backs up the state files, then fast-forwards the checkout. |
| **install** | `bun install`, then `cd web && bun install && bun run build`. |
| **reload** | `systemctl restart kohlab`, then polls `http://127.0.0.1:$PORT/` until it actually answers — `is-active` alone is not proof, since `Type=simple` marks the unit active the moment the process forks. |
| **rollback** | if install, build or reload fails, the checkout returns to the commit it started from, is rebuilt, and is reloaded — so the known-good version is the one serving. |

Versioning lives in `package.json`. What counts as an update is always *commits
behind upstream* — never a version string — and a downgrade is refused, because a
lower upstream version means you are ahead, not that you are behind.

It also refuses a reload when the unit's `KillMode` would kill the detached PTY
daemon and every live agent session with it. Fix the unit (see
[systemd.md](systemd.md)) or pass `--force` to accept the loss.

## Your work first

`kohlab update` will not discard anything. Uncommitted changes are stashed before
anything is downloaded:

```bash
kohlab update            # prints: recover your work with: git stash pop
git stash pop            # may need conflict resolution against the new code
```

It stashes rather than committing to a side branch for a reason: a new workspace
is branched from wherever `HEAD` points, so moving `HEAD` mid-update could hand a
newly created agent the wrong base.

## Before you upgrade

- **Back up the right directory.** Workspaces and state live in the directory the
  server was started with as `WORKS_DIR` — **not** necessarily the repo-local
  `.works/`. The updater backs up `state.json`, `users.json` and `audit.log`
  itself, from wherever the unit says `WORKS_DIR` is. For a full copy, read that
  path from the unit:

  ```bash
  # systemd: read it from the unit. Note that systemd merges every
  # Environment= line into ONE line, so match WORKS_DIR= anywhere on it.
  WORKS_DIR=$(systemctl show kohlab -p Environment | sed -n 's/.*WORKS_DIR=\([^ ]*\).*/\1/p' | tail -1)
  echo "$WORKS_DIR"

  tar czf kohlab-works-$(date +%Y%m%d).tgz -C "$(dirname "$WORKS_DIR")" "$(basename "$WORKS_DIR")"
  ```

  `git pull` never touches it either way.

- **Running agent sessions survive a restart of the *server* — but only if the
  daemon is left alive.** The PTY daemon is detached and holds every live
  session, and the server adopts it on start. systemd's default
  `KillMode=control-group`, however, signals the whole unit cgroup, so
  `systemctl restart kohlab` kills the daemon too and every live agent with it.
  Set `KillMode=process` (see [systemd.md](systemd.md)); the updater refuses to
  reload without it. Verify with `kohlab ls` either way.

- **Restarting the daemon itself always ends every live session**, since the
  PTYs are its children. Do that only when you accept losing running agents.
  Any workspace whose session is gone is reported as stopped and can be started
  again.

## Doing it by hand

```bash
cd /root/kohlab
git pull --ff-only
bun install                # backend (node-pty is pinned)
(cd web && bun install)    # frontend deps, if changed
(cd web && bun run build)  # rebuild the dashboard
sudo systemctl restart kohlab
```

## Version check

The current version is in `package.json` (`version` field) and `CHANGELOG.md`
at the top.
