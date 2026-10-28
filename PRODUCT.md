# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

In the order the product serves them:

- **The non-technical builder.** Someone with an idea (a small-business website, an
  RSVP page, a tool for a boring job) who uses Kohlab as an installed app, on
  their own server, to build it with Claude. The owner and a few friends they
  invite. They never see a terminal, a repository or a branch.
- **The developer or small team (secondary, legacy).** A developer with a VPS, or
  2-10 people sharing one box, who want agent infrastructure without a per-seat
  service. The terminal, files, log and review tools they were built for still
  exist for older projects, but they are no longer the main path.

All are the same install. The difference is one command (`kohlab user add`) and
whether per-user isolation matters.

## Product Purpose

Kohlab is a place to build things by talking to Claude, on a server you own.

You describe what you want. Claude builds it, and asks before any risky step
(creating or changing a file, running a command). You look at the preview, then
keep this version or undo it. Work keeps running when your laptop closes or your
phone screen sleeps, and you come back to it from any device.

Underneath, Claude's work stays on its own copy of the project until you keep it,
so nothing lands without a decision. What Kohlab refuses to be is a terminal
multiplexer or a code-review tool: the person in front of it should never need to
know either word.

## Positioning

Three mechanisms, which the alternatives do not combine:

1. **Sessions that outlive the connection.** A detached PTY daemon holds every
   agent. The web server can restart, be updated, or be killed without ending a
   single run.
2. **A review gate, not just a shell.** Every agent works in its own git worktree
   on its own branch, so finishing means *needs review*, not *done*. Nothing the
   agent did lands on your branch until you accept it, and accepting commits it
   where it is, on the agent's branch, not on yours.
3. **A team on one box, without containers.** Each member is a real OS account
   and their agents run as them. "Alice cannot read Bob's repositories" is
   enforced by the kernel, not by a role check or a promise.

Self-hosted, no database, no containers. Opens in a browser tab or as an installed app.

## Operating Context

**First run.** The installer generates the owner's access key on the box, and
`kohlab key` recovers it there. A new device signs in without retyping that
key: `kohlab pair` mints a short one-time code, and the browser trades it for
access. A server that is reachable is never keyless.

**Daily.** The loop is: describe what you want in Home or in a project's chat,
Claude builds it and asks before risky steps, you open the preview, then press
Keep this version or Undo. Projects that need an answer sit at the top of the
sidebar under Needs you; finished work waits under Ready to check. Developers
can still launch terminal agents, read diffs and merge. Above the message box a
single line always says which AI is working, with which account, model and mode, and what
it is doing; opening it shows the Run panel with its helpers, what it was told and what each
reply used.

**Team.** Teammates are *invited*, not handed a secret out of band: the owner
creates a single-use, expiring invite link (`/join#token`), Kohlab provisions
their account on the box, and they arrive with their own key, their own home,
and their own view of the work. Anyone can rotate their own key from Settings
→ Account. Revoking a member takes the account away again.

**Showing work.** Read-only share links expose one workspace's terminal, diff and
log to someone outside the team, never a life-cycle action, never a commit.

## Capabilities and Constraints

Shipped and claimed:

- Persistent PTY agent sessions that survive browser, SSH and server restarts.
- Workspaces: isolated git worktrees, run in parallel, with terminal, files,
  diff, log, life-cycle actions, and a review gate: accept (commit on the
  agent's branch), discard, and merge into your checkout from the dashboard or
  `kohlab merge`, which refuses a dirty tree and aborts cleanly on conflict.
- Named users with roles (owner / member / viewer), invite links, one-time
  keys, device pairing codes, self-service key rotation, revocation, and an
  append-only audit trail.
- Per-member OS accounts (`koh-<user>`, uid 10000+): agents run as that user, and
  their worktrees live under a `0700` home.
- Per-workspace resource caps: wall clock, memory, process count.
- Owner-only over-the-air updates, with the changelog for exactly the version
  gap being closed, and a rollback that reloads the known-good build.
- Browser terminals, including additional sessions per workspace.
- Share links, image paste, agent install/status, GitHub repository browsing.
- A `kohlab` command for all of it, from any shell.
- One place for your AI helpers: Settings → AI shows every AI on this computer, whether it is signed in, which account, how much of its plan is used and when that resets, and which models it offers. Model menus list only AIs that are signed in.
- Control the AI: choose defaults for new projects; add another Claude account or a router address; set the mode per project (Asks first, Edits allowed, Auto, Full access, Plan first), save "Always allow" rules and take them back; send one message on another model; and set what happens when an AI reaches its limit (carry on with another account or a cheaper model, then come back). The AI, account, model, mode and any one-off model stay in view in the run strip.

Constraints, stated plainly rather than discovered by a user:

- Agents are not namespaced. There is no `bwrap` or container per session yet, so
  a member's agent can still `ps` the whole host, it cannot read or signal
  another member's processes, but it can see that they exist.
- Member OS accounts need root to provision. Without it, members share the
  server's user and only the role check separates them.
- One shared state file and audit log; isolation is per-home, not per-namespace.
- Merging from the dashboard only targets the workspace's own checkout. A
  workspace created from a URL (an isolated member's) has no checkout on the
  server, so its merge is `kohlab merge <id> --into <checkout>`, run as that
  member.
- Full access means the AI never asks: it can change and delete anything it can reach, and runs commands as the server's own account unless the owner has set up a smaller one. Only the owner can turn it on, and it asks once in plain words first.
- Another Claude login is signed in once inside Kohlab and kept only on the server; a router key is stored on the server and can never be shown again.
- The AI hub reads the server owner's AI accounts. Members see which AIs are ready and their models, not the owner's email, plan or usage. An AI that a member runs under their own computer account may be signed in differently from what the hub shows.
- Claiming an unclaimed server from the browser is designed, not built
  (`ROADMAP.md`); the owner key comes from the installer.

## Brand Commitments

- Product name: Kohlab.
- Calm, friendly, plain English; consumer-grade like Claude desktop. Not a
  landing page, not an instrument panel. The one deliberate exception is the AI: its account, model, mode, helpers and usage are always visible, in plain words, with two quiet meters and no gauges.
- Plain language in every string a user reads: no commits, branches, diffs,
  repositories or agents in the main path.
- No invented metrics, customers, benchmarks or pricing claims.

## Evidence on Hand

- Documentation: README.md, PRODUCT.md, docs/ (install, upgrade, systemd,
  isolation, security, resource limits, frontend contract).
- The implementation: web/src, server.ts, lib.ts, pty-daemon.cjs.
- A runnable check suite (`bun run check`) is the evidence behind every
  behavioural claim above; `ROADMAP.md` maps which claim each check covers. Anyone who clones the repo can reproduce it.

## Product Principles

1. Show what is happening now before explaining the system. The AI's state is always in view: who is working, with which account and model, and what it is doing.
2. Make "what needs me" the center of gravity: questions first, then work ready to check.
3. Preserve work through disconnects without making persistence feel complex.
4. Keep destructive and irreversible actions explicit.
5. Prefer calm, legible surfaces with one clear main action over decorative chrome.
6. Nobody arrives uninvited: access is granted by the person who owns the
   server, never by being first to reach the port.

## Accessibility & Inclusion

Preserve keyboard focus, visible focus rings, semantic controls, readable
contrast, responsive layouts for laptop and phone, text labels for critical
actions, and status that is never colour-only.
