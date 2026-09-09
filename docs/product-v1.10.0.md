# How to truly use Kohlab — product model (v1.10.0)

**Status:** planning
**Theme:** the usage model, not the paint. v1.9 (`docs/ux-v1.9.0.md`) gives Kohlab
one visual language; this plan gives it one *loop* — the thing a person
actually does from "task in head" to "committed and gone".
**Versioning:** 1.10.0. The 1.x line is home — a feature release stays on
1.x (CHANGELOG versioning philosophy); the major only moves on a
breakthrough release, and this plan is not one. It never goes 2.x.

---

## 1. The problem: README promises a loop the product doesn't finish

The README's punchline is "**Review before you merge** — a built-in diff view
shows exactly what each agent changed. Review, approve, and commit." That
loop is the reason Kohlab exists. Today:

| Promise | Reality |
|---|---|
| "See what each agent changed" | diff API returns **every** file (`DiffFile[]`); UI renders only `files[0]` |
| "Review, approve, commit" | one commit bar, no file list, no per-file review, no history |
| "What's running, what's done, what needs your attention" | running/stopped only — a finished agent and a crashed one look **identical** (same amber "done") |
| "Any device" | desktop-only posture; phone is a README sentence |
| "Clean isolated workspace for every task" | admin has path-based creation; members clone by URL — two models, one product |
| Launch-one-time story | v1.6–v1.8 added users/roles/isolation; the front door (README, onboarding) still tells the v1.4 story |

The gap is **model**, not styling. v1.9 paints the surfaces; this plan
completes the loop they serve.

## 2. The usage model

> **Kohlab runs tasks.** You post a goal, an agent works in an isolated
> clone, you watch it from the browser, you *review the diff*, you commit —
> done. The terminal is the window you watch; the diff is the moment of truth.

### The lifecycle (replaces running/done/stopped)

```
create ──► running ──► needs-review ──► committed
            │  │        (agent stopped,   │
            │  │         diff uncommitted)│
            │  └──► stopped              (clean stop)
            └──────► stopped (error) ──►  error in log
```

| State | Shown as | Means |
|---|---|---|
| `running` | emerald pulse | agent working — attach to watch |
| `needs-review` | **amber** | agent finished; diff present, uncommitted — **the action state** |
| `committed` | emerald flat | diff committed; nothing pending |
| `stopped` | zinc | clean stop / never started / empty |

Red stays reserved for destructive actions (v1.9 §1.2). Errors appear *in*
the log, not as a status color — except a `!` marker on stopped-with-error.

The dashboard's job changes from "history" to **triage**: a review queue
(needs-review first, then running, then everything else). "Done" without
commit stops being a dead end — it's a call to action.

## 3. The three jobs of a user

### Job 1 — Launch (post a task)
One create flow, role-aware: task + repo + agent + limits.
- Members: repo = GitHub picker or URL → `/api/clone` into their home (v1.8 already does this).
- Admin/owner: same, plus legacy path creation.
- CLI `kohlab new` already takes `<repo> <task> [agent]` — repo is URL or path; the web form should present it the same way, not as two workflows.

### Job 2 — Watch (glance, attach, get pinged)
- Glance: dashboard triage + activity feed (v1.9 §2).
- Attach: terminal (desktop); log tail is the lazy phone option.
- Ping: when a workspace flips running → needs-review, notify once.

### Job 3 — Decide (the moment of truth)
- Diff tab: **file list** → pick a file → per-file Monaco diff → commit bar.
- Commit or discard; discard = delete workspace (existing, confirm-gated).
- History (phase 2): audit already logs commits; a per-workspace "previous commits" list is derived data.

### Operator job (owner)
Invite (v1.8 provisions OS user in one step), caps per workspace (v1.7), audit tail (v1.6). Already built — this plan only surfaces it in onboarding copy.

## 4. Phase 1 — complete the loop (one release, smallest honest set)

1. **Per-file review.** `DiffView.tsx`: render the files the API already
   returns — changed-files list on the left, Monaco diff on the right,
   commit bar unchanged. Pure frontend, highest-leverage line in the product.
2. **Attention state.** Add `lastCommitAt?` to the workspace record
   (server + `web/src/types.ts`); derive status in the store:
   stopped && diff && no commit-after-stop → `needs-review`. Sidebar badge,
   cockpit header, dashboard review queue; v1.9's status semantics updated
   (amber = needs-review, zinc = stopped).
3. **One create flow.** Web create form becomes task + repo (URL/GitHub/
   admin-path) + agent + limits, role-aware; remove the path/URL split from
   the mental model (keep both inputs, label by role).
4. **Done ping.** `Notification` API + `document.title` flash when
   running → needs-review; toggle in Settings. No deps, no push service.
5. **Front door rewrite.** README's "who it's for / how it works" and the
   onboarding wizard copy updated to the real product: install → first user
   → invite → task loop. Fix the stale v1.4.1 section.

## 5. Phase 2 — make it feel effortless (after phase 1 lands)

- **Agent setup in the terminal** — after `install`, run `setupCmd` inside
  the workspace, show "waiting for you to sign in…" instead of a copy button.
- **Phone posture** — dashboard + review-first responsive pass: glance and
  decide on a phone, heavy terminal stays desktop.
- **Commit history** — per-workspace previous commits (derived from audit),
  diff-between-commits.

## 6. Explicitly not building (`ponytail:`)

- No OIDC/SSO — add when teams actually ask for it (roadmap consistently says out of scope).
- No bwrap/containers — isolation.md names this as the next rung only if "trusting team" stops being true.
- No mobile app / push infra — Notification API + responsive pass covers the promise; add infra when a user lives on iOS Safari all day.
- No progress/kanban boards — the task lifecycle *is* the progress display; add when tasks need sub-steps (agent-native todo, not a UI board).
- No per-task spend quotas — caps (v1.7) first; budgets when agents cost real money in one session.

## 7. Relationship to v1.9

v1.9 = visual language + surface inventory (the paint). This plan = the
usage model (the floor plan). One editorial change to `docs/ux-v1.9.0.md`:
status semantics — **amber means needs-review**, not generic "done";
zinc means stopped-clean. Everything else in v1.9 stands.

## 8. Definition of done (phase 1)

- [ ] Diff tab lists every changed file; per-file review; commit stays one click
- [ ] Workspace derives status: running / needs-review / committed / stopped; dashboard shows a review queue
- [ ] Members create via URL/GitHub only; admin path creation documented as legacy
- [ ] Done-ping on running → needs-review (Notification API + title flash, toggleable)
- [ ] README + onboarding copy match the real flow
- [ ] `tsc --noEmit` + `vite build` + one smoke test (create → run → diff → commit)
- [ ] CHANGELOG v1.10.0, bump, tag, push