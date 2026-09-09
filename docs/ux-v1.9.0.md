# UX + UI Plan — v1.9.0 — "The workbench"

**Status:** approved for implementation
**Version:** 1.9.0 (minor: new frontend features, fully backward-compatible — correct per semver; 1.8.1 would mislabel a feature release)
**Theme:** one coherent visual language across every screen, grounded in the existing carbon/emerald identity, picked component-by-component from 21st.dev (only recommended/high-confidence picks, 1–3 per section, no gaps).
**Completeness:** supersedes the first 12-section draft — §13–§17 cover the surfaces that draft missed (terminal chrome, log tail, diff review, settings chrome, toasts), and the inventory map at the end of §2 verifies every file under `web/src/` lands in exactly one section.

---

## 1. UX spec (plan the UX before the UI)

### 1.1 The product is a workbench, not a dashboard

Kohlab's job: *start an agent, watch it work, inspect what it touched, hand it off.*
Every screen decision follows from that. The UI is the frame; the agent's output
is the picture — the frame must never compete with the terminal.

### 1.2 Five pillars

1. **Terminal-first.** Agent output (terminal/files/diff/log) dominates the
   workspace cockpit. Chrome is thin, dark, and quiet.
2. **Status over noise.** Exactly three workspace states, one visual language
   everywhere:
   | State | Color | Treatment |
   |---|---|---|
   | running | emerald | pulsing dot + emerald ring/badge |
   | done (finished) | amber | solid dot + amber badge |
   | stopped | zinc | flat dot, no glow |
   Red appears **only** for destructive actions, never for "stopped".
3. **Keyboard-driven.** ⌘K command palette everywhere; shortcuts for the hot
   actions (start/stop/restart/share/delete). No action takes more than one
   gesture to reach.
4. **Dense but breathable.** 4/8px spacing system, mono UI type, cards at
   `#111113` on `#0a0a0a`, 14px control floor, focus-visible rings on everything.
5. **Progressive disclosure.** Destructive acts require an alert-dialog
   confirm; share links live one click away; onboarding shows only when the
   workspace list is empty; agents/team live in Settings, not the main flow.

### 1.3 Information architecture (unchanged routes, upgraded surfaces)

| View | Today | v1.9 upgrade |
|---|---|---|
| Auth gate | key entry card | same flow, token-complete styling, brand mark kept |
| Command center | side-bar-linked KPI cards | KPI cards with consistent stat grammar + real activity timeline + agent availability table |
| Workspaces (empty) | onboarding steps | 3-step wizard (agent → workspace → launch) with progress rail |
| Workspace cockpit | tab row + toolbar | tab bar with count badges, status badge in header, unmuted-destructive→confirmed actions |
| Files | FileTree + Monaco | tree with hover actions + breadcrumb path |
| Settings | sections stacked | agents as state-driven cards; team table + audit timeline |
| Command palette | existing | fuzzy search, grouped actions, recents |

### 1.4 Keyboard map (target)

| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | command palette |
| `⌘1..3` | dashboard / workspaces / settings |
| `.` (in cockpit) | focus xterm |
| `1..4` (in cockpit) | terminal / files / diff / log |
| `Esc` | clear selection, close overlays |

---

## 2. UI plan — per-section picks (21st.dev, recommended only)

Foundation first, then surfaces. **Instrumentation:** `.21st/design.json` now
exists so all inspiration calls are project-aware (this plan's searches came
back `contextApplied: false` — the file fixes that for future work).

### F. Token foundation — Darkmatter shape, kohlab palette

- **Pick:** Darkmatter (serafimcloud) — **shape only**.
- **Why:** its CSS carries the full modern token set kohlab lacks: `--sidebar-*`,
  `--chart-1..5`, `--radius`, shadow, spacing, letter-spacing tokens.
- **Reject the palette:** dark is warm orange/teal (`#e78a53` primary,
  `#5f8787` secondary) — adopting it would break the carbon/emerald identity.
- **Action:** extend `web/src/index.css` with the missing token *names*,
  keeping kohlab's values (chart colors = emerald/amber tints of existing
  states). No visual change, but every 21st component imported next drops in
  without token collisions.

### 1. Auth gate — login (ephraimduncan)

- Minimalist dark key-entry; closest to the current card. Adopt spacing/border
  polish from it; keep the glowing emerald dot brand mark.

### 2. Command center — Advanced Stats (uilayout) + Chrono Board (dhileepkumargm)

- **Advanced Stats** → KPI card grammar (label/value/delta). Skip its animated
  chart (would need a chart dep — ponytail: no new dep for pretty pixels).
