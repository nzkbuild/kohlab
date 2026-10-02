---
target: the inside app and sidebar
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/root/kohlab/web/src/components/Sidebar.tsx"
target_fingerprint: "sha256:75beee31b33b7d31e8a70e3bf17f542bae1d638528d15f52c5e8cbf3f096a7c6"
target_path: /root/kohlab/web/src/components/Sidebar.tsx
timestamp: 2026-09-20T17-09-40Z
slug: web-src-components-sidebar-tsx
---
# Critique: Kohlab app shell and sidebar

Target: `web/src/components/Sidebar.tsx` and the shell it lives in.
Slug: `web-src-components-sidebar-tsx`. Mode: Operate.

## The yardstick this was judged against

Operate mode is not Persuade. The user is already in a task, so the standard is
different in kind, not degree.

- **Earned familiarity beats expression.** The failure mode is not flatness. It is
  strangeness without purpose: over-decorated controls, mismatched form controls,
  invented affordances for standard tasks, motion that conveys nothing. A
  category-fluent user must be able to trust the interface on sight.
- **One family, tight scale.** Product UI rarely needs a display/body pairing. A
  1.125 to 1.2 step ratio, fixed rem, not fluid clamp sizing.
- **Restrained colour with a full state vocabulary.** Hover, focus, active,
  disabled, selected, loading, error, warning, success. One accent for primary
  actions, current selection and state, never decoration. A second neutral layer
  for the nav and panels.
- **Every interactive component ships all seven states**, or it ships incomplete.
- **Skeletons that reserve final geometry**, not spinners in the middle of content.
- **Empty states that teach**, and first-run empty is not filtered empty.
- **Motion 150 to 250ms, state only.** No page-load choreography.
- **Working memory holds about four items.** Navigation gets five top-level
  entries at most; every decision point with more than four visible options needs
  grouping or progressive disclosure.
- **Consistency is a virtue here**, and delight is saved for moments.

The bar for this product is higher than the category, because PRODUCT.md commits
to it in writing: "calm, precise, developer-native, operational, an instrument
panel, not a landing page. The v1.10 frontend is the standard, not a one-off."

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Status signalling is genuinely strong, but the collapsed rail's own state had no visible exit until it was fixed this session |
| 2 | Match system / real world | 4 | Domain words used exactly, plain-language help on every field |
| 3 | User control and freedom | 2 | One click collapsed the rail permanently for pointer users; no discard action exists; commit is irreversible with no confirmation |
| 4 | Consistency and standards | 2 | Two button-casing systems, four toggle patterns, five pane-header treatments, six empty-state treatments, one dead colour class |
| 5 | Error prevention | 2 | `delete` and `revoke` get a naming confirm dialog, `commit` gets none; the palette's "new workspace" lands where creation is not offered |
| 6 | Recognition rather than recall | 3 | Collapsed rail is icons and dots only; long workspace ids truncate and must be matched against rows elsewhere |
| 7 | Flexibility and efficiency | 3 | Command palette, pane shortcuts, roving tabindex on tabs, keyboard tree navigation. Missing any "next to review" motion |
| 8 | Aesthetic and minimalist design | 3 | Calm and dense where it counts, but the Dashboard carries three panels the Workspaces route already owns |
| 9 | Error recovery | 2 | Every inline error has a retry, but the key-rotation error is rendered in body text colour through a class that resolves to nothing, and one error is silent to assistive tech |
| 10 | Help and documentation | 3 | Contextual help is real, and there is no in-app reference or link to the shipped docs |
| **Total** | | **27/40** | **Acceptable (20-27), at the top of the band** |

## Design Specificity Verdict

**Authored for Kohlab in its token layer and its vocabulary. Category
interchangeable in its composition.** The atoms are Kohlab's; the arrangement is
any SaaS dashboard's.

