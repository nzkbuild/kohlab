---
name: Kohlab
description: Self-hosted console for running and reviewing coding-agent workspaces. Dark-only zinc instrument with a white primary and lime only for live agents.
colors:
  surface-base: "oklch(0.145 0.002 286)"
  surface-sunken: "oklch(0.125 0.002 286)"
  surface-raised: "oklch(0.175 0.002 286)"
  surface-overlay: "oklch(0.205 0.003 286)"
  surface-hover: "oklch(0.205 0.003 286)"
  surface-active: "oklch(0.255 0.003 286)"
  text-primary: "oklch(0.97 0.001 286)"
  text-secondary: "oklch(0.81 0.004 286)"
  text-muted: "oklch(0.72 0.005 286)"
  text-faint: "oklch(0.64 0.005 286)"
  text-on-accent: "oklch(0.18 0.002 286)"
  line-subtle: "oklch(0.255 0.003 286)"
  line-strong: "oklch(0.53 0.005 286)"
  line-accent: "oklch(0.97 0.001 286)"
  accent: "oklch(0.97 0.001 286)"
  accent-hover: "oklch(1 0 0)"
  accent-press: "oklch(0.81 0.004 286)"
  status-running: "oklch(0.9 0.17 124)"
  status-review: "oklch(0.97 0.001 286)"
  status-committed: "oklch(0.72 0.005 286)"
  status-stopped: "oklch(0.64 0.005 286)"
  status-danger: "oklch(0.82 0.14 25)"
typography:
  headline:
    fontFamily: "Geist Variable, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 620
    lineHeight: "2.25rem"
    letterSpacing: "-0.022em"
  sheet-title:
    fontFamily: "Geist Variable, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: "1.75rem"
  section-title:
    fontFamily: "Geist Variable, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.5rem"
    letterSpacing: "-0.01em"
  control:
    fontFamily: "Geist Variable, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.3125rem"
  body:
    fontFamily: "Geist Variable, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.1875rem"
  label:
    fontFamily: "Geist Variable, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1.0625rem"
  mono:
    fontFamily: "Geist Mono Variable, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.75rem"
    lineHeight: "1.0625rem"
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.75rem"
  pill: "999px"
spacing:
  control-h: "2.125rem"
  control-h-sm: "1.75rem"
  row-h: "2.25rem"
  tab-h: "2.75rem"
  topbar-h: "3.25rem"
  sidebar-w: "15.5rem"
  sidebar-w-collapsed: "3.75rem"
  sheet-w: "34rem"
  surface-pad: "1.75rem 2rem 3rem"
  surface-max: "78rem"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.text-on-accent}"
    rounded: "{rounded.md}"
    padding: "0.375rem 0.75rem"
    height: "{spacing.control-h}"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-primary-active:
    backgroundColor: "{colors.accent-press}"
  button-secondary:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "0.375rem 0.75rem"
    height: "{spacing.control-h}"
  button-secondary-hover:
    backgroundColor: "{colors.surface-active}"
  button-quiet:
    textColor: "{colors.text-muted}"
    rounded: "{rounded.md}"
    padding: "0.375rem 0.75rem"
    height: "{spacing.control-h}"
  button-quiet-hover:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.text-primary}"
  button-danger:
    textColor: "{colors.status-danger}"
    rounded: "{rounded.md}"
    padding: "0.375rem 0.75rem"
    height: "{spacing.control-h}"
  button-sm:
    padding: "0.25rem 0.5625rem"
    height: "{spacing.control-h-sm}"
  field-input:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-primary}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0.4375rem 0.625rem"
    height: "2.25rem"
  segmented:
    backgroundColor: "{colors.surface-sunken}"
    rounded: "{rounded.md}"
    padding: "0.25rem"
  segmented-option:
    textColor: "{colors.text-muted}"
    rounded: "{rounded.sm}"
    padding: "0 0.75rem"
    height: "{spacing.control-h-sm}"
  segmented-option-checked:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.text-on-accent}"
  chip:
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0.1875rem 0.5rem"
  panel:
    backgroundColor: "{colors.surface-raised}"
    rounded: "{rounded.lg}"
  inbox-card:
    backgroundColor: "{colors.surface-raised}"
    rounded: "{rounded.lg}"
    padding: "1rem 1.125rem"
  running-row:
    padding: "0.5rem 1rem"
    height: "3.5rem"
  sheet:
    backgroundColor: "{colors.surface-overlay}"
    padding: "1.25rem 1.5rem 1.5rem"
    width: "{spacing.sheet-w}"
  tab:
    textColor: "{colors.text-muted}"
    padding: "0 0.6875rem"
    height: "{spacing.tab-h}"
  tab-selected:
    textColor: "{colors.text-primary}"
  menu:
    backgroundColor: "{colors.surface-overlay}"
    rounded: "{rounded.md}"
    padding: "0.25rem"
  menu-item:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    padding: "0 0.625rem"
    height: "{spacing.control-h}"
  tooltip:
    backgroundColor: "{colors.surface-overlay}"
    textColor: "{colors.text-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0.25rem 0.5rem"
  sidebar-row:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    padding: "0.25rem 0.5rem"
    height: "{spacing.row-h}"
  sidebar-row-current:
    backgroundColor: "{colors.surface-active}"
    textColor: "{colors.text-primary}"
