# Release Plan — v1.3.0

**Status:** Planned
**Type:** Major feature release
**Theme:** "From zero to running agent, in the browser."

---

## Goal

Kohlab's engine is proven (parallel persistent PTY sessions, worktrees, diff, sharing, notifications). But a vibe coder hitting a fresh VPS cannot go from zero to running agent today: agents are missing, auth is unwalked, and the UI is hand-rolled.

**v1.3.0 delivers functional parity with Superset's core loop** — install, login, pick a repo, launch, review — in a real frontend built on proper primitives.

> **A true vibe coder should be able to run kohlab on a fresh VPS and be talking to their agent within 10 minutes, entirely from the browser.**

---

## Phase A — Frontend rewrite (real primitives, not hand-rolled)

The 27KB inline-HTML dashboard has hit its ceiling. Replace it with a proper app.

| Layer | Old (hand-rolled) | New (real primitive) |
|---|---|---|
| Framework | One giant HTML+JS file | React 18 + Vite + TypeScript |
| Styling | Hand CSS | Tailwind CSS v4 |
| Terminal | Raw xterm + manual wiring | `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-image` (official, proper UMD handling) |
| Icons | Emoji/unicode | Phosphor Icons |
| Components | `document.createElement` | Radix UI (tabs, dialog, dropdown, toast) |
| Code view | `<pre>` | Monaco Editor (real VS Code editor) |
| Diff | Hand-rolled line colors | Monaco diff editor |
| Fonts | Browser default mono | JetBrains Mono + Geist (self-hosted) |
| State | Global `state` object | Zustand |

## Phase B — Functional parity (the "vibe coder" necessities)

### 1. Agent installer & launcher config
- **Detect** installed agents (omp, claude, codex, opencode, pi, gemini)
- **Offer to install** missing ones (npm/bun/curl commands per agent) from the UI
- **Agent registry** in the dashboard: see what's available, what's missing, one-click install

### 2. Agent setup/login walkthrough
- First-run wizard: "Choose your agent" → install → **login/setup step**
- Per-agent auth guidance: `claude setup`, codex API key, etc. with copyable commands
- Verify login works before launching (detect agent is ready)

### 3. GitHub integration
- **`gh` auth check** + guided login (`gh auth login`)
- **Repo browser** — list GitHub repos (and local dirs) to create workspaces from, not just type a path
- Clone-from-GitHub already works; make it discoverable

### 4. Workspace creation flow
- Repo picker (GitHub repos + local paths)
- Branch selection
- Task prompt + agent choice in one guided flow (replaces the bare form)

### 5. Multi-terminal
- Tabbed terminals per workspace (PTY daemon supports it natively)
- Split view terminal + diff side by side

### 6. Diff & code review
- Monaco diff editor (real add/remove/context, not colored text)
- Per-file diff view + commit from the review screen

### 7. Onboarding polish
- First-run: access key → agent install → login → pick repo → launch
- Empty states that guide ("install codex to get started")

## Phase C — Docs & release

- Setup docs: fresh-VPS-to-running-agent in 10 minutes
- CHANGELOG + bump. **Versioning decision: 1.3.0** (feature release, not a product-architecture breakthrough — the engine is unchanged, the frontend is a rewrite but the product concept is the same). The 2.x jump stays reserved for a true breakthrough.
- Tag + push

---

## What this explicitly does NOT include

- Automations/scheduling (v1.4.0)
- Mobile app / IDE handoff (later)
- Team collaboration beyond share links (later)

---

## Definition of done

- [ ] Fresh VPS → running agent in the browser, under 10 minutes, all from the UI
- [ ] Agent installer works for at least omp, claude, codex
- [ ] Agent login walkthrough works for installed agents
- [ ] GitHub repo browser + clone-to-workspace flow
- [ ] React frontend with Monaco editor + diff, multi-terminal tabs
- [ ] CHANGELOG 1.3.0, package.json bumped, tagged, pushed
