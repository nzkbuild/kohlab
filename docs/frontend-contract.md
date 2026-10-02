# Frontend contract: read before writing any component

This document is the design system's contract. It is a living document, not a
freeze. The rules in section 1 are binding and enforced by the checks in section 9.
The token, primitive and API inventories in sections 2 to 8 are the vocabulary:
use them rather than re-deriving the same layout in utilities.

## 0. A note on the earlier freeze, and why it was lifted

Earlier revisions of this file declared `index.css`, `ui.tsx`, `App.tsx`,
`Sidebar.tsx`, `store.ts`, `lib/*`, `api.ts` and `types.ts` frozen, and told the
reader not to run `tsc` or `vite build` because "files outside your ownership are
mid-rewrite".

That text was written for a parallel, multi-agent build of the v1.10 frontend. It
described a transient state that has not been true for several releases, and it
caused two concrete harms:

1. A defect that lived *inside* the frozen set (the collapsed sidebar could not be
   reopened, because its toggle was clipped by the rail's own `overflow: hidden`)
   could not be fixed without violating the document. The rule protected the bug.
2. It told contributors not to verify. The failure mode here is a plausible small
   diff that was never typechecked.

The freeze is therefore lifted. What replaces it is stricter, not looser: **the
foundation may be edited, and any edit must keep every check in section 9 green.**
A change to a token, a primitive or the shell is a change to every surface that
consumes it, so it carries the burden of proving it did not regress the rest.

If you are changing the foundation, say so in the commit message and name which
surfaces you re-verified.

---

## 1. Rules that are not negotiable

1. **No colour literals.** Never write `#0a0a0a`, `bg-[#111113]`, `text-zinc-400`,
   `bg-emerald-400`, `border-[#27272a]`. Every colour comes from a semantic token
   (Tailwind utility or one of the `.panel` / `.btn` / `.chip` classes below).
   A utility that resolves to no token produces no CSS and fails silently: that is
   how `text-danger-strong` rendered an error in the body text colour for several
   releases. If you invent a colour utility, confirm it compiles.
2. **No interpolated class names.** `` className={`text-status-${x}`} `` produces no
   CSS, Tailwind cannot see it. Use the static maps in `lib/status.ts`.
3. **Animate only** `transform`, `opacity`, `background-color`, `color`,
   `border-color`. Never `width`, `height`, `top`, `left`, `margin`. The one
   surviving exception is `.sidebar`, which animates `width` and `flex-basis`;
   `.app-shell` is a flex row, so collapsing the rail reflows the terminal pane on
   every frame. Making the shell a grid and transitioning `grid-template-columns`,
   or overlaying the rail and animating `transform`, is the fix when someone owns
   the time.
4. **Borders, not shadows, for anything load-bearing** (`box-shadow` is deleted
   under `forced-colors`). Radix dialogs may use a shadow purely as depth.
5. **Never `height` on a text-bearing container**, use `min-height` + padding, so
   the WCAG 1.4.12 text-spacing overrides cannot clip it.
6. **Status is never colour-only.** Always label or glyph it (`StatusChip` does both).
7. **Touch targets ≥ 24×24 CSS px** (use `Button iconOnly`, which enforces it).
8. **Motion is already globally reduced-motion-gated** in `index.css`; do not add
   ungated animations.
9. Use real elements (`<button>`, `<input>`, `<table>`), never `<div role="button">`.
10. No new dependencies. No `useEffect` for anything derivable during render.
11. **A control must be clickable in every state it renders in.** If a container
    sets `overflow: hidden`, assert that its content fits at the narrowest width
    the state produces. The collapsed sidebar shipped a control at x=60..88 inside
    a rail that ended at x=60, so it was painted nowhere and hit-tested nowhere,
    and the state persisted in localStorage. Anything focusable must also be
    visible: a control that is in the tab order but clipped is a WCAG 2.2 AA 2.4.11
    failure.
12. **One `h1` per route.** Surfaces render their own heading; the shell does not.

### Label casing

Two systems, and they are deliberate:

- **Destinations and group headings are Title Case**: `Workspaces`,
  `Settings`, `Waiting for review`, the palette's `Views` / `Actions` groups.
- **Actions are lowercase sentence fragments**: `new workspace`, `commit`,
  `discard`, `retry`, `clear filters`, `copy link`, and busy states
  (`committing…`, `discarding…`).

Proper nouns keep their case either way. Before this rule the app had both systems
applied to actions at random, including within a single panel.

### Icon sizes

Icon size follows the control, not the taste of the call site:

| Context | Size |
|---|---|
| `Button size="sm"` (28px tall), including `iconOnly` | 13px |
| `Button` at default size (34px tall), including `iconOnly` | 14px |
| Pane-header glyph, status glyph, inline label | 15 or 16px |
| Nav rail row | 17 or 18px |
| Empty-state / display | 18 to 20px |

This exists because the same `+` glyph shipped at 16px, 15px and 13px in three
files, and a 28px button carried a 15px icon in one place and a 12px one in
another.

---

## 2. Semantic tokens (Tailwind utilities)

Surfaces: `bg-surface-base` (canvas) · `bg-surface-sunken` (terminal/code/log) ·
`bg-surface-raised` (panels) · `bg-surface-overlay` (dialogs) · `bg-surface-hover` ·
`bg-surface-active`

Text: `text-text-primary` · `text-text-secondary` · `text-text-muted` ·
`text-text-faint` · `text-text-on-accent`

Lines: `border-line-subtle` (dividers) · `border-line-strong` (control boundaries) ·
`border-line-accent`

Status: `text-status-running` `bg-status-running` · `-review` · `-committed` ·
`-stopped` · `-danger`; accent via `text-accent` / `bg-accent`

Type scale: `text-2xs` (11px) `text-xs` (12px) `text-sm` (13px) `text-base` (14px)
`text-lg` (16px) `text-xl` (20px) `text-2xl` (25px)

Radius: `rounded-sm|md|lg` · Font: `font-sans` (default) · `mono` class or `font-mono`

Breakpoint: `shell:` (≥900px). Use it for IA changes only, sidebar/drawer swaps,
table→list swaps. Use `@container` (`container-type` on `.pane`) for panel-level
adaptation.

Utility classes: `.mono` `.tnum` (tabular numerals, use on every counter,
timestamp and table column) `.eyebrow` `.kbd` `.sr-only` (built in)

Component classes (from `index.css`): `.panel` `.panel-head` `.panel-title` `.btn`
`.btn-sm` `.btn-icon` `.btn-primary` `.btn-secondary` `.btn-quiet` `.btn-danger`
`.field` `.field-label` `.field-input` `.field-select` `.field-help` `.chip`
`.chip-dot` `.chip-running|review|committed|stopped|danger` `.surface`
`.surface-inner` `.surface-title` `.surface-description` `.data-table` `.cockpit`
`.cockpit-head` `.tabstrip` `.tab` `.cockpit-body` `.terminal-wrap` `.log-line`
`.log-time` `.log-text` `.skeleton` `.dialog-overlay` `.dialog-content`
`.palette-item` `.split-view` `.file-row` `.row-actions` `.scrim` `.sidebar*`

Prefer these classes over re-deriving the same layout in utilities. In particular
`.cockpit-head` is the pane-header primitive: do not hand-roll
`flex min-h-10 items-center gap-2 border-b border-line-subtle px-3` again.

---

## 3. Primitives: `web/src/components/ui.tsx`

```tsx
<Button variant="primary|secondary|quiet|danger" size="md|sm" iconOnly
        aria-label={/* REQUIRED when iconOnly */} onClick={}>…</Button>

<StatusChip status={WorkspaceStatus} showGlyph? />          // label + glyph, never colour-only
<Chip tone="neutral|danger" />

<Panel className?><PanelHead title icon? meta? /> … </Panel>

<EmptyState icon? title description action? />              // first-run empties only

<Skeleton className /> <SkeletonRows rows? className? />     // reserve FINAL geometry

<Field label htmlFor help? error? >{control}</Field>
<Kbd>⌘K</Kbd>
<Announcer />                                                // mounted once in App
```

`ConfirmDialog` (`web/src/components/ConfirmDialog.tsx`) is the irreversible-action
confirm. Every irreversible action uses it: `delete workspace`, `revoke`, `commit`,
`discard` and `merge`. Name the specific object in `title` and `description`
(workspace id, branch, file count), never "this item". `tone="danger"` (the
default) is for actions that destroy work: delete, discard, revoke.
`tone="commit"` is for actions that are final but keep it: commit, merge. Accepting
good work must not look like deleting it.

---

## 4. State: `web/src/store.ts`

```ts
useApp(s => s.authed)                    // boolean
useApp(s => s.route)                    // Route (see below)
useApp(s => s.workspaces)               // Workspace[]  (server truth)
useApp(s => s.loading)                  // true only on the very first load
useApp(s => s.error)                    // string | null
useApp(s => s.lastUpdated)              // number | null
useApp(s => s.connection)               // "connecting"|"live"|"reconnecting"|"offline"
useApp(s => s.me)                       // { id, role, kind } | null  (null = not loaded yet)
useApp(s => s.refresh)                  // () => Promise<void>
useApp(s => s.navigate)                 // (Route, { replace? }) => void   pushes (or replaces) history
useCan()                                // { mutate, own }: mirrors the server's canMutate / isOwner
```

**Role-aware rendering.** A control the server would refuse for this role is not
rendered (or is replaced by a one-line reason). Gate on `useCan()`: `mutate` for
workspace life-cycle, create, commit/discard/merge and agent install; `own` for
updates and team management. The server remains the authority; this only stops
the UI offering what will fail.

**There is no `selectedId` / `view` / `select` / `setView` any more.** Navigation is
by route:

```ts
type Route =
  | { kind: "workspaces"; create?: boolean }          // "/" (home), "/new" opens the form
  | { kind: "workspace"; id: string; tab?: WorkspaceTab } // "/w/:id", "/w/:id/review"
  | { kind: "settings" }
  | { kind: "join" }
navigate({ kind: "workspace", id, tab: "review" })
```

Home is the review queue and then the full list; there is no separate dashboard.
A workspace with no tab in its URL opens on Review when it needs review, and on
Terminal otherwise.

---

## 5. Helpers

```ts
// lib/status.ts
workspaceStatus(w): WorkspaceStatus           // "running"|"needs-review"|"committed"|"stopped"
STATUS_LABEL, STATUS_GLYPH, STATUS_CHIP, STATUS_TEXT, STATUS_ORDER
byReviewFirst(a, b)                           // sort: review → running → committed → stopped
ActivityKind, ACTIVITY_CHIP

// lib/format.ts
relativeTime(ts) clockTime(ts) elapsed(from,to) byteSize(n)
diffStats(diff): {added,removed} | null       // null when not a parseable unified diff
memoryLabel(mb) timeoutLabel(sec)

// lib/announce.ts
announce(message)                             // coalesced; do NOT announce log lines

// types.ts
Workspace { id, repo, task, agent, created, started, stopped, running, path, share?, lastCommitAt? }
TreeNode { name, type: "dir"|"file", children? }
DiffFile { name, diff }
AGENT_CATALOG: AgentInfo[]
```

---

## 6. Backend API: `web/src/api.ts`

```
api.authRequired()      api.testKey(key)
api.workspaces()        api.create({task,repo?,agent,branch?,limits?})   api.clone({url,task,agent,limits?})
api.action(id, "start"|"stop"|"restart"|"delete"|"discard")   // POST /api/workspaces/:id/:action
api.diff(id)            // DiffFile[], includes NEW untracked files
api.commit(id, message) api.share(id)   api.files(id)  api.file(id, path)  api.log(id)
api.users() api.addUser({id,name,role}) api.removeUser(id) api.audit()
api.agentsStatus() api.installAgent(name, cmd) api.ghRepos()
api.uploadImage(workspaceId, blob)
api.release(force?)     // ReleaseStatus, published version, changelog, last run
api.applyUpdate()       // POST, owner only; starts the update, returns at once
```

`lib/actions.ts` exports `withToast(label, fn)` and `toastAction(id, action)`.
Prefer optimistic UI only for bounded single-object mutations; **never** for commit
or discard.

### The review gate

`commit` and `discard` are the two halves of the review decision and they are
mirrored on purpose:

- **commit** stages everything (`git add -A`) and commits it on the workspace's own
  branch `kohlab/<id>`. It is final: Kohlab cannot undo, amend or un-commit it.
  It is therefore behind a `ConfirmDialog`.
- **discard** is its inverse (`git reset --hard` plus `git clean -fd`, never `-fdx`,
  because ignored paths are the environment rather than the agent's work). It keeps
  the workspace, throws the changes away, and refuses while the agent is running,
  checked against the PTY daemon rather than a stored flag.

Both are never optimistic: the file list changes only after the server confirms.

---

## 7. Required states on every async surface

first-run empty ≠ filtered empty (only first-run may offer creation) · loading uses
`SkeletonRows` matching final geometry · error is a visible message with a retry ·
per-row hover actions must also appear on `:focus-within` (use `.row-actions`).

---

## 8. Accessibility specifics

- Icon-only controls need `aria-label`. `title` alone is not an accessible name.
- Tab strips: `role="tablist"` + `role="tab"` + `aria-selected`; arrow keys move
  focus. Tabs are `.tab` elements; give the strip `aria-label`.
- Dialogs: Radix `@radix-ui/react-dialog`, `.dialog-overlay` / `.dialog-content`.
  Focus is trapped and restored by Radix. Destructive dialogs must name the
  **specific** object (workspace id + path), never "this item".
- Announce state transitions with `announce()`, never log lines.
- Do NOT mark a terminal or log tail as a live region.
- The terminal/log must never yank the viewport: auto-follow only when already
  pinned to the bottom; otherwise show an "N new lines" affordance.
- Nothing may be focusable while clipped or off screen. This covers the mobile
  drawer (removed from the tab order with `visibility: hidden`) and any narrow
  layout that could push a control past an `overflow: hidden` ancestor.

---

## 9. Verification

Run these before calling frontend work done. They are fast, and they are the reason
the rules above are enforceable rather than aspirational.

```bash
bun run check                              # all checks, including backend contract
node scripts/check-a11y-static.mjs         # static markup accessibility scan
node scripts/check-contrast.mjs            # parses index.css tokens, checks WCAG ratios
node scripts/check-corruption.mjs          # the canary: corrupt state must fail loudly
cd web && npx tsc --noEmit                 # frontend types
```

`check-contrast.mjs` reads the token layer in `index.css`, and
`check-a11y-static.mjs` reads it for the focus rules, so a token or focus change is
verified by the suite rather than by eye. Neither check inspects rendered output:
reflow, focus visibility and clipping still need a browser.