---

# Design System: Kohlab

## Overview

**Creative North Star: "The Instrument Panel"**

Kohlab is operated, not browsed. The console is a dense, dark-only instrument: zinc planes stacked by lightness, a white fill for the one thing to do next, and a single lime signal that means exactly one thing, an agent is alive right now. Every surface answers "what needs me, and what is it doing" before anything else, which is why Home is an inbox: decisions waiting on you first, live agents second, the full list last.

Type is Geist, self-hosted, one voice on every platform. Geist Mono carries whole machine values (ids, agent names, paths, hashes, ages, terminal output) and nothing else. Status reads in monochrome by construction: glyph plus label first, hue only for live and danger. There is no light theme, no hero, no summary tiles and no decoration; density is tuned from four tokens rather than per component.

**Key Characteristics:**
- Zinc OKLCH neutrals (hue 286, chroma at most 0.005) in distinct planes, never one flat black.
- The primary action is a white fill; the focus ring, selected-tab underline and checked segment are white too.
- Lime means only "an agent is alive"; red means only destructive or danger.
- Review and committed are monochrome, told apart by glyph and label.
- Two-tier tokens: primitive ramps feed semantic roles; components only ever see semantic roles.
- Radix behaviour, house styling, wrapped once in `ui.tsx`.

## Colors

A near-neutral zinc instrument with a white action, one live signal and one danger signal, all in OKLCH so equal lightness reads as equal weight. The neutral ramp is the brand mono kit (`brand/kohlab-mono-tokens.css`) carried into `--neutral-*`.

### Primary
- **Instrument White** (`accent`, oklch(0.97 0.001 286)): primary button fill, checked segment, selected-tab underline, focused field border, row-link hover, text selection tint (32%), terminal cursor. Hover lifts to pure white `accent-hover` (oklch(1 0 0)), press drops to `accent-press` (neutral-300). Text on it is `text-on-accent` (oklch(0.18 0.002 286)). The focus outline uses `line-accent`, the same white.

### Secondary
- **Live Lime** (`status-running`, oklch(0.9 0.17 124)): the running chip, the running-row live dot and the sidebar workspace dot of a running agent. Nothing else.

### Tertiary
- **Signal Red** (`status-danger`, oklch(0.82 0.14 25)): destructive buttons and menu items, errors and danger chips. Always on a 12% tint of itself with a 45% border, never a solid red fill.

### Neutral
- **Zinc Canvas** (`surface-base`): the app background.
- **Sunken Zinc** (`surface-sunken`): terminal, code, logs, field wells and the segmented track, one step below the canvas.
- **Raised Zinc** (`surface-raised`): panels, inbox cards, sidebar, mobile action bar.
- **Overlay Zinc** (`surface-overlay`): dialogs, the launch sheet, menus, tooltips, palette.
- **Hover / Active Zinc** (`surface-hover`, `surface-active`): row and control states; active doubles as the current-nav and highlighted-item fill.
- **Text ladder** (`text-primary` > `secondary` > `muted` > `faint`): faint is for placeholders, last-output lines and secondary paths.
- **Review Ink** (`status-review`, neutral-100): needs-review, at full white with the diamond glyph.
- **Committed Zinc** (`status-committed`, neutral-400): landed work, quieter grey with the check glyph.
- **Stopped Zinc** (`status-stopped`, neutral-500): stopped and discarded, with square and x glyphs.
- **Lines** (`line-subtle` for dividers, `line-strong` for control boundaries at 3:1 against their surface).

