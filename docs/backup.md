# Backup and restore

## What is worth backing up

Everything Kohlab knows lives in its state directory (`kohlab status` prints it;
`$WORKS_DIR`, `/root/.kohlab` by default):

| File | What losing it costs |
| --- | --- |
| `state.json` | Every workspace record: what each one was asked to do, which agent, limits, share tokens |
| `users.json` | Every member account and role. Keys are hashes, so a restore restores the *same* keys |
| `audit.log` | The mutation history |
| `key` | The generated access key, when the server made one |

**Your actual code is not in there.** Each workspace is a git worktree or a bare
clone of a repository that lives somewhere else. Back that up the way you already
back up your repositories. A backup of the state directory restores *what Kohlab
was doing*, not the work itself.

`state.json` alone is usually enough to make sense of an installation after a
loss. It is also the one file whose corruption stops the server — it is read at
startup and refused loudly if unparseable, deliberately: a half-read fleet is
worse than a refusal.

## Backup

```bash
kohlab backup                        # ./kohlab-2026-09-20.tar.gz
kohlab backup /backups/kohlab.tar.gz
```

The archive contains the four files above, and is written with `tar` so it opens
with anything. The command works while the server is running — every one of those
files is either written atomically or appended to, so a copy taken mid-write is
either the old version or the new one.

Move it off the box. A backup on the same disk as the thing it protects is a
backup against one failure mode out of several.

## Restore

```bash
kohlab restore /backups/kohlab.tar.gz
```

The current files are **moved aside**, not deleted — each becomes
`<name>.before-restore-<timestamp>` in the state directory. There is no merge: a
restore replaces. If you restore the wrong archive, the previous state is still
there; move it back.

Restart the server afterwards. State is read at startup, so a running server
keeps serving what it already has in hand.

Restoring `users.json` restores the member list *and* their keys, because only
hashes are stored. Anyone who was removed since the backup can sign in again with
their old key — a restore is a rollback of access as well as of data, which is
worth knowing before doing it on a live box. Their OS accounts are not recreated
by a restore; a member whose account was removed gets a key that works and no
workspace.

## Audit log rotation

`audit.log` grows forever otherwise. Kohlab rolls it when it passes 8 MiB
(roughly 40,000 events), keeping three rolled files:

```
audit.log        the current log
audit.log.1      the previous one
audit.log.2
audit.log.3      the oldest kept
```

Tune it with `AUDIT_MAX_BYTES` and `AUDIT_KEEP` in the service environment, or
turn rotation into a retention policy of your own by shipping the log off the box
first. The roll is best-effort: if it fails, Kohlab keeps appending. Losing old
history is bad; refusing to record new events is worse.

Each roll writes an `audit.rotated` event into the new log, so a gap in the file
is explained rather than mysterious.
