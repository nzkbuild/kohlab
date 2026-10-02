---
name: Kohlab
description: Self-hosted console for running and reviewing coding-agent workspaces. Dark-only instrument panel.
colors:
  surface-base: "oklch(0.145 0.005 265)"
  surface-sunken: "oklch(0.125 0.005 265)"
  surface-raised: "oklch(0.175 0.006 265)"
  surface-overlay: "oklch(0.205 0.007 265)"
  surface-hover: "oklch(0.205 0.007 265)"
  surface-active: "oklch(0.255 0.008 265)"
  text-primary: "oklch(0.95 0.004 265)"
  text-secondary: "oklch(0.81 0.008 265)"
  text-muted: "oklch(0.72 0.011 265)"
  text-faint: "oklch(0.64 0.011 265)"
  text-on-accent: "oklch(0.20 0.06 124)"
  line-subtle: "oklch(0.255 0.008 265)"
  line-strong: "oklch(0.53 0.012 265)"
  accent: "oklch(0.84 0.21 124)"
  accent-hover: "oklch(0.88 0.19 124)"
  accent-press: "oklch(0.72 0.19 124)"
  status-running: "oklch(0.9 0.17 124)"
  status-review: "oklch(0.89 0.13 80)"
  status-committed: "oklch(0.89 0.09 205)"
  status-stopped: "oklch(0.64 0.011 265)"
  status-danger: "oklch(0.82 0.14 25)"
typography:
  headline:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Noto Sans, Arial, sans-serif"
    fontSize: "1.5625rem"
    fontWeight: 620
    lineHeight: "2rem"
    letterSpacing: "-0.022em"
  title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Noto Sans, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: "1.1875rem"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Noto Sans, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.1875rem"
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Noto Sans, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1.0625rem"
  meta:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Noto Sans, Arial, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: "1rem"
    fontFeature: "tnum"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace"
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
  button-sm:
    padding: "0.25rem 0.5625rem"
    height: "{spacing.control-h-sm}"
  field-input:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "0.4375rem 0.625rem"
    height: "2.25rem"
  chip:
    textColor: "{colors.text-secondary}"
    typography: "{typography.meta}"
    rounded: "{rounded.pill}"
    padding: "0.1875rem 0.5rem"
  panel:
    backgroundColor: "{colors.surface-raised}"
    rounded: "{rounded.lg}"
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

Kohlab is operated, not browsed. The console is a dense, dark-only instrument panel: graphite planes stacked by lightness, one acid-lime signal for live state and the primary action, and nothing that moves unless something is actually running. Every surface answers "what needs me, and what is it doing" before anything else.

Type is the system sans at small, exact steps; monospace appears only where the content is machine-shaped (code, ids, paths, timings). There is no webfont, no light theme, no hero, and no decoration. Density is tuned from four tokens rather than per component.

**Key Characteristics:**
- Graphite OKLCH neutrals (hue 265, chroma under 0.013) in distinct planes, never one flat black.
- Acid lime is the only accent; it means "live" or "do this next".
- Two-tier tokens: primitive ramps feed semantic roles; components only ever see semantic roles.
- Status is always a word plus a non-colour cue, then colour.
- Radix behaviour, house styling, wrapped once in `ui.tsx`.

## Colors

A cold graphite instrument with one acid signal and three quiet status tones, all in OKLCH so equal lightness reads as equal weight.

### Primary
- **Acid Lime** (`accent`): primary button fill, focus outline, selected-tab underline, text selection tint. Hover lifts to `accent-hover`, press drops to `accent-press`; text on it is the deep lime `text-on-accent`.
- **Live Lime** (`status-running`): running state only, as text, dot and chip tint.

### Secondary
- **Review Amber** (`status-review`): needs-review, the state that asks the operator to act.
- **Committed Cyan** (`status-committed`): work landed. Deliberately the quietest chroma.

### Tertiary
- **Signal Red** (`status-danger`): destructive actions, errors, danger chips and menu items. Always on a 12% tint of itself, never a solid red fill.

### Neutral
- **Graphite Canvas** (`surface-base`): the app background.
- **Sunken Graphite** (`surface-sunken`): terminal, code, logs and field wells, a step below the canvas.
- **Raised Graphite** (`surface-raised`): panels, cards, sidebar, mobile action bar.
- **Overlay Graphite** (`surface-overlay`): dialogs, menus, tooltips, palette.
- **Hover / Active Graphite** (`surface-hover`, `surface-active`): row and control states; active doubles as the current-nav and highlighted-item fill.
- **Text ladder** (`text-primary` > `secondary` > `muted` > `faint`): faint is for timestamps, placeholders and paths only.
- **Lines** (`line-subtle` for dividers, `line-strong` for control boundaries at 3:1 against their surface).

