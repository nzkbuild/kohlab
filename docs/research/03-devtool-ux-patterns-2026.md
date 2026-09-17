# 03 — Devtool & Operational UX Patterns (2025–2026)

**Scope:** how best-in-class developer/operational tools document their core surfaces, and which
patterns transfer to Kohlab. **Evidence base:** W3C/WAI specs, MDN, web.dev (Chrome), React docs,
Tailwind docs, and product documentation from GitHub/Primer, Vercel/Geist, IBM Carbon, Grafana,
Sentry, PostHog, Stripe, VS Code, Raycast, Linear, plus NN/g research publications.
**Status:** current as of 2026-09. Lines marked `Judgement:` are my opinion, not documented fact.

## 0. Sourcing notes (read this before trusting a section)

- **Retrievable in full:** W3C WAI (ARIA APG, WCAG 2.2 Understanding), MDN, web.dev, React docs,
  Primer **component** pages, Carbon component/pattern pages, Grafana docs, Sentry docs,
  PostHog docs, Stripe docs, GitHub Docs, VS Code docs, Raycast developer docs, Vercel Geist
  **color** page, NN/g articles.
- **Not retrievable (client-rendered shells returned instead — do NOT treat as cited):**
  `primer.style/foundations/*` and `primer.style/components/empty-state|flash`;
  `vercel.com/geist/<component>` pages (the component *inventory* is retrievable from
  <https://vercel.com/geist/colors>); all `polaris.shopify.com` pattern pages (they render the
  same shell); `developer.apple.com` HIG pages. Apple's 44pt guidance is therefore **not** cited
  here — WCAG 2.5.5 is used instead.