### Named Rules
**The Two-Tier Rule.** Colour literals exist only in the primitive tier of `web/src/index.css` (`--neutral-*`, `--lime-*`, `--red-*`). The semantic tier aliases them, `@theme inline` bridges semantic names to Tailwind (`bg-surface-raised`, `text-text-muted`, `border-line-subtle`), and no component holds a hex, OKLCH or primitive name.

**The White Primary Rule.** The one next action in a region is a white fill with near-black text. One per region; a second action is secondary.

**The Alive-Only Lime Rule.** Lime means an agent process is running right now. Never for additions, success, connection health, illustration, emphasis or the primary action.

**The Red Means Destroy Rule.** Red marks destructive actions, failures and danger only, always as a tint, never a fill.

**The Monochrome Status Rule.** Every status survives without hue: StatusChip carries the word and a Phosphor shape (play, diamond, check, x, square). Review and committed differ by glyph, label and lightness, not colour. Each tone must clear 4.5:1 against its own 10-12% tint.

## Typography

**UI Font:** Geist Variable (with system-ui fallback), self-hosted via `@fontsource-variable/geist`
**Mono Font:** Geist Mono Variable (with ui-monospace fallback), self-hosted via `@fontsource-variable/geist-mono`

**Character:** One geometric-grotesk voice on every platform, bundled so there is no third-party request. The mono is a material for machine text, not a style.

### Hierarchy
The rem scale lives in `@theme inline`: 12 / 13 / 14 / 16 / 20 / 28 px (`text-xs` and `text-2xs` 0.75, `sm` 0.8125, `base` 0.875, `lg` 1, `xl` 1.25, `2xl` 1.75rem). Never px, never clamp().
- **Headline** (620, 1.75rem, -0.022em): the one `<h1>` per surface via PageHeader; 1.375rem under 40rem. Workspace detail uses the workspace id in mono at 1rem as its `<h1>`.
- **Sheet title** (600, 1.25rem): dialog and launch-sheet titles.
- **Section title** (600, 1rem, -0.01em): Home sections ("Waiting for you", "Running", "All workspaces"), with a tabular muted count.
- **Control** (0.875rem): every button, input, select, textarea and link inherits this floor.
- **Body** (0.8125rem): rows, table cells, menu items, descriptions (max 42rem), tabs.
- **Label** (500, 0.75rem): field labels, help, errors, tooltips, chips, counts, timestamps, table headers.
- **Mono** (0.75 to 0.875rem): workspace ids, agent names, paths, hashes, ages, file tree, last output line, kbd.

### Named Rules
**The Type Floor Rule.** Nothing renders below 12px. `text-2xs` is pinned to 0.75rem, the same as `text-xs`, so the old 11px step cannot come back through a utility.

**The Machine Text Rule.** Mono only for a whole machine value: an id, an agent, a path, a hash, an age, terminal output. Never for headings, labels or a word inside a sentence as a style.

**The Steady Digits Rule.** Live counters, diff stats and timestamps carry tabular numerals (`tnum`) so they do not jitter.

**The Sentence Case Rule.** Table headers, section labels and menu items are sentence case at normal tracking. No uppercase labels, no letter-spaced kickers.

## Layout

One shell breakpoint at 900px (`shell`, 56.25rem). Above it: a fixed sidebar (15.5rem, collapsible to a 3.75rem rail with tooltips) and no top bar, since every surface owns its `<h1>`. Below it: a translucent top bar (3.25rem, 82% canvas with 12px blur) and the sidebar becomes an off-canvas drawer (min(19rem, 84vw)) over a scrim, hidden from the tab order when closed.

Surfaces scroll inside the shell with 1.75rem/2rem padding (1.25rem/1rem under 40rem) and a 78rem max width. Panels adapt to their pane via container queries. Density comes from `--control-h`, `--control-h-sm`, `--row-h` and `--tab-h`, always as min-height so text-spacing overrides never clip. Stacking uses `--z-sticky` (10), `--z-scrim` (40), `--z-drawer` (50), `--z-overlay` (100), `--z-dialog` (101).

