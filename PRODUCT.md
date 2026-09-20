# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two, in the order the product serves them:

- **The solo operator with a VPS.** One developer, one box, several agents. Their
  complaint is the one Kohlab was built for: the session dies when the SSH
  connection does.
- **A small team sharing one box (2–10).** People who want shared agent
  infrastructure without a per-seat service, and without handing their repository
  to someone else's cloud.

Both are the same install. The difference is one command (`kohlab user add`) and
whether per-user isolation matters to them.

## Product Purpose

Kohlab is a self-hosted control plane for AI coding agents.

Agents run on a box you own, in a workspace you own, and they keep running when
your laptop closes, your SSH drops, or your phone screen sleeps. You attach from
any browser to see what they did and decide what to keep.

What it refuses to be is a terminal multiplexer. `tmux` keeps a session alive and
stops there — no review, no isolation, no account for the second person. Kohlab
keeps the session alive and then closes the loop: the agent's work arrives as a
diff on its own branch, and accepting it is a decision you make.

## Positioning

Three mechanisms, which the alternatives do not combine:

1. **Sessions that outlive the connection.** A detached PTY daemon holds every
   agent. The web server can restart, be updated, or be killed without ending a
   single run.
2. **A review gate, not just a shell.** Every agent works in its own git worktree
   on its own branch, so finishing means *needs review*, not *done*. Nothing the
   agent did lands on your branch until you accept it — and accepting commits it
   where it is, on the agent's branch, not on yours.
3. **A team on one box, without containers.** Each member is a real OS account
   and their agents run as them. "Alice cannot read Bob's repositories" is
   enforced by the kernel, not by a role check or a promise.

One browser tab, self-hosted, no database, no containers, no desktop app.

## Operating Context

**First run.** The server is *unclaimed*. The person who installed it claims it
from the machine itself and becomes its owner, with an access key. Nobody else
can claim it, and an unclaimed server grants nothing to a stranger who reaches
the port.

**Daily.** The owner creates a workspace from a repository, launches an agent,
watches its terminal from a laptop or phone, disconnects, comes back, reads the
diff, and accepts or discards it. Workspaces queue up as *needs review* until
they are dealt with.

**Team.** Teammates are *invited*, not handed a secret out of band: Kohlab
provisions their account on the box, and they arrive with their own key, their
own home, and their own view of the work. Revoking them takes the account away
again.

**Showing work.** Read-only share links expose one workspace's terminal, diff and
log to someone outside the team — never a life-cycle action, never a commit.

## Capabilities and Constraints

Shipped and claimed:

- Persistent PTY agent sessions that survive browser, SSH and server restarts.
- Workspaces: isolated git worktrees, run in parallel, with terminal, files,
  diff, log, life-cycle actions, and a commit gate.
- Named users with roles (owner / member / viewer), one-time keys, revocation,
  and an append-only audit trail.
- Per-member OS accounts (`koh-<user>`, uid 10000+): agents run as that user, and
  their worktrees live under a `0700` home.
- Per-workspace resource caps: wall clock, memory, process count.
- Owner-only over-the-air updates, with the changelog for exactly the version
  gap being closed, and a rollback that reloads the known-good build.
- Browser terminals, including additional sessions per workspace.
- Share links, image paste, agent install/status, GitHub repository browsing.
- A `kohlab` command for all of it, from any shell.

Constraints, stated plainly rather than discovered by a user:

- Agents are not namespaced. There is no `bwrap` or container per session yet, so
  a member's agent can still `ps` the whole host — it cannot read or signal
  another member's processes, but it can see that they exist.
- Member OS accounts need root to provision. Without it, members share the
  server's user and only the role check separates them.
- One shared state file and audit log; isolation is per-home, not per-namespace.
- Accepting a workspace commits on the agent's branch. Getting that into your own
  branch is still a manual merge.
- Claiming and invitation links are designed, not built (`ROADMAP.md`).

## Brand Commitments

- Product name: Kohlab.
- Calm, precise, developer-native, operational — an instrument panel, not a
  landing page. The v1.10 frontend is the standard, not a one-off.
- Plain language in every string a user reads.
- No invented metrics, customers, benchmarks or pricing claims.

## Evidence on Hand

- Documentation: README.md, PRODUCT.md, docs/ (install, upgrade, systemd,
  isolation, security, resource limits, frontend contract).
- The implementation: web/src, server.ts, lib.ts, pty-daemon.cjs.
- A runnable check suite (`bun run check`, 10 checks) is the evidence behind every
  behavioural claim above. Anyone who clones the repo can reproduce it.

## Product Principles

1. Show what is happening now before explaining the system.
2. Make the review queue the center of gravity when agent work is ready.
3. Preserve work through disconnects without making persistence feel complex.
4. Keep destructive and irreversible actions explicit.
5. Prefer dense, legible operational surfaces over decorative chrome.
6. Nobody arrives uninvited: a server is claimed once, and access is granted by
   the person who owns it — never by being first to reach the port.

## Accessibility & Inclusion

Preserve keyboard focus, visible focus rings, semantic controls, readable
contrast, responsive layouts for laptop and phone, text labels for critical
actions, and status that is never colour-only.
