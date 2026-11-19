# Backup and restore

Kohlab keeps everything a project needs in its state directory (`$WORKS_DIR`,
`/root/.kohlab` by default). A backup is one archive that holds it all, and
every archive is checked before anyone trusts it.

## What an archive holds

| In the archive | What losing it costs |
| --- | --- |
| `state.json` | Every workspace record: what it was asked to do, which agent, limits, share links |
| `users.json` | Every member account and role. Keys are hashes, so a restore restores the same keys |
| `audit.log` | The mutation history |
| `key` | The generated access key, when the server made one. Only in archives you make with `kohlab backup`; the daily archives (downloadable from Settings) leave it out |
| `vapid.json`, `push.json` | The push key and the phones subscribed to it |
| `ws/<id>/repo.bundle` | The project's repository: every branch and commit (`git bundle --all`) |
| `ws/<id>/tree.tar` | The working tree, **uncommitted work included** |
| `ws/<id>/brain.tar` | The project brain: its notes |
| `ws/<id>/images.tar` | Pasted screenshots |
| `ws/<id>/chats/` | The chat logs and their menus, one set per conversation |
| `meta.json` | What is inside, the size of each part, and what was left out on purpose |

A new chat project is an empty git repository under `projects/` with no remote.
Until now, the builder's work existed nowhere else. The archive is the only copy
unless you take one off the machine (see below).

## What is NOT in an archive

- `accounts/secrets.json`: the router keys. Never in an archive, with or without `--with-logins`.
- The AI sign-in folders under `accounts/`: the logins themselves.
- `accounts/accounts.json` (the account list, no secrets) only with `--with-logins`.
- Inside a tree: `.git`, `node_modules`, `dist`, `build`, `.next`, `.cache`, `.venv`,
  `__pycache__`, `target`. These are rebuilt by tools, not work.
- Links that point outside their tree, and single files over 50 MB. Both are counted
  in the workspace's `skipped` record in `meta.json`, so a backup never hides them.

`meta.json` lists these exclusions in its `includes` section, so an archive says
what it leaves out.

## Backup

```bash
kohlab backup                              # ./kohlab-2026-11-19.tar.gz
kohlab backup /backups/kohlab.tar.gz
kohlab backup /backups/kohlab.tar.gz --verify    # check it straight after
kohlab backup /backups/kohlab.tar.gz --no-projects   # state only, no repositories or trees
kohlab backup /backups/kohlab.tar.gz --with-logins   # adds the account list
```

It works while the server runs. The archive is built beside the target, written
to a temp file, and renamed into place, with mode 0600. An empty repository is
recorded as empty, not as an error. A repository that Kohlab cannot read fails
the backup and names the workspace.

## Verify

```bash
kohlab backup verify /backups/kohlab.tar.gz
# 12 projects, 3 chats, all verified
```

Verify extracts the archive to a throwaway folder (0700) and checks it: the
archive's entries are only the names Kohlab writes, `meta.json` matches the state
file, every `repo.bundle` passes `git bundle verify` and fetches every object
into a scratch repository, every tree, brain and image tar lists and matches its
recorded size and entry count, and every chat log parses. It prints the problems
and exits non-zero if there are any. Nothing in the state directory changes.

## Restore

```bash
kohlab restore /backups/kohlab.tar.gz --dry-run   # what it would do, changes nothing
kohlab restore /backups/kohlab.tar.gz
kohlab restore /backups/kohlab.tar.gz --projects  # also replace existing workspace folders
```

Restore checks the whole archive before it changes anything: a path that goes
up (`../`), an absolute path, an unexpected name, or a link that leaves its
tree refuses the archive, and nothing is written.

- **State files** are moved aside (`<name>.before-restore-<time>`), never deleted.
  There is no merge.
- **A workspace whose folder already exists is kept** unless you pass `--projects`.
  With `--projects` its folder is moved aside the same way, then restored.
- **Each restored repository** is rebuilt from its bundle under the workspace
  (`<workspace>/repo`), with the workspace's branch as a worktree in `tree/`.
  Its record in `state.json` points there. The uncommitted tree files are laid
  over the checkout; nothing is deleted.
- **Brain, images and chats** are put back in their places. An existing chat log
  is moved aside before its copy is written.