**Home (/)** is an inbox, top-down: PageHeader whose one action is **open…** (Terminal in / Agent in submenus, workspaces most recent first); **Waiting for you**, review cards oldest first in a two-column grid at `lg`; **Running**, one panel of rows; **All workspaces**, search, Radix status tabs with counts, then a table at 900px and up or cards below. Creating a workspace belongs to the sidebar's **new workspace**, which opens the launch sheet at `/new`.

**Launch sheet (/new)** is a right-side sheet, min(34rem, 100%) wide, so it is full screen on phones. Order: segmented New workspace | Continue existing (only when there is something to continue), task textarea (1rem, 7rem min), repository input with a datalist of recent and GitHub repos, agent segmented radios, a Limits `<details>`, inline error with `role="alert"`, and an actions footer pinned to the bottom behind a `line-subtle` rule.

**Workspace detail** is a cockpit: header with the mono id `<h1>`, status chip, path and task, a review-first primary action, run/stop and overflow; then tabs Terminal / Files / Review / Log filling the rest. On phones the actions move to a bottom bar on raised zinc, padded for the safe area.

### Named Rules
**The Snap Rail Rule.** The sidebar never animates its width: collapse snaps and only the labels change. Only the mobile drawer moves, by transform.

## Elevation & Depth

Depth is tonal: planes step from sunken (0.125) through base, raised and overlay (0.205) in OKLCH lightness, with 1px lines doing the separating. Shadows appear only on floating layers and the access gate, and nothing load-bearing depends on them, because forced-colors removes box-shadow.

### Shadow Vocabulary
- **Dialog** (`box-shadow: 0 1.5rem 4rem oklch(0.08 0.005 265 / 0.55)`): modal content above the overlay.
- **Menu** (`box-shadow: 0 0.75rem 2rem oklch(0.08 0.005 265 / 0.5)`): dropdown menus and submenus.
- **Gate card** (`inset 0 1px 0 0` 9% text-primary, `0 1px 2px -1px` contact, `0 1.5rem 3rem -1rem` ambient): the access-gate card only, under a 5% white radial light, the app's one gradient.

### Named Rules
**The Planes Not Shadows Rule.** In-page panels, cards and rows are flat; separate them with lightness and `line-subtle` or `line-strong`, never a shadow.

**The Borders Survive Rule.** Focus is a 2px white outline offset 2px, never a box-shadow ring and never a radius change; forced-colors maps borders and outlines to system colours.

## Shapes

Softly squared: 0.375rem for small parts (menu items, tooltips, kbd, file rows, segments), 0.5rem for controls, fields and rows, 0.75rem for panels, cards, dialogs and skeletons. Chips and dots are full pills. Borders are always 1px; the selected tab is a 2px white underline. The brand mark (cursor-bar stem, branch arm, session dot) sits on a 1.75rem white tile with 0.75rem radius at the head of the sidebar, beside the stroked lowercase wordmark.

## Components

### Buttons
- **Shape:** gently rounded (0.5rem), min-height `--control-h` (2.125rem), weight 550.
- **Primary:** white fill, near-black text. One per region ("review diff", "Start agent").
- **Secondary:** hover-zinc fill with `line-strong` border; the default variant.
- **Quiet:** borderless, muted text, fills on hover. Toolbars and icon buttons.
- **Danger:** red text on a 12% red tint with a 45% red border.
- **Icon-only:** square at control height (24px minimum hit area), always with `aria-label`.
- **Hover / Focus:** 110ms colour transitions on the standard ease; white focus outline.

### Chips
- **Style:** pill, 0.75rem weight 500, `line-strong` border, secondary text.
- **Status:** StatusChip only, never ad hoc: label plus Phosphor glyph (play fill, diamond fill, check bold, x bold, square fill) on the status tone's own 10-12% tint. Stopped and discarded share the neutral chip.

### Cards / Containers
- **Panel:** raised zinc, `line-subtle` border, 0.75rem radius, no shadow. PanelHead is 2.75rem with an `<h2>` title and muted meta.
- **Inbox card:** the loudest object on Home. Raised zinc with a full-strength `line-strong` border, 1rem/1.125rem padding: mono id, tabular "waiting since" age, two-line task at 0.875rem, mono agent, tabular diff stats (+added, −deleted, file count), and a white small "review diff" primary at the end.
- **Running row:** 3.5rem min-height inside one panel with `line-subtle` dividers: pulsing lime live dot, mono id, task over the agent's last output line in faint mono, agent, tabular age.
- **Empty state:** centred, optional icon in a 2.5rem bordered tile, title and description. Only first-run offers creation; filtered-empty never does. First run may carry EmptyArt, the hairline terminal frame from `brand/kohlab-empty.svg`.
- **Skeletons:** reserve the final row geometry; 0.75rem radius; shimmer only when motion is allowed.