Genuinely Kohlab's: the five-plane graphite token system with a single accent and a
stated rule that acid-lime means live; the lifecycle vocabulary
(`running / needs review / committed / stopped`) used identically in the sidebar,
both tables, the palette and the log header; the review gate as a first-class
surface with per-file reviewed checkboxes and a guard that refuses to offer accept
unless the workspace is genuinely in the review queue; operational honesty in copy
("Kohlab cannot undo, amend or un-commit it", "Not running, showing the last
screen").

Generic: the four equal KPI tiles on the Dashboard, which hold no Kohlab idea; the
Dashboard as a vertical stack of five regions that duplicates what the Workspaces
route already is; Settings as six panels in one scroll with no local navigation;
the same 5-column table mounted twice; and the 12px-radius card with a 1px border
and an uppercase eyebrow label, which is the 2020s default console look. "An
instrument panel, not a landing page" is a promise about composition, and
composition is the interchangeable part.

## Cognitive Load

Four of the eight checks fail, which is critical.

Passes: chunking, grouping, progressive disclosure.

Fails: **single focus** (the Command center renders five regions at once, and the
review count competes with itself in four places), **visual hierarchy** (on the diff
surface the largest, most saturated element is the lime commit button while the
sentence saying the action cannot be undone is 11px muted text), **one thing at a
time**, and **working memory** (a collapsed rail is icons with no labels).

Decision points with more than four visible options: the workspaces status filter
(5), the workspace action bar (5), Settings as a whole (6 destinations in one
scroll), the new-workspace form (6 controls plus 2 actions), the command palette
(unfiltered, 5 plus one per workspace, so 15 on a ten-workspace server), and the
table row actions (4 once hovered).

## Emotional Journey

Arrive: calm and confident. One field, one key, a real focus ring.
Orient: strong. The Dashboard explains itself, the tab title carries the review
count, the sidebar section title carries it again.
Find the work: good from the sidebar and the review queue. Weak from the
Workspaces table, where the id is plain text and the only entry point is an icon
that is invisible until the row is hovered.
Open it: the cockpit header is the best-composed screen in the product.
Read the diff: **the peak.** Per-file reviewed checkboxes, a reviewed counter,
totals in status colours.
Accept or discard: **the valley, and structural.** There is no discard anywhere in
the app. The only way to reject an agent's work is to delete the workspace. The
irreversible action has no confirmation, while delete and revoke both have one.
And the reassurance text is the faintest thing on the surface. At the product's
highest-stakes moment the interface is at its quietest and offers no way to say no.

## Priority Issues

### [P0] The sidebar could not be expanded with a pointer once collapsed. FIXED this session.
The expand control laid out outside the 60px rail and was clipped by the rail's own
`overflow: hidden`. It existed, was labelled "Expand sidebar", and was painted
nowhere and hit-tested nowhere. Collapse worked; expand was impossible; the flag
persists in localStorage, so the rail stayed gone across reloads until site data
was cleared. The unreachable control also stayed in the tab order, and focusing it
scrolled the clipped container, dragging the rail 29px sideways. That is a WCAG 2.2
AA 2.4.11 failure.
Fixed by letting the brand block yield in the collapsed state so the toggle fits
inside the rail, and giving it the full 36px content box. Verified: rail scrollWidth
59 equals clientWidth 59 (was 88 versus 59), toggle box 12 to 48 inside a rail
ending at 60, `elementFromPoint` at its centre returns the button, focus no longer
scrolls the rail, and it round-trips both ways.

### [P1] There is no discard, and the irreversible action has no confirmation
The product promises "accepts or discards it". The app ships commit (irreversible,
unconfirmed) and delete-workspace. Without a discard, every rejected attempt costs a
whole workspace, so the only cheap outcome is to commit.
Fix: add a confirmed `discard` beside `commit` in DiffView's review footer, and give
`commit` the same naming ConfirmDialog that delete and revoke already use, naming
the workspace id and the file count. Reuse the existing disclosure sentence as the
dialog description.
Suggested: `$impeccable harden`

### [P1] The primary way into a workspace is invisible until hover
In the Workspaces table the id is a `<span>` and the only entry point is an icon in
`.row-actions` at `opacity: 0` until hover or focus-within. The Dashboard makes the
same id a button. A user scanning for the thing that needs review sees no clickable
target.
Fix: make the id a real button in WorkspacesView, or make the whole row a link with
the icon actions overlaid.
Suggested: `$impeccable clarify`

### [P1] The key-rotation error is invisible
`Account.tsx:66` uses `text-danger-strong`, which is not a token and produces no CSS
rule at all. It is the only dead utility among 246 in use. Measured live: the element
computes the same colour as body text while `text-status-danger` computes
`oklch(0.82 0.14 25)`. So a failed key rotation reads as normal copy.
Fix: change it to `text-status-danger`, and add a check that every colour utility
referenced in `web/src` resolves to a rule.
Suggested: `$impeccable audit`

### [P2] The command palette's "New workspace" is a dead end
It navigates to the Dashboard, which offers no create affordance unless there are
zero workspaces. The create form lives on `/workspaces`.
Fix: point it at `{ kind: "workspaces" }` with the existing `#new-workspace` target,
or accept a creating intent in the route.
Suggested: `$impeccable clarify`

### [P2] The sidebar animates a layout property
The bundled detector's only finding: `transition: width` at `index.css:571`. The
shell is a flex row, so animating the rail's width reflows the terminal pane on
every frame of the 200ms. It is reduced-motion gated, so it is mitigated, not absent.
Fix: make the shell a grid and transition `grid-template-columns`, or overlay the
rail and animate `transform` only.
Suggested: `$impeccable optimize`

### [P2] Every Phosphor icon import is deprecated
The language server reports 16 deprecated icon names in Sidebar.tsx alone. App-wide
this is a maintenance cliff, not a visual defect.
Suggested: `$impeccable harden`

## Persona Red Flags

**Alex (Impatient Power User).** Collapses the rail to get screen space for the
diff, which was the intended power move, and lost all navigation permanently with no
way back. Later, in the Workspaces table, he reaches for the workspace id to open it
and it is not clickable; the door is an icon that only appears if he hovers the row
first. He tries Ctrl+K and picks "New workspace", and lands on a page with no create
button.

**Riley (Distracted Mobile User).** This product explicitly expects him: "your phone
screen sleeps" is the pitch. On the Workspaces route under 900px the table becomes a
card list, which is right. But the Dashboard table does not reflow at all: measured
at 320px it is 725px wide inside a 286px content box. The review queue is the one
thing he would open on a phone, and the surface that summarises it is the one that
does not fit.

**Casey (Cautious Reviewer).** He reads the footer, which says in the app's own words
that the commit cannot be undone, and then finds the button above it is lime and
unconfirmed. He goes looking for the way to reject the work instead. There is no
discard. To say no he must delete the workspace and its worktree.

## Minor Observations

The collapsed rail's brand mark was 3.5px off the nav icon column's centre. The
sidebar footer note "persists on this server" is 11px faint text that reassures
rather than informs. The palette shows a command key glyph while its own footer
shows `esc`, on a Linux-first product. The Team copy-link button flips to "copied"
permanently with no reset, so it looks spent. The log header prints its polling
interval as user-facing text. Two `h1` elements exist in WorkspaceDetail and two in
Onboarding, against the one-h1-per-route rule the source's own comment states.
Contrast spot-checks re-derived from the tokens all pass AA; the weakest line in the
system is `--line-subtle` as a row divider at 1.63:1, acceptable for a decorative
divider.

## Questions to Consider

1. If acid-lime means "live", why is the largest lime element on the highest-stakes
   screen the commit button, while the sentence saying it cannot be undone is the
   smallest and least contrasted text on the pane?
2. The review gate's whole thesis is that accepting is a decision. The app can
   already name a workspace, its path and its file count in a confirm dialog. What
   stops "discard" from existing beside commit with the same specificity?
3. Every pane survives a narrow viewport and every list does not. If the operator is
   expected to triage from a phone, which single surface should own "what needs my
   decision right now", and can the four KPI tiles be deleted in its favour?