### Named Rules
**The Two-Tier Rule.** Colour literals exist only in the primitive tier of `web/src/index.css` (`--graphite-*`, `--lime-*`, `--amber-*`, `--red-*`, `--cyan-*`). The semantic tier aliases them, `@theme inline` bridges semantic names to Tailwind (`bg-surface-raised`, `text-text-muted`, `border-line-subtle`), and no component holds a hex, OKLCH, or primitive name.

**The One Signal Rule.** Lime means live or primary. One primary button per region; never lime for decoration, illustration or emphasis.

**The Legible Status Tone Rule.** Each status tone is used for dot, border and label alike, so it must clear 4.5:1 against its own 10-12% tint. New status tones meet the same bar.

## Typography

**Body Font:** system sans stack (`--font-sans`)
**Label/Mono Font:** system mono stack (`--font-mono`)

**Character:** Native, zero-byte, no FOUT. The sans carries all UI; the mono is a material for machine text, not a style.

### Hierarchy
The rem scale lives in `@theme inline` (`text-2xs` 0.6875 / `xs` 0.75 / `sm` 0.8125 / `base` 0.875 / `lg` 1 / `xl` 1.25 / `2xl` 1.5625rem). Never px, never clamp().
- **Headline** (`headline`): the one `<h1>` per surface via PageHeader; 1.3125rem under 40rem.
- **Title** (`title`): panel heads and section titles.
- **Body** (`body`): rows, table cells, buttons, menu items, descriptions (max 42rem).
- **Label** (`label`): field labels, help, errors, tooltips, small buttons.
- **Meta** (`meta`): tabular counts, timestamps, mono metadata, status bars, chips.
- **Mono** (`mono`): code, workspace ids, paths, commit lines, file tree, kbd.

### Named Rules
**The Type Floor Rule.** `text-2xs` is only for tabular counts, timestamps, mono metadata and status bars. Prose, help, errors and control labels use `text-xs` or larger. Form controls inherit a 0.875rem floor.

**The Machine Text Rule.** Mono only for content a machine produced or consumes: code, ids, paths, measurements. Never for headings or labels as a style.

**The Steady Digits Rule.** Live counters and timestamps carry tabular numerals (`tnum`) so they do not jitter.

## Layout

One shell breakpoint at 900px (`shell`, 56.25rem). Above it: a fixed sidebar (15.5rem, collapsible to a 3.75rem rail with tooltips) and no top bar, since every surface owns its own `<h1>`. Below it: a translucent top bar (3.25rem) and the sidebar becomes an off-canvas drawer over a scrim, hidden from the tab order when closed.

Surfaces scroll inside the shell with 1.75rem/2rem padding (1.25rem/1rem under 40rem) and a 78rem max width. Panels adapt to their pane via container queries, not the viewport. Density comes from `--control-h`, `--control-h-sm`, `--row-h` and `--tab-h`, always applied as min-height so text-spacing overrides never clip. Stacking uses `--z-sticky` (10), `--z-scrim` (40), `--z-drawer` (50), `--z-overlay` (100), `--z-dialog` (101); no raw z-index numbers.

**Home (/)** reads top-down: PageHeader, whose one action is **open…** (Terminal in / Agent in, each listing workspaces most-recent first), the way back into existing work. Creating a workspace belongs to the sidebar's **new workspace** (route `/new`). Then the review queue, only when something needs review, oldest first; then the searchable, filterable workspace list (table at 900px and up, cards with an overflow menu below). Discarded counts under the stopped filter.

**Workspace detail** is a cockpit: a header with the workspace id as `<h1>`, status chip, mono path and task; a review-first primary action, run/stop toggle and overflow menu; then tabs Terminal / Files / Review / Log filling the rest. On phones the same actions move to a bottom bar on raised graphite, padded for the safe area.

## Elevation & Depth

Depth is tonal: planes step from sunken (0.125) through base, raised and overlay (0.205) in OKLCH lightness, with 1px lines doing the separating. Shadows appear only on floating layers, and nothing load-bearing depends on them, because forced-colors removes box-shadow.

### Shadow Vocabulary
- **Dialog** (`box-shadow: 0 1.5rem 4rem oklch(0.08 0.005 265 / 0.55)`): modal content above the overlay.
- **Menu** (`box-shadow: 0 0.75rem 2rem oklch(0.08 0.005 265 / 0.5)`): dropdown menus.