### Inputs / Fields
- **Style:** sunken well, `line-strong` border, 0.5rem radius, 2.25rem min-height, 14px text. Field wraps label (0.75rem, secondary), control and help or error (0.75rem).
- **Focus:** border turns white, plus the global white outline.
- **Error:** red help text with `role="alert"`.
- **Segmented:** native radios restyled as one control on a sunken track; the checked option is a white fill with near-black 550 text; keyboard and grouping come from the platform.

### Navigation
- **Sidebar:** brand tile plus wordmark, a full-width "new workspace" button, view rows, then the workspace list with a status dot per workspace, and a connection chip footer. Rows are `--row-h`, secondary text; hover fills; current page gets active zinc plus a subtle border and a filled icon. The review count rides the icon corner when collapsed.
- **Tabs:** text-only strip on a bottom line, `--tab-h`, muted to primary on hover, 2px white underline when selected. Horizontal scroll, no scrollbar. Filter tabs carry tabular counts.
- **Menus and tooltips:** overlay zinc, `line-strong` border. Submenus use a faint caret and scroll past 20rem. Danger items are red. Tooltips are supplementary and hidden below the shell breakpoint.

### Data Table
Header cells are sentence case, 0.75rem weight 600, muted. Body cells are 0.8125rem with `line-subtle` row dividers and a hover fill. The id is a mono row-link, underlined at rest. Row actions show on hover and focus-within, always on touch.

### Terminal
xterm on sunken zinc with Geist Mono, a white cursor and a 32% white selection; the ANSI palette stays xterm's own. The pane header carries the socket chip, a one-line hint, and quiet **copy** (selection) and **copy screen** actions; every copy confirms with a toast. Agent TUIs may write the clipboard through OSC 52; clipboard reads are refused.

### Named Rules
**The Wrap-Once Rule.** Radix primitives are styled once in `web/src/components/ui.tsx` (Tabs/TabList/Tab/TabPanel, Menu/MenuSub/MenuItem, Tooltip, and Dialog re-exported for the `.dialog-*` and `.sheet` classes) alongside the house primitives (Button, StatusChip, Chip, Panel/PanelHead, PageHeader, EmptyState, Field, Skeleton, Kbd, BrandMark, Wordmark, EmptyArt). Surfaces import from `ui.tsx`, never from `@radix-ui/*`.

**The Three Pulses Rule.** The only decorative motion is the live dot, on the running chip and the running row: three 1.6s opacity pulses, then still, and static under reduced motion. Everything else moves only to show a state change, at 70-240ms (the launch sheet slides 2rem in at 240ms on the entrance ease).

## Do's and Don'ts

### Do:
- **Do** add colour by adding a primitive, aliasing it in the semantic tier and bridging it in `@theme inline`.
- **Do** make the one next action a white `primary` Button and everything else secondary or quiet.
- **Do** pair every status with its word and Phosphor shape via StatusChip.
- **Do** size controls and rows with `--control-h`, `--control-h-sm`, `--row-h`, `--tab-h`, as min-height.
- **Do** stack with the `--z-*` tokens.
- **Do** set ids, agents, paths, hashes and ages in Geist Mono with `tnum` where they count.
- **Do** give every surface exactly one `<h1>` via PageHeader.

### Don't:
- **Don't** use lime for anything but a live agent, or red for anything but danger.
- **Don't** colour review or committed; glyph, label and lightness carry them.
- **Don't** put a hex, OKLCH literal or primitive name in a component.
- **Don't** import `@radix-ui/*` outside `ui.tsx`.
- **Don't** set any text below 0.75rem.
- **Don't** put a small uppercase label above a heading, or uppercase a table header.
- **Don't** add hero metrics or summary-number tiles to Home or any surface.
- **Don't** animate the sidebar width, animate decoratively beyond the three pulses, or loop any animation except skeletons.
- **Don't** add a light theme or load a font from a third-party host.
