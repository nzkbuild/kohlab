# Uninstall

Uninstalling stops Kohlab. It does not delete anything you would want back.

```bash
sudo bash install.sh --uninstall     # or:
curl -fsSL https://raw.githubusercontent.com/nzkbuild/kohlab/main/install.sh | sudo bash -s -- --uninstall
```

It asks first, then:

| Step | What happens |
| --- | --- |
| The service | `systemctl disable --now kohlab` |
| The unit file | `/etc/systemd/system/kohlab.service` is removed, daemon reloaded |
| The command | `/usr/local/bin/kohlab` is removed (skip with `--no-command`) |
| The pty daemon | `pty-daemon.cjs` is stopped — nothing supervises it, so nothing else would |

**Kept:** your checkout (`~/kohlab`) and your entire state directory — every
workspace, member, and audit event. Re-running the installer brings it all back,
including the access key, because none of it was touched.

Say no at the prompt and nothing happens at all.

## What is not covered

Workspaces live in member homes (`/home/koh-<user>/`) and in your repositories,
not in the checkout. An uninstall does not remove OS accounts or homes — that is
`kohlab user rm <id>`, which is a deliberate act with its own confirmation, and it
takes a member's work with it.

## Removing everything

After the uninstall, by hand, and irreversible:

```bash
# Your workspaces and their git branches. In a legacy (path-repository) layout
# they are worktrees of YOUR repo — remove them with `kohlab workspace remove`
# instead, which cleans the git bookkeeping up as well.
rm -rf /root/.kohlab           # state, members, audit trail, key

# Member accounts and their homes
id -u koh-<user> >/dev/null 2>&1 && userdel -r koh-<user>

# The code
rm -rf ~/kohlab
```

Keep `state.json` if there is any chance you will come back: it is small, it is
readable, and it is the only record of what each workspace was asked to do.

Before removing anything, take an archive:

```bash
kohlab backup /somewhere/off-the-box/kohlab-final.tar.gz
```

See [backup.md](backup.md) for what that contains and how to put it back.
