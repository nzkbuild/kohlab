# Per-user isolation (v1.8)

Kohlab v1.8 turns one VPS into N safe users: every named member maps to a
real POSIX account, and their agents run *as that user* — so the OS, not just
the role check, keeps members out of each other's data.

## Model

| Layer | What enforces it |
|---|---|
| **Policy** (v1.6) | roles gate which API calls a user can make |
| **Resource** (v1.7) | per-workspace caps (`timeout`, `ulimit`) at spawn |
| **Data** (v1.8) | each member has an OS account (`koh-<user>`); agent sessions drop to that uid/gid with `$HOME=/home/<user>` |

A member's agent literally cannot `cat /home/<other-user>/...` or `ps`/kill
another member's sessions, because the kernel says so — the session is a
different OS user.

## What changes when you add a user

`kohlab user add alice` (or Settings → Team → add):

1. Creates the kohlab user (key shown once).
2. Provisions the OS account: `koh-alice`, uid from 10000+, `-U` private
   group, `$HOME=/home/koh-alice`, home + `~/.config` created `0700`.
3. Records `osUser`/`uid`/`gid`/`home` in `users.json`.

Sessions for Alice's workspaces are then spawned by the PTY daemon with
`uid`/`gid`/`home` set — the whole agent process tree runs as `koh-alice`.

## How workspaces work for a member

Members create workspaces from a **git URL** (the repo browser, or pasting a
URL). The server (root) does the git work, then the workspace is checked out
under the member's private tree:

```
/home/koh-alice/works/<workspace>/
├── admin/    # bare clone the server owns (durable object store)
├── tree/     # working tree, owned by koh-alice — the agent works here
└── images/   # pasted screenshots, readable by the agent
```

Because the whole tree is under a `0700` home owned by `koh-alice`, the agent
can read, write, and commit everything it needs — and nothing belonging to
anyone else.

Members cannot point a workspace at a host repo path: a path would live
outside their home (or inside someone else's). Only URL creation is available
to them, and the server clones as the acting member.

Legacy behavior is unchanged: anonymous/keyless installs and workspaces
created from host paths keep the old `$WORKS_DIR` layout with agents running
as the server user. Only provisioned members get isolation.

## Operator notes

- **Requires root.** The server provisions accounts with `useradd`/`userdel`.
  Non-root servers (dev boxes) skip provisioning and log a warning — members
  get the mapping but no OS account, and sessions run as the server user
  (same as legacy). You will see
  `not root; skipping OS-user provisioning for '<id>'`.
- **Uid range.** Members are allocated uids 10000–59999 (first free).
- **Agent installs are global.** Agents are installed once by an
  owner/member with OS access (v1.6 flow); each member's own agent config
  lives under their own `~/.config`.
- **Revoke.** `kohlab user rm alice` (or Settings → revoke) deletes the
  kohlab user **and** the OS account, home, and all of Alice's worktrees.
- **Naming.** OS usernames are `koh-` + slugified user id, capped at 24
  chars. Prefix configurable via `KOHLAB_OS_USER_PREFIX`.
- **Sharing.** Share links (`?share=`) still give anonymous read-only access
  to one workspace — including members' workspaces, if an owner shares one.
- **Caveat:** members share the machine's global state file and audit log.
  Data isolation is per-home, not per-namespace: an agent cannot *read*
  `users.json`, but the server itself still manages one state file.

## What isolation does NOT cover

- Agents run without `bwrap`/containers: no network or pid namespaces.
  A member's agent can still `ps` the whole host (though it cannot signal or
  read other users' processes' memory). If that stops being acceptable, the
  roadmap's next rung is `bwrap` per session.
- Cross-user quotas beyond per-workspace caps.
