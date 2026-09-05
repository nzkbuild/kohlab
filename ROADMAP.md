# Roadmap — v1.7.0 → v1.8.0 — "Shared box, safe neighbors"

**Status:** planning (this doc)
**Theme:** Turn Kohlab from "one key, one user" into "one VPS, N safe users" —
resource isolation first, then true per-user data isolation.

---

## The problem, corrected

The goal is: **5 people, one VPS, each runs their own agents without touching,
starving, or leaking to each other.** The catch — confirmed by reading how
superset-sh/superset actually works — is that this is *two separate, hard
problems* that get conflated:

| Layer | Question | Superset's answer | Kohlab's answer today |
|---|---|---|---|
| **Policy** | *who may do what* | org members / host owners | v1.6 roles (owner/member/viewer) ✅ |
| **Resource** | *one agent can't starve the box* | ❌ none (one machine per person) | ❌ none |
| **Data** | *Alice can't read Bob's repos/keys* | ❌ none (separate machine per team) | ❌ none |

Superset solves multi-user by saying **"one machine per person, a relay stitches
them"** — a cloud-relay product (Elastic License, `sk_live` keys). Kohlab's
ethos is **self-hosted, one box, no database, no containers**. We keep that
ethos, which means we must build the two things Superset punts on.

---

## v1.7.0 — Resource caps (ship first, lower risk)

**Why first:** the most likely real failure with 5 people is *not* a breach —
it's one `npm test` gone wild pinning the CPU or OOM-killing everyone's agents,
including the server itself. Caps protect availability before we even talk
about secrecy.

### What

`Workspace` gains optional `limits` (`cpuSec?`, `maxMemoryMb?`, `maxProcs?`).
Applied at the single choke point every agent shell passes through:
`pty-daemon.cjs` `openSession()` → `pty.spawn(...)`.

### Mechanism (native first, no new deps)

| Resource | First cut | Upgrade path |
|---|---|---|
| Wall-clock | `timeout <secs>` wrapper around the agent cmd | — |
| Memory | `ulimit -v` in the shell env | cgroup v2 `memory.max` |
| Process count | `ulimit -u` | cgroup `pids.max` |
| CPU (fair share) | `nice` | cgroup `cpu.max` |

`timeout` + `ulimit` is the lazy correct 80%: one spawn-site change, works on
any Linux, no kernel probing. cgroup is opt-in behind `KOHLAB_USE_CGROUPS=1`
when teams need real per-agent *accounting*.

### Scope

- `limits` flows: CLI (`--max-mem`, `--timeout`, `--max-procs`) + create-workspace UI → workspace record → `openSession`.
- Kill path reuses the v1.4 process-tree kill; caps are additive.
- Surfaced in the workspace list ("512 MB / 10 min").
- `docs/resource-limits.md`.

### Definition of done

- [ ] `limits` CLI+UI → record → applied at spawn
- [ ] `while(1);` agent killed at timeout, tree cleaned
- [ ] `yes > /dev/null`-style allocator held under the memory cap
- [ ] defaults documented + cgroup flag
- [ ] CHANGELOG, bump, tag, push

---

## v1.8.0 — Per-user isolation (the real "own space, no leak")

**Why:** v1.6 roles are *policy*, not *isolation*. As long as all agents run
as one OS user (today: root), "Alice can't touch Bob's space" is a lie — any
agent shell reads `/root/.ssh`, `~/.config/claude`, every repo, because the OS
grants it. Roles gate *which API calls* a user makes; they do nothing when Bob's
agent literally runs `cat /root/.config/alice/key`.

### Threat model (what actually leaks today)

1. Bob's agent runs as root → reads Alice's repos, API keys, git credentials, SSH keys, the kohlab `state.json`/`users.json`.
2. Bob's agent writes to Alice's worktree, or deletes it.
3. Bob's agent kills Alice's PTY session (same OS user, same process tree).

### Fix: one OS user per member (not containers)

The honest fix that preserves "no containers":

- **Admin invites Bob** → provision **OS user `bob`** + `/home/bob` + scoped agent config (`/home/bob/.config/...`).
- **Sessions spawn as that user.** `openSession` (which already runs as root in the PTY daemon) wraps the spawn so the child runs with Bob's uid/gid/`$HOME` — via `setuid`/`su`. One spawn-site change, mirroring the v1.7 edit.
- **Each user owns their worktrees.** Workspaces grow an `ownerId`; the filesystem enforces it (directory perms), not just the role check.
- **Roles (v1.6) gate API actions; OS users gate file/data access.** Two layers, independent.

### Mechanism ladder (pick the lightest that holds)

1. **`su`/`setuid` + per-user `$HOME` + directory perms.** ~native. Covers the three leak points above for a trusting team. **This is the target for v1.8.**
2. **`bwrap` (bubblewrap) per session** — one small dep, adds namespaces (pid/fs/net) so a session can't even *see* other users' processes or `/home`. The upgrade path when "trusting team" stops being true.
3. **Docker/OCI per user** — strongest, but breaks kohlab's identity. Only if (2) proves insufficient.

### Scope

- `Workspace.ownerId` + `users.json` gains uid mapping.
- `openSession` runs the shell as the owner (uid/gid/`$HOME`).
- Worktree dirs created under `/home/<user>/works/` with `0700`.
- CLI/UI: admin "invite" does user + OS-user provisioning in one step; revoke removes the OS user.
- Audit already records who (v1.6); now the *files* are also actually theirs.

### Definition of done

- [ ] Two users, two agents: neither can `cat` the other's `$HOME` or repo
- [ ] Bob's agent cannot `ps`/kill Alice's session (setuid isolation)
- [ ] Revoke removes the OS user + their worktrees
- [ ] CHANGELOG, bump, tag, push

### Explicitly out of scope (still)

- Docker/OCI (until `bwrap` is proven insufficient)
- OIDC/SSO, cross-host relay (that's Superset's product, not kohlab's)
- Cross-user quotas/budgets (per-workspace caps first, v1.7)

---

## Order of work

1. **v1.7 caps** — availability, low risk, one spawn-site change.
2. **v1.8 isolation** — secrecy, one spawn-site change *again* (same choke point),
   plus provisioning. Builds directly on v1.7's `openSession` edit.

Both land in the **same place** — `openSession()` — which is the quiet signal
that "run the shell as X with limits Y" is fast becoming one configuration of
a single spawn primitive. That consolidation is worth watching: it may be that
v1.7 and v1.8 want to ship as one release ("spawn hardening").

## Decision needed before v1.8 build

The isolation model assumes **each member gets a real OS user on the VPS**.
That's a strong assumption for "5 teammates sharing one box":

- **Pro:** real isolation, each installs/updates their own agent, natural "own space."
- **Con:** members need OS accounts (SSH or admin-provisioned); it's no longer "paste a key and go."

Alternative worth a look before committing: **one shared repo, worktree-scoped
isolation only** (what Superset actually does) — reject it here explicitly
because you *want* true data isolation, but know that's the tradeoff being made.

This is the one open question. Everything else is mechanical.