- **Linear publishes no design-system documentation.** `linear.app/docs/keyboard-shortcuts` is a
  404. The only primary Linear UX source is *The Linear Method*
  (<https://linear.app/method/introduction>) — a set of product/building principles, not a UI
  spec. Treat all Linear-specific UI claims below as `Judgement:`.
- **Draft/unstable flags:** API surface noted as `Baseline 2025` or "Limited availability" by MDN
  is labelled inline. The ARIA APG is a WAI *authoring practices* document (guidance), not a
  normative spec — the normative combobox/dialog definitions live in WAI-ARIA.

## 1. What the reference products actually document

| Product | What is documented | Transferable pattern |
|---|---|---|
| **GitHub / Primer** | `DataTable` is "a 2-dimensional data structure where each row is an item, and each column is a data point about the item"; supports `rowHeader`, `cellPadding="spacious"` density, `Table.Skeleton` loading, `Table.Pagination` (`pageSize`/`totalCount`), column width modes (`grow` + `maxWidth`, `growCollapse` + `minWidth`, `auto`, fixed), sortable-with-default-column, and both dropdown and inline row actions with a visually-hidden header and per-row `aria-label`s (<https://primer.style/components/data-table>). `Overlay` exposes `initialFocusRef`, `returnFocusRef`, `onEscape`, `onClickOutside` (<https://primer.style/components/overlay>). Primer Primitives is the token layer with an automated a11y contrast check in CI (<https://github.com/primer/primitives>). | Table = rows+columns with a default sort, a toolbar, and a skeleton; overlay focus contract is explicit and testable. |
| **Vercel / Geist** | Colour system: two page/UI backgrounds (use Background 1 by default, Background 2 "sparingly when a subtle background differentiation is needed"); Component Backgrounds 1–3 = default/hover/active; Borders 4–6 (<https://vercel.com/geist/colors>). Component inventory includes Command Menu, Destructive Action Modal, Empty State, Error, Skeleton, Table, Toast, Status Dot, Relative Time Card, Load More Button. | Dark UI differentiation comes from a small alpha-layered ramp, not from many greys. |
| **IBM / Carbon** | Data table: sortable headers, rows expandable "to progressively disclose information", single or batch actions, and a toolbar that "gives a location for primary buttons, search, filtering, table display settings"; **"If extra load time is expected to display information, use skeleton states instead of spinners."** Empty-state pattern separates basic states (first use, user-action confirmation, error management) from in-depth alternatives — in-line documentation / onboarding / starter content — with an explicit "when to use" column; rule of thumb: a **primary** resource earns an educational treatment, a **secondary** resource gets the basic state (<https://carbondesignsystem.com/components/data-table/usage/>, <https://carbondesignsystem.com/patterns/empty-states-pattern/>). | Batch actions belong in a selection toolbar; skeletons for tables; empty states are typed, not one design. |
| **Sentry** | Issues page is triage-first: tab-separated filtered lists — All Unresolved, **For Review**, Regressed, Archived, Escalating — plus event→issue grouping by fingerprint, saved searches, and issue priority (<https://docs.sentry.io/product/issues/>). | A review queue is a first-class surface with its own states and tabs, not a filter on a generic list. |
| **Grafana** | "Avoid unnecessary dashboard refreshing to reduce the load on the network or backend. For example, if your data changes every hour, then you don't need to set the dashboard refresh rate to 30 seconds"; don't stack graphs; document panels; reuse templates/variables for consistency (<https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/>). | Poll/refresh interval must be justified by the data's change rate. |
| **PostHog** | Alerts: thresholds *or* anomaly detection; multiple notification destinations (Slack/Discord/Teams/webhook); **Quiet hours** with up to five ≥30-minute windows suppressing checks off-hours (overnight preset 10PM–7AM, project timezone); invalid configurations **auto-disable** the alert and email subscribers with the reason (<https://posthog.com/docs/alerts>). | Notification systems need suppression windows, an explicit delivery list, and a stated reason when they stop working. |
| **Stripe** | Idempotency keys make retries safe: the first request's status *and* body are replayed for the same key (including `500`s), keys are client-generated (V4 UUID), ≤255 chars, pruned after ≥24h (<https://docs.stripe.com/api/idempotent_requests>). Stripe Apps design guidance routes builders to recommended patterns because "using recommended patterns … is the fastest way to make sure users have a high quality, consistent experience. It also speeds up the app review process" (<https://docs.stripe.com/stripe-apps/design>). | Destructive/retryable mutations need a client-generated key so a double-click can't double-act. |
| **GitHub (product docs)** | Command palette: `Ctrl+K` (search mode) and `Ctrl+Alt+K` (command mode) with both **customizable** in Accessibility settings, and it shows your current location as the **scope** for suggestions (<https://docs.github.com/en/get-started/accessibility/github-command-palette>). | Palette has modes, a visible scope, and remappable shortcuts. |
| **VS Code** | "VS Code is equally accessible from the keyboard. The most important key combination … is ⇧⌘P … which brings up the Command Palette. From here, you have access to all functionality within VS Code"; `⌘P` navigates files/symbols; `?` in the input lists runnable commands (<https://code.visualstudio.com/docs/getstarted/userinterface>). | "All functionality reachable from the palette" is the stated bar. |
| **Raycast** | Commands are "available in the root search"; an **Action Panel** holds the actions for the current selection (<https://developers.raycast.com/information/terminology>). | Selection + contextual actions is the primitive; the palette is the entry point. |
| **Linear** | The Linear Method documents process principles, not UI: "Build for the creators … Keeping individuals productive is more important than generating perfect reports", "Simple first, then powerful", "Aim for clarity — Don't invent terms if possible" (<https://linear.app/method/introduction>). | Vocabulary discipline and "productivity over reporting" are the only directly citable Linear principles. |

## 2. Command palette

**Keyboard interaction (normative pattern).** A palette is a combobox with a listbox popup. Per the
WAI-ARIA APG, focus stays in the textbox while typing; **Down Arrow** moves focus into the popup
(or to the element *after* an automatically-selected suggestion), **Up Arrow** (optional) to the
last element, **Enter** accepts the focused option and closes the popup, **Escape** dismisses the
popup and optionally clears the input; inside a listbox popup, Down/Up move and select, Enter
accepts, Escape closes and returns focus to the combobox
(<https://www.w3.org/WAI/ARIA/apg/patterns/combobox/>). A palette that opens a nested dialog must
implement the modal-dialog contract: focus moves into the dialog on open, Tab/Shift+Tab are
contained, Escape closes (<https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>).

**What makes one good (documented):**
- **Everything reachable.** VS Code's stated bar is that the palette gives "access to all
  functionality" — not a subset of navigation.
- **Modes + visible scope.** GitHub ships search mode and command mode, surfaces current location
  as the suggestion scope, and lets users remap both shortcuts because defaults collide with OS and
  browser bindings.
- **Grouped, contextual actions.** Raycast's model is root search → command → Action Panel, i.e.
  results are nouns and the actions on them are a separate, predictable layer.
- **Type-to-help.** VS Code: typing `?` lists available commands.
- **Recents/pinning** (Linear's palette, Geist's Command Menu) — `Judgement:` the evidence here is
  product practice, not published rationale; treat "recents" as a convention, not a documented
  requirement.

## 3. Information density

- **Tables are the default for row-per-item data.** Primer: "each row is an item, and each column
  is a data point about the item." Carbon gives tables sortable headers, expandable rows for
  progressive disclosure, and a toolbar for search/filter/display settings. Both ship a
  **skeleton** loading state rather than a spinner and a pagination affordance
  (`pageSize`/`totalCount`).
- **Density is a property, not an accident.** Primer exposes `cellPadding="spacious"` as a density
  option; Grafana solves the same problem with reusable templates/variables. `Judgement:` offering
  exactly two densities (comfortable/compact) is the smallest set that solves long tables and
  dense terminals without a theming matrix.
- **Batch/bulk affordances.** Carbon: selectable rows with an indeterminate select-all in the
  header, and actions applied to the selection living in a toolbar or batch-action mode.
- **Progressive disclosure.** Nielsen's rule: "Initially, show users only a few of the most
  important options. Offer a larger set of specialized options upon request", which "defers
  advanced or rarely used features to a secondary screen, making applications easier to learn and
  less error-prone" (<https://www.nngroup.com/articles/progressive-disclosure/>).
- **Clutter vs whitespace.** `Judgement:` the documented anchors are contrast/token discipline
  (Geist: Background 2 "sparingly"; a single default→hover→active ramp) and a layout that never
  hides state. The failure modes are opposite: too much chrome competes with the terminal; too
  much whitespace turns a 24-row queue into 6 screens. Neither Carbon, Primer, nor Geist publishes
  a numeric density target, so Kohlab must pick and hold one.

## 4. State design — the full matrix for a data surface

| State | Documented guidance | Source |
|---|---|---|
| **First-run empty** | 3 NN/g guidelines: communicate system status, provide learning cues, provide direct pathways for key tasks. Carbon types it as a "no data empty state" that explains "what will be in the space once it is populated" and gives the next step. | nngroup.com/articles/empty-state-interface-design ; carbondesignsystem.com/patterns/empty-states-pattern |
| **Filtered / no-results empty** | A distinct scenario ("search results lists when nothing is found"). Do **not** reuse the first-run CTA: the system has data, the filter excluded it. `Judgement:` the recovery action is "clear filters", never "create your first workspace". | nngroup.com/articles/empty-state-interface-design |
| **Loading (0–10s)** | Spinner or skeleton; spinners suit a single module (a card, a video), skeletons suit a full screen because the wireframe "gives users a sense of what the page will look like". For tables specifically: "use skeleton states instead of spinners". | nngroup.com/articles/skeleton-screens ; carbondesignsystem.com/components/data-table/usage |
| **Loading (>10s)** | Progress bar with an explicit duration estimate; skeleton screens do not replace performance work. | nngroup.com/articles/skeleton-screens |
| **Partial** | Carbon: rows expandable to progressively disclose detail; Sentry: hover reveals stack trace / level; Primer: rows with inline vs overflowed actions. `Judgement:` partial = "summary row now, detail on demand", never a stubbed row. | carbon, primer, sentry docs |
| **Stale** | Grafana's rule generalises: match refresh to the data's change rate; PostHog auto-disables alerts it can't validate and emails the reason. A stale surface should say **when** it was last updated and why it isn't updating. | grafana docs ; posthog.com/docs/alerts |
| **Error** | APG: alerts must not move keyboard focus; use `alertdialog` when interrupting the workflow *is* necessary; avoid alerts that auto-dismiss. PostHog: when a notification channel is disabled, tell subscribers why. | w3.org/WAI/ARIA/apg/patterns/alert ; posthog docs |
| **Offline / reconnecting** | `online`/`offline` events exist and are Baseline, but MDN warns the event "shouldn't be used to determine the availability of a particular website". SSE defines a `retry` field for reconnection timing and an `onerror` hook. | developer.mozilla.org/…/Window/online_event ; …/Server-sent_events/Using_server-sent_events |
| **Permission denied** | Not covered by product design systems. `Judgement:` treat as its own state with the *reason* and the exact next action ("ask the owner"), and never render a permission error as a network error. | — |
| **Success** | Primer's destructive-action modal pairs confirm with `variant="danger"` on cancel; toast/inline confirmation is the transient channel. | primer.style/components/overlay |

## 5. Real-time & streaming UI

- **Optimistic updates are constrained, not free.** `useOptimistic` "lets you optimistically update
  the UI" but the setter must run inside a Transition or Action — outside one, "the optimistic state
  will briefly appear and then immediately revert", and React documents an "Optimistic delete with
  error recovery" path and a "stale values" troubleshooting entry
  (<https://react.dev/reference/react/useOptimistic>). `useTransition`'s `isPending` is the
  documented way to show in-flight work "without blocking user interactions"
  (<https://react.dev/reference/react/useTransition>).
- **Avoid layout shift.** CLS target is ≤0.1 at p75. Shifts are *excluded* only when they occur
  within 500ms of discrete input (`hadRecentInput` — clicks/keys, not scroll or pinch). Documented
  technique: "create some space right away and show a loading indicator" before an awaited request
  resolves; animate with `transform` (`translate`/`scale`), never `top/left/width/height`; and
  respect `prefers-reduced-motion` (<https://web.dev/articles/cls>).
- **Responsiveness is a runtime property.** INP measures every interaction end-to-end, and Chrome
  data shows "90% of a user's time on a page is spent *after* it loads" — so a long-lived cockpit
  must keep the main thread free, not just load fast (<https://web.dev/articles/inp>).
- **Motion.** `prefers-reduced-motion` is Baseline-widely-available (since Jan 2020) and is the
  documented switch to honour (<https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion>).
- **Rendering cost of long lists.** `content-visibility: auto` + `contain-intrinsic-size` skips
  rendering off-screen content while retaining intrinsic size — Baseline 2024, newly available
  (<https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility>).
- **Presence / background activity.** Page Visibility gives `document.hidden` and
  `visibilitychange` — the documented signal for "is anyone looking right now"
  (<https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API>). Screen Wake Lock
  (Baseline 2025, secure context) prevents the screen dimming/locking while a long run is on
  screen (<https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API>).
- **"New items" affordances.** No spec covers this. `Judgement:` the defensible rule is one
  user-initiated path — hold scroll position, accumulate a count, offer a jump — because
  auto-reordering mid-scan is an unexpected layout shift (see CLS guidance).
- **Transport limits.** SSE is Baseline but suffers a **6-connections-per-domain** cap in browsers
  without HTTP/2 — relevant when several tabs stream the same host
  (<https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events>).
- **Duplicate suppression.** `Notification.tag` replaces a pending notification with the same tag,
  or closes the displayed one and shows the new one — the documented anti-spam mechanism.
  `renotify` requires a tag (<https://developer.mozilla.org/en-US/docs/Web/API/Notification/Notification>).

## 6. Notifications

- **Permission timing is a documented requirement.** "You should only request consent to display
  notifications in response to a user gesture … going forward browsers will explicitly disallow
  notification permission requests not triggered in response to a user gesture." Also: secure
  context (HTTPS) required, cross-origin iframes excluded, and `Notification.permission` is
  `default | granted | denied` with "no way to programmatically re-ask after a denial"
  (<https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API>).
- **Choosing OS vs in-app.** `Judgement:` the only reliable split is attention: OS notification only
  when the document is hidden *and* the event is actionable (Kohlab: running → needs-review);
  everything else is an in-app badge/toast. The platform gives the visibility signal
  (`document.hidden`) but no rule; the rule is ours.
- **Options that matter:** `tag` (replace, not stack), `renotify` (only with `tag`), `silent`,
  `requireInteraction` (stays until clicked/dismissed), `badge` (small mono icon on Android),
  `body`. All documented at <https://developer.mozilla.org/en-US/docs/Web/API/Notification/Notification>.
- **Not being annoying (documented product practice):** PostHog ships *Quiet hours* (≥30-minute
  windows, up to five, project timezone, overnight preset) that suppress checks entirely, supports
  multiple destinations, and auto-disables a broken alert while **emailing the reason**. The APG
  adds the accessibility angle for in-app alerts: never auto-dismiss them, and watch interruption
  *frequency* — "frequent interruptions inhibit usability for people with visual and cognitive
  disabilities" (<https://www.w3.org/WAI/ARIA/apg/patterns/alert/>).
- **Accessibility contract.** In-app transient messages use `role="alert"` (assertive) and must not
  move focus; anything that *must* interrupt uses the alert-dialog pattern
  (<https://www.w3.org/WAI/ARIA/apg/patterns/alertdialog/>).

## 7. Destructive actions

- **The spec baseline.** WCAG 2.2 SC 3.3.4 (AA) requires, for actions that "modify or delete
  user-controllable data", at least one of: **Reversible** submissions, **Checked** input, or
  **Confirmed** pre-submission review. Any *one* satisfies it — so undo is a valid alternative to a
  modal (<https://www.w3.org/WAI/WCAG22/Understanding/error-prevention-legal-financial-data.html>).
- **Confirmation only where it survives.** Nielsen: dialogs must "restate the user's request and
  explain what the computer is about to do, with specific information" (name the file, not "these 2
  items"); the failure mode is **overuse** — users "automate their response … and simply click Yes
  without thinking"
  (<https://www.nngroup.com/articles/confirmation-dialog/>).
- **Typed confirmation is a real, shipped pattern.** GitHub's repository deletion warns that team
  permissions are permanently deleted and the action "cannot be undone", then requires typing the
  name — but GitHub also ships **recovery**: restore within 90 days, with the caveat that restoring
  "will not restore team permissions"
  (<https://docs.github.com/en/repositories/creating-and-managing-repositories/deleting-a-repository>,
  <https://docs.github.com/en/repositories/creating-and-managing-repositories/restoring-a-deleted-repository>).
- **Modal mechanics.** Use the alert-dialog pattern (role `alertdialog`) for confirmation prompts;
  modal dialogs keep Tab/Shift+Tab inside and close on Escape; Primer wires this explicitly with
  `initialFocusRef` / `returnFocusRef` / `onEscape`.
- **Retry safety.** Where a destructive write can be retried (network flap, double click), Stripe's
  idempotency contract is the documented model: same key → same stored response, so a repeat is not
  a second effect.
- **Modal vs undo — the honest state of the evidence.** There is **no** controlled, primary-source
  study comparing modal confirmation against undo toast; WCAG 3.3.4 treats them as equivalent
  alternatives, and Nielsen (2018) predates the toast-era pattern. `Judgement:` the defensible rule
  is *reversibility first* (branch/reflog-backed soft delete), modal only for irrecoverable or
  bulk-scoped operations, and typed confirmation reserved for "this destroys other people's data".

## 8. Mobile operational UX

- **Touch targets are a spec, not a preference.** WCAG 2.2 SC 2.5.8 (AA): targets ≥ **24×24 CSS px**,
  or spaced so a 24px circle centred on each doesn't intersect another; inline links in sentences
  are exempt. SC 2.5.5 (AAA): **44×44 px**
  (<https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html>,
  <https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html>). NN/g's physical
  framing: ≥ **1cm × 1cm**, because "the impact area of the typical thumb is … an average of 2.5cm
  (1 inch) wide" (<https://www.nngroup.com/articles/touch-target-size/>).
- **Why dense tables fail.** WCAG 2.2 SC 1.4.10 (Reflow, AA) requires no two-dimensional scrolling
  at a 320 CSS px wide / 256 px tall viewport — and explicitly exempts **data tables**, which is the
  loophole every "just scroll the table sideways" implementation walks through. The spec permits
  2-D scrolling for tables; it does not make it usable one-handed.
- **Safe areas.** `env(safe-area-inset-*)` exists for exactly this: a sticky footer with
  `padding: 1em 1em calc(1em + env(safe-area-inset-bottom))` so buttons are "never obscured" by
  device UI (<https://developer.mozilla.org/en-US/docs/Web/CSS/env>).
- **Keep-alive.** Wake Lock (Baseline 2025, secure context) is the documented way to stop the screen
  dimming while monitoring a long run.
- **What to drop.** `Judgement:` the documentable driver is SC 1.4.10 + target size: a phone layout
  keeps a vertical list of status rows + one primary action per row, and drops multi-column tables,
  side-by-side diffs, and hover-only affordances (there is no hover on touch).

## 9. Onboarding

- **Wizards: right only for the right job.** NN/g: "Wizards are a powerful design pattern that can
  be used to simplify complex processes performed infrequently or by novice users"; the documented
  costs are higher interaction cost when the flow is repeated, poor cross-step comparison, and
  **"Wizards are not gracefully interruptible"** (work is lost, context must be rebuilt). NN/g's
  recommendation is that steps be "clearly communicated … independent and self-sufficient"
  (<https://www.nngroup.com/articles/wizards/>).
- **Empty-state-driven onboarding is documented as the base layer.** Carbon's empty-state pattern
  explicitly frames onboarding as an *alternative* to a basic empty state, and notes onboarding
  flows are "usually optional for users, therefore they need to be used in conjunction with basic
  empty states" — with a when-to-use column that routes first-time-use of a *primary* feature to
  in-line documentation/onboarding, and *secondary* resources to the basic state. Starter content
  ("user can interact with data and learn the system by tinkering") is the third documented option.
- **Evidence status.** Carbon and NN/g give *design* guidance and rationale; neither publishes
  controlled outcome data on wizard vs checklist vs empty state. There is no primary source here
  showing which converts better — anything quantitative would be vendor marketing. `Judgement:`
  ship the empty state first (it also serves returning users with zero workspaces), make the wizard
  optional, and never block the app behind it.

## Implications for Kohlab

1. **[MUST]** The command palette is a combobox + listbox: focus stays in the input while typing,
   Down/Up move within results, Enter accepts, Escape dismisses then clears. No action in Kohlab
   may be reachable *only* by mouse — VS Code's "access to all functionality" is the bar.
   (<https://www.w3.org/WAI/ARIA/apg/patterns/combobox/>)
2. **[MUST]** The palette shows its **scope** (current workspace/org) and groups results
   (Actions / Workspaces / Views / Recent); `Ctrl/⌘+K` is remappable in Settings, because GitHub's
   docs exist precisely because defaults collide with OS/browser bindings.
3. **[MUST]** The workspace list is a **table** (one row per workspace, `rowHeader`, stable default
   sort by `needs-review → running → rest`), with a toolbar for search/filter and a batch-action
   mode when rows are selected — not a card grid on desktop. Status is never colour-only: every
   row renders a label or icon beside the token colour.
4. **[MUST]** The review queue mirrors Sentry's triage tabs with **counts**: Needs review ·
   Running · Committed · Stopped. Counts live in the tab labels so a queued item is visible without
   opening the tab.
5. **[MUST]** Every async surface uses skeletons that match the **final** column/row geometry
   (Primer `Table.Skeleton` rows/columns; Carbon "use skeleton states instead of spinners"), and
   reserves that space *before* the request resolves so nothing reflows on arrival.
6. **[MUST]** First-run empty and filtered-empty are different components. First-run (no workspaces
   exist) carries the primary "launch a task" action; filtered-empty shows "no workspaces match
   <filter>" plus "clear filters", and MUST NOT offer creation.
7. **[MUST]** Destructive actions use the alert-dialog contract: role `alertdialog`, focus moves in
   on open, Tab is contained, Escape closes, focus returns to the invoking control, and the dialog
   names the **specific** object (workspace path + branch), never "this item".
8. **[MUST]** Reversibility beats confirmation wherever Kohlab can afford it: discarding uncommitted
   agent changes is an undo-toast (server keeps the branch for N minutes); typed-name confirmation
   is reserved for workspace deletion and team revocation, mirroring GitHub's
   "cannot be undone"+typed-name pattern — and only if Kohlab genuinely ships no recovery path.
9. **[SHOULD]** Commit and any state transition that mutates shared state are **never** optimistic;
   optimistic updates are limited to bounded, single-object mutations and must run inside a React
   Action/Transition, with an explicit revert-on-error path (`useOptimistic` reverts anyway when
   called outside one).
10. **[MUST]** The terminal cockpit never yanks the viewport: when the user has scrolled up, hold
    position and accumulate an "N new lines ↓" affordance; auto-follow only when already pinned to
    the bottom. Never clear or reflow the buffer on reconnect.
11. **[MUST]** Connection state is explicit: a status chip with three states (live / reconnecting /
    offline) plus a last-updated timestamp, driven by SSE/WS state (`onerror`, server `retry`) —
    **not** by `navigator.onLine`, which MDN warns is not a reachability signal.
12. **[SHOULD]** Live updates preserve scan position: fixed row heights, stable keys, no re-sorting
    of the visible list while the pointer is in it; new rows land behind a "N new" control. Only
    animate with `transform` and honour `prefers-reduced-motion` (CLS ≤0.1 at p75 is the target).
13. **[MUST]** OS notifications are gated: permission requested only from a user gesture inside
    Settings (never on load), one notification per workspace transition, always with a `tag` so a
    repeat replaces rather than stacks, and only when `document.hidden`; everything else is an
    in-app badge. In-app alerts use `role="alert"` and MUST NOT auto-dismiss. **Before adding a
    second destination**, ship the suppressions model: a per-user quiet window (PostHog's
    ≥30-minute-window pattern) and one stated reason whenever Kohlab stops emitting.
14. **[MUST]** Mobile is a monitoring surface, not a shrunken desktop: workspace rows become a
    vertical list with one primary action each, touch targets ≥24 CSS px minimum and 44 px for the
    primary action, sticky action bars padded with `env(safe-area-inset-bottom)`, and no
    horizontally-scrolling table, side-by-side diff, or hover-only affordance.
15. **[SHOULD]** Onboarding is the workspace-empty state first, with an **optional** 3-step wizard
    layered on it — each step self-sufficient, resumable, and skippable (NN/g's documented wizard
    costs: not gracefully interruptible, blocks the rest of the app). Never gate the app behind it.