### Named Rules
**The Planes Not Shadows Rule.** In-page panels, cards and rows are flat; separate them with lightness and `line-subtle`, never a shadow.

**The Borders Survive Rule.** Focus is a 2px lime outline offset 2px, never a box-shadow ring; forced-colors maps borders and outlines to system colours.

## Shapes

Softly squared: 0.375rem for small parts (menu items, tooltips, kbd, file rows), 0.5rem for controls and rows, 0.75rem for panels and dialogs. Chips and running dots are full pills. Borders are always 1px; the selected tab is a 2px underline in lime.

## Components

### Buttons
- **Shape:** gently rounded (0.5rem), min-height `--control-h`, weight 550.
- **Primary:** lime fill, deep-lime text. One per region.
- **Secondary:** hover-graphite fill with `line-strong` border; the default variant.
- **Quiet:** borderless, muted text, fills on hover. Used for toolbars and icon buttons.
- **Danger:** red text on a 12% red tint with a 45% red border.
- **Icon-only:** square at control height (24px minimum hit area), always with `aria-label`.
- **Hover / Focus:** 110ms colour transitions on the standard ease; lime focus outline.

### Chips
- **Style:** pill, 0.6875rem, `line-strong` border, secondary text.
- **Status:** StatusChip only, never ad-hoc: the status word, a non-colour shape cue, and the status tone on its own 10-12% tint. Stopped and discarded are neutral; each status has its own Phosphor shape (play, diamond, check, x, square).

### Cards / Containers
- **Panel:** raised graphite, `line-subtle` border, 0.75rem radius, no shadow. PanelHead is 2.75rem with an `<h2>` title and muted meta on the right.
- **Empty state:** centred, icon in a 2.5rem bordered tile, title and description. Only the first-run variant offers creation; filtered-empty never does.
- **Skeletons:** reserve the final row geometry; shimmer only when motion is allowed.

### Inputs / Fields
- **Style:** sunken well, `line-strong` border, 0.5rem radius, 2.25rem min-height. Field wraps label (xs, secondary), control and help or error (xs).
- **Focus:** border turns lime.
- **Error:** red help text with `role="alert"`.

### Navigation
- **Sidebar rows:** `--row-h`, secondary text; hover fills; current page gets active graphite plus a subtle border. Counts sit in chips and move into the tooltip when collapsed.
- **Tabs:** text-only strip on a bottom line, `--tab-h`, muted to primary on hover, lime 2px underline when selected. Horizontal scroll, no scrollbar.
- **Menus and tooltips:** overlay graphite, `line-strong` border. Danger items are red. Tooltips are supplementary only and are hidden below the shell breakpoint.

### Data Table
Header cells are small uppercase muted labels (0.6875rem, 0.06em tracking); body cells are 0.8125rem with `line-subtle` row dividers and a hover fill. Row actions show on hover and on focus-within, and always on touch.

### Named Rules
**The Wrap-Once Rule.** Radix primitives are styled once in `web/src/components/ui.tsx` (Tabs/TabList/Tab/TabPanel, Menu/MenuSub/MenuItem, Tooltip, and Dialog re-exported for the `.dialog-*` classes) alongside the house primitives (Button, StatusChip, Chip, Panel/PanelHead, PageHeader, EmptyState, Field, Skeleton, Kbd). Surfaces import from `ui.tsx`, never from `@radix-ui/*`.

**The Three Pulses Rule.** The only decorative motion is the running dot: three 1.6s opacity pulses, then still, and static under reduced motion. Everything else moves only to show a state change, at 70-240ms.

## Do's and Don'ts

### Do:
- **Do** add colour by adding a primitive, aliasing it in the semantic tier and bridging it in `@theme inline`.
- **Do** size controls and rows with `--control-h`, `--control-h-sm`, `--row-h`, `--tab-h`, as min-height.
- **Do** stack with the `--z-*` tokens.
- **Do** pair every status colour with its word and a shape cue via StatusChip.
- **Do** keep `text-2xs` for counts, timestamps, mono metadata and status bars.
- **Do** give every surface exactly one `<h1>` via PageHeader.

### Don't:
- **Don't** put a hex, OKLCH literal or primitive name in a component.
- **Don't** import `@radix-ui/*` outside `ui.tsx`.
- **Don't** set prose, help, errors or control labels in `text-2xs`.
- **Don't** put a small uppercase label above a heading.
- **Don't** add hero metrics or summary-number tiles to Home or any surface.
- **Don't** animate anything decoratively beyond the running-dot pulse, or loop any animation indefinitely except skeletons.
- **Don't** add a light theme or a webfont.