- **Ownership** is set the way creating a workspace sets it (its member's OS
  account, or the agent's account with ACLs). This needs root; a non-root restore
  reports the workspace it could not fix.

Restart the server afterwards. State is read at startup.

Restoring `users.json` restores the member list *and* their keys, because only
hashes are stored. Anyone removed since the backup can sign in again with their
old key. A restore is a rollback of access as well as of data.

## The drill

Run it when you change anything in the backup, and before you rely on one:

```bash
node scripts/check-backup.mjs
```

It builds three throwaway workspaces (a path repo with commits and uncommitted
work, a project repo with an uncommitted file, a chat project with a brain note
and a chat log), backs them up, verifies, corrupts a copy of a bundle and
truncates another (both must fail verify), restores into a second empty
`WORKS_DIR`, and compares files, commits, brain and chat contents. It also
refuses hostile archives, checks that no secret reaches an archive, and checks
the daily job and the backup routes. It uses no AI and never touches a live
state directory.

## The daily job

The server backs up once a day by default, into `$WORKS_DIR/backups/`:

- `kohlab-YYYYMMDD-HHMMSS.tar.gz`, each verified before it is kept. A failed one is removed.
- `last.json` records the last run: when, which archive, its size, whether it
  verified, what it held, and the error if it failed.
- Only the newest **7** are kept. `KOHLAB_BACKUP_KEEP` changes that (minimum 2).
- Skipped, with the reason recorded, when free space is under three times the size
  of the last archive.
- Run at low priority (`nice`), in the background, never blocking the server. A
  failure never stops the server.
- Never hold the access key (`key`): the archives can be downloaded over HTTP. One
  backup runs at a time, across the CLI and the server (`$WORKS_DIR/.backup.lock`).
- Restore refuses an archive whose member names, links, sizes or ids look hostile, and
  recomputes every folder path from the workspace id instead of trusting the archive.

| Variable | Default | |
| --- | --- | --- |
| `KOHLAB_BACKUP_DAILY` | on | `0` turns the daily job off. Manual backups still work. |
| `KOHLAB_BACKUP_KEEP` | `7` | How many archives to keep (at least 2). |

Each run, and each deletion, is in the audit log as `backup.auto`, `backup.run` or
`backup.delete`. The owner sees the same status in Settings → Backups, and can
download or delete archives there. The routes are owner only, and a share link
cannot reach them.

## Off the machine

A backup on the same disk does not survive the disk. `scripts/backup-offbox.sh`
makes an archive, verifies it, and copies it to another machine, over `rsync`
(ssh) or `rclone`. A copy that does not verify is never sent.

```
KOHLAB_BACKUP_DEST=you@other-host:backups/kohlab/ bash scripts/backup-offbox.sh
KOHLAB_BACKUP_VIA=rclone KOHLAB_BACKUP_DEST=myremote:kohlab bash scripts/backup-offbox.sh
```

To run it nightly with systemd (adjust the path and destination):

```
# /etc/systemd/system/kohlab-backup.service
[Service]
Type=oneshot
Environment=KOHLAB_BACKUP_DEST=you@other-host:backups/kohlab/
ExecStart=/bin/bash /root/kohlab/scripts/backup-offbox.sh

# /etc/systemd/system/kohlab-backup.timer
[Timer]
OnCalendar=daily
Persistent=true
[Install]
WantedBy=timers.target
```

Then `systemctl enable --now kohlab-backup.timer`. The root account needs an ssh
key that the other machine accepts. Nothing is pushed anywhere automatically:
the schedule is yours to set. Archives pile up on the other machine until you prune them there.

## Audit log rotation

`audit.log` grows forever otherwise. Kohlab rolls it when it passes 8 MiB
(roughly 40,000 events), keeping three rolled files:

```
audit.log        the current log
audit.log.1      the previous one
audit.log.2
audit.log.3      the oldest kept
```

Tune it with `AUDIT_MAX_BYTES` and `AUDIT_KEEP` in the service environment. The
roll is best-effort: if it fails, Kohlab keeps appending. Losing old history is
bad; refusing to record new events is worse. Each roll writes an `audit.rotated`
event into the new log, so a gap in the file is explained rather than mysterious.

## Older archives

Archives from earlier versions (the four state files only) still restore. They
hold no projects, so restoring one brings back the state, not the work.
