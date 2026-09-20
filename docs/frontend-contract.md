# Frontend contract (frozen) — read before writing any component

The design-system foundation is already written and **must not be modified**. This
document is the complete vocabulary available to surface components.

**Frozen — do not edit:** `web/src/index.css`, `web/src/components/ui.tsx`,
`web/src/store.ts`, `web/src/App.tsx`, `web/src/components/Sidebar.tsx`,
`web/src/lib/*`, `web/src/api.ts`, `web/src/types.ts`, `server.ts`, `lib.ts`.

---

## 1. Rules that are not negotiable

1. **No colour literals.** Never write `#0a0a0a`, `bg-[#111113]`, `text-zinc-400`,
   `bg-emerald-400`, `border-[#27272a]`. Every colour comes from a semantic token
   (Tailwind utility or one of the `.panel` / `.btn` / `.chip` classes below).
2. **No interpolated class names.** `` className={`text-status-${x}`} `` produces no
   CSS — Tailwind cannot see it. Use the static maps in `lib/status.ts`.
3. **Animate only** `transform`, `opacity`, `background-color`, `color`,
   `border-color`. Never `width`, `height`, `top`, `left`, `margin`.
4. **Borders, not shadows, for anything load-bearing** (`box-shadow` is deleted
   under `forced-colors`). Radix dialogs may use a shadow purely as depth.
5. **Never `height` on a text-bearing container** — use `min-height` + padding, so
   the WCAG 1.4.12 text-spacing overrides cannot clip it.
6. **Status is never colour-only.** Always label or glyph it (`StatusChip` does both).
7. **Touch targets ≥ 24×24 CSS px** (use `Button iconOnly`, which enforces it).
8. **Motion is already globally reduced-motion-gated** in `index.css`; do not add
   ungated animations.
9. Use real elements (`<button>`, `<input>`, `<table>`), never `<div role="button">`.
10. No new dependencies. No `useEffect` for anything derivable during render.

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

Breakpoint: `shell:` (≥900px). Use it for IA changes only — sidebar/drawer swaps,
table→list swaps. Use `@container` (`container-type` on `.pane`) for panel-level
adaptation.

Utility classes: `.mono` `.tnum` (tabular numerals — use on every counter,
timestamp and table column) `.eyebrow` `.kbd` `.sr-only` (built in)

Component classes (from `index.css`): `.panel` `.panel-head` `.panel-title` `.btn`
`.btn-sm` `.btn-icon` `.btn-primary` `.btn-secondary` `.btn-quiet` `.btn-danger`
`.field` `.field-label` `.field-input` `.field-select` `.field-help` `.chip`
`.chip-dot` `.chip-running|review|committed|stopped|danger` `.surface`
`.surface-inner` `.surface-title` `.surface-description` `.data-table` `.cockpit`
`.cockpit-head` `.tabstrip` `.tab` `.cockpit-body` `.terminal-wrap` `.log-line`
`.log-time` `.log-text` `.skeleton` `.dialog-overlay` `.dialog-content`
`.palette-item` `.split-view` `.file-row` `.row-actions` `.scrim` `.sidebar*`

Prefer these classes over re-deriving the same layout in utilities.

## 3. Primitives — `web/src/components/ui.tsx`

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

## 4. State — `web/src/store.ts`

```ts
useApp(s => s.authed)                    // boolean
useApp(s => s.route)                    // Route (see below)
useApp(s => s.workspaces)               // Workspace[]  (server truth)
useApp(s => s.loading)                  // true only on the very first load
useApp(s => s.error)                    // string | null
useApp(s => s.lastUpdated)              // number | null
useApp(s => s.connection)               // "connecting"|"live"|"reconnecting"|"offline"
useApp(s => s.refresh)                  // () => Promise<void>
useApp(s => s.navigate)                 // (Route) => void   pushes history
```

**There is no `selectedId` / `view` / `select` / `setView` any more.** Navigation is
by route:

```ts
type Route =
  | { kind: "dashboard" }
  | { kind: "workspaces" }
  | { kind: "workspace"; id: string }
  | { kind: "settings" };
navigate({ kind: "workspace", id })
```

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

## 6. Backend API — `web/src/api.ts` (do not edit; use as-is)

```
api.authRequired()      api.testKey(key)
api.workspaces()        api.create({task,repo?,agent,branch?,limits?})   api.clone({url,task,agent,limits?})
api.action(id, "start"|"stop"|"restart"|"delete")
api.diff(id)            // DiffFile[]  — now includes NEW untracked files
api.commit(id, message) api.share(id)   api.files(id)  api.file(id, path)  api.log(id)
api.users() api.addUser({id,name,role}) api.removeUser(id) api.audit()
api.agentsStatus() api.installAgent(name, cmd) api.ghRepos()
api.uploadImage(workspaceId, blob)
api.release(force?)     // ReleaseStatus — published version, changelog, last run
api.applyUpdate()       // POST — owner only; starts the update, returns at once
```

`lib/actions.ts` still exports `withToast(label, fn)` and `toastAction(id, action)`.
Prefer optimistic UI only for bounded single-object mutations; **never** for commit.

## 7. Required states on every async surface

first-run empty ≠ filtered empty (only first-run may offer creation) · loading uses
`SkeletonRows` matching final geometry · error is a visible message with a retry ·
per-row hover actions must also appear on `:focus-within` (use `.row-actions`).

## 8. Accessibility specifics

- Icon-only controls need `aria-label`. `title` alone is not an accessible name.
- Tab strips: `role="tablist"` + `role="tab"` + `aria-selected`; arrow keys move
  focus. Tabs are `.tab` elements; give the strip `aria-label`.
- Dialogs: Radix `@radix-ui/react-dialog`, `.dialog-overlay` / `.dialog-content`.
  Focus is trapped and restored by Radix. Destructive dialogs must name the
  **specific** object (workspace id + path), never "this item".
- Announce state transitions with `announce()` — never log lines.
- Do NOT mark a terminal or log tail as a live region.
- The terminal/log must never yank the viewport: auto-follow only when already
  pinned to the bottom; otherwise show an "N new lines" affordance.

## 9. Verification

Do **not** run `tsc` or `vite build` — the integration pass runs centrally and
files outside your ownership are mid-rewrite. Match the signatures above exactly.
