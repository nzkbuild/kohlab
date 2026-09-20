# Troubleshooting

Start here:

```bash
kohlab status      # version, unit, port, state dir, workspace counts
kohlab health      # is the pty daemon up? answers locally, no server needed
```

`kohlab health` exits non-zero when the daemon is down, so it is also a usable
probe from a monitoring script.

## The dashboard does not load

1. `systemctl status kohlab` — is the unit running?
2. `journalctl -u kohlab -n 50` — the server logs what it could not do.
3. `kohlab status` — does it say the port answers?

If the port answers but the page is blank, the dashboard build is missing or
stale. Rebuild it:

```bash
cd ~/kohlab/web && bun install && bun run build
```

## "every live session is gone with it"

That is the daemon, and the message is literal: the daemon owns the PTYs, so when
it dies, every running agent dies with it. Nothing can reconnect to them.

```bash
kohlab health            # DOWN confirms it
systemctl restart kohlab # the server starts a fresh daemon on the next pty operation
```

What survives: the workspaces, their branches, their commits, and each session's
log up to its last flush. What does not: the live terminal. Reopen a workspace and
the agent starts again with the same task.

Two things guard against this recurring: the server tells every open dashboard the
moment the socket closes, so the "running" chips do not keep lying, and
`daemon.down` lands in the audit trail with the time. A daemon that dies routinely
is a bug worth reporting — include `journalctl -u kohlab` around the timestamp.

## A workspace says running but nothing is happening

```bash
kohlab health                  # is the daemon up at all?
kohlab list                    # the server's view
kohlab logs <id>               # what the agent printed
```

`state.json` records what *was* started; only the daemon knows what is alive, and
that is where `/api/health` and the running count come from. A reboot is the usual
cause: the record says running, the process is long gone, and the log ends
mid-sentence.

## I lost the access key

It is recoverable on the box — it is never only in your head:

```bash
kohlab key            # prints it, and says where it came from
kohlab key rotate     # or replace it
```

Rotating invalidates the old key everywhere at once. Members rotate their own
from **Settings → Account**; that is the only way to change a member key without
an owner minting one.

## Locked out after too many wrong keys

Wait a minute. Twenty refused attempts from one address in a minute trip the
throttle, and it clears itself. A correct key still works during the window —
that is deliberate, so one address behind a shared NAT cannot lock out the others.

## "written by a newer kohlab"

The state file carries a schema version. A server told to read a file from a newer
build refuses to start rather than reading it with fields it does not understand
and writing it back without them. Update Kohlab, or move the file aside to start
with no workspaces.

## Restoring after a botched update

Updates roll back on their own if the new build fails its health gate — see
[upgrade.md](upgrade.md). If you need to get back to a known state by hand:

```bash
kohlab backup                    # first, always: the current state
git -C ~/kohlab log --oneline -5
git -C ~/kohlab checkout <the commit you were on>
systemctl restart kohlab
```

## Something is eating the disk

```bash
du -sh $(kohlab status | awk '/state dir/ {print $NF}') 2>/dev/null
du -sh ~/.kohlab/* 2>/dev/null | sort -h | tail
```

In order of how often it is the answer: workspace trees under a member's home
(real code, delete via the UI so the git bookkeeping goes with it), the audit log
(rotated at 8 MiB — see [backup.md](backup.md)), and uploaded images.

## Nothing here matches

`kohlab doctor` checks the environment rather than Kohlab itself: bun, node, git,
permissions, whether OS-user provisioning is possible. Include its output with any
bug report, along with `kohlab status` and the version.