- **Chrono Board** → the activity timeline (created/start/stopped events,
  status-colored cues). **Also reused in Team's audit tail** — one timeline
  component family, two surfaces → visual consistency for free.

### 3. Sidebar — Animated Sidebar (unlumen) + SidebarShowcase (ruixen.ui)

- **Animated Sidebar** → active-indicator bar + spring hover highlight for the
  icon rail (keep hover-expand structure; the indicator replaces the flat
  hover background).
- **SidebarShowcase** → category grouping ("Main" / "Workspaces") + status
  badge affordance, applied to sidebar workspace rows.

### 4. Workspace cockpit tabs — Tabs with Count Badges + Badge Tabs (ruixen.ui)

- Line-style tabs (terminal/files/diff/log) with count badges (open terminals,
  diff hunks). Badge Tabs supplies the running/done state badges on the tab row.

### 5. Onboarding — Multi-step Wizard (dhileepkumargm) + Wizard Steps (ddoemonn)

- **Multi-step Wizard** (highest confidence in the whole plan, 63%) → progress
  rail with checkmarks + directional transitions for the agent→workspace→launch
  flow.
- **Wizard Steps** → clickable rail + direction-aware panels; adopt as the
  fallback if framer-motion's weight is unwanted (see deps note).
- Dep note: Multi-step Wizard wants framer-motion; Wizard Steps is motion-free.
  Prefer **Wizard Steps** if we stay dependency-neutral.

### 6. Command palette — Command Menu (preetsuthar17) + Omni Command Palette (lovesickfromthe6ix)

- **Command Menu** (65%, top pick of the plan) → grouped actions, keyboard
  nav, shortcuts display.
- **Omni** (64%) → fuzzy highlighting, recents, pinned; upgrade path if the
  palette grows to workspace switching + actions plus async sources.

### 7. File browser — Tree Code Viewer (uilayout) + File Viewer (bankkroll) + File Tree View (cnippet-dev)

- **Tree Code Viewer** → synced tree + code panel pattern (matches
  FileTree + CodeView today).
- **File Viewer** → Supabase-style tree + file selection + copy action; keep
  Monaco (its Shiki preview is not a reason to swap editors).
- **File Tree View** → per-file hover actions (download/delete) on tree rows.

### 8. Agent installer — Bash Tool (serafimcloud) + Todo Tool (serafimcloud)

- **Bash Tool** → state-driven card (idle/running) with approval footer —
  exactly the agent-install state machine.
- **Todo Tool** → shimmer "installing…" streaming state + per-item status
  icons for install progress. Same author → consistent card grammar.

### 9. Team + audit — Table With Dialog (ruixen.ui) + Chrono Board (reuse from §2)

- **Table With Dialog** → member list (role badges, destructive-flagged
  actions) + add-member dialog with one-time-key reveal.
- Audit tail = **Chrono Board** timeline, same component as the dashboard
  activity feed.

### 10. Dialogs — Base Alert Dialog (soralabs) + Alert Dialog (shadcn) + Share Dialog (ephraimduncan)

- **Base Alert Dialog** → confirm-on-destructive (delete workspace, revoke
  user) with icon slot.
- **Alert Dialog** (canonical shadcn) → fallback; zero-dep, guaranteed
  consistent.
- **Share Dialog** → copy-link modal for `?share=` URLs (paste/share affordance).

### 11. Empty & loading — Loading State (theshanelevine) + Sidebar Dashboard Skeleton (cnippet-dev) + Interactive Empty State (remcostoeten)

- **Loading State** → pixel-grid + elapsed timer loader, purpose-built for
  long-running agent tasks (use while a workspace boots).
- **Sidebar Dashboard Skeleton** → shell skeleton while initial refresh loads.
- **Interactive Empty State** (dark variant) → workspace-empty / no-agents
  moments with one clear action.

### 12. Brand — no change

- Glowing emerald dot stays (auth gate + sidebar). Logo search surfaced
  nothing terminal-branded; the dot *is* the mark. `ponytail:` don't add a logo
  until the product name needs marketing-grade identity.
### 13. Terminal chrome — Tabs (originui) + Sidebar with Browser like Tabs (arunachalam)

- **Tabs (originui)** — "file-tabs" variant → the multi-terminal strip in
  `WorkspaceDetail` (main / agent / + chips). Close affordance per tab, active
  underline, count badge on the agent tab.
- **Sidebar with Browser like Tabs** — fallback for the strip if we want
  browser-style tab grouping.
- **xterm theme is config, not a component** — `TerminalView`'s
  `new Terminal({ theme: … })` gets the kohlab palette (carbon background,
  emerald cursor/selection) from the CSS tokens. `ponytail:` add a theme picker
  only if a user ever asks for one.

### 14. Log tail — Data Stream (thegridcn) + Audit Log (corr)

- **Data Stream** → animated terminal-style feed: timestamped entries,
  type-colored status dots, streaming reveal — the LogView shape.
- **Audit Log** → actor/type/status tag row grammar; secondary option if the
  log ever gains structured fields.
- Reject **Interactive Logs Table** (54%): filters/search/expandable rows is
  observability-table overkill for a 3-second-poll plain tail. `ponytail:` add
  filters when logs actually grow past a screen.

### 15. Diff review — Edit Tool (serafimcloud) + Github Inline Diff (jatin-yadav05)

- **Edit Tool** (same author as Bash Tool/Todo Tool — one card family in the
  agent tool sections) → diff stat header (+/- line counts), state footer
  (Apply = commit). The commit bar grammar for `DiffView`.
- **Github Inline Diff** → line-level +/- treatment and hover affordances if
  the read-only Monaco diff gets richer line furniture. Monaco DiffEditor
  itself stays (it does the diffing; these supply the chrome).

### 16. Settings chrome — Beautiful Simple Badges (devetaigabbai) + Button (originui)

- **Beautiful Simple Badges** → the badge grammar for agent-installed /
  role / workspace-status chips (tilts with emerald/amber/zinc tokens).
- **Button (originui)** → the shared button/control grammar (sizes,
  destructive variant) that every action across the app reuses.
- Settings key/value rows (Server section) follow **Table With Dialog's** row
  grammar (§9) — no new component, one table row language app-wide.

### 17. Toasts — Toast Notification (framecn) + Alert Toast (lavikatiyar)

- **Toast Notification** (63%, top of this batch) → spring-in/hold/slide-out
  behavior with success/error/info/warning variants.
- **Alert Toast** → variant styling (filled vs subtle) for destructive
  confirm-failures.
- Implementation: sonner is already installed and used; these two inform
  sonner's `theme="dark"` styling (richColors, custom `toastOptions`
  classNames), they do not replace the library. `ponytail:` swap the library
  only if sonner's theming proves insufficient.

---

### Inventory map — every file under `web/src/`, covered

| File | Section(s) |
|---|---|
| `index.css` | §F tokens |
| `App.tsx` | shell (sidebar + palette + toaster wiring) |
| `AuthGate.tsx` | §1 |
| `Sidebar.tsx` | §3 |
| `Dashboard.tsx` | §2 |
| `WorkspaceDetail.tsx` | §4, §13, §10, §16 (buttons) |
| `TerminalView.tsx` | §13 |
| `LogView.tsx` | §14 |
| `BrowseView.tsx` | §7, §11 (select-a-file empty state) |
| `FileTree.tsx` | §7 |
| `CodeView.tsx` | §7 |
| `DiffView.tsx` | §15, §10 (commit is not destructive — no confirm needed) |
| `CommandPalette.tsx` | §6 |
| `Onboarding.tsx` | §5 |
| `AgentInstaller.tsx` | §8, §16 (badges) |
| `Settings.tsx` | §8, §9, §16 |
| `Team.tsx` | §9, §14 (audit tail = Chrono Board) |
| `store.ts` / `api.ts` / `types.ts` / `lib/` | data layer, no UI surface |

Nothing in the web client is unassigned.

---

## 3. Implementation order

1. **Foundation:** token-complete `index.css` (§F) — unblocks every import.
2. **Shell:** sidebar (§3) + auth gate (§1) — the frame.
3. **Command center** (§2) — first screen users land on.
4. **Workspace cockpit** (§4, §7, §13, §14, §15) — the core surface.
5. **Onboarding wizard** (§5) — first-run flow.
6. **Command palette** (§6) + dialogs (§10).
7. **Empty/loading states** (§11).
8. **Settings: agents** (§8) + **settings chrome** (§16) + **team/audit** (§9).
9. **Toasts** (§17) — restyle sonner with the picked grammar (can land any time after §F).

Each step = one component family, typecheck + `vite build` green, commit.

## 4. Dependency policy

- No new dependency unless a picked component hard-requires it (framer-motion
  for the wizard transitions). Prefer motion-free variants where offered.
- No charting library (Advanced Stats chart skipped, see §2.2).

## 5. Definition of done

- [ ] `index.css` token-complete; zero hard-coded hex outside tokens
- [ ] Every surface in §2 carries its picked component family
- [ ] Status semantics (emerald/amber/zinc, red=destructive only) enforced app-wide
- [ ] ⌘K palette + cockpit keyboard map implemented
- [ ] Empty/loading/skeleton states on every async surface
- [ ] `web npx tsc --noEmit` and `vite build` pass
- [ ] CHANGELOG v1.9.0, package.json bumped, tag, push