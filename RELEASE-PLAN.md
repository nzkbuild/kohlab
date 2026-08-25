# Release Plan — v1.4.0

**Status:** Planned
**Type:** Feature + hardening release
**Theme:** "Finish the cutover. Make the rewrite correct and fast."

---

## Context

v1.3.0 replaced the hand-rolled HTML dashboard with a real React app and introduced the PTY daemon. The engine and UI are both new, but the **migration is incomplete**: some backend logic still talks to the old tmux model, and the frontend has performance and coverage gaps. v1.4.0 finishes the cutover on both sides.

---

## The split — what is "frontend" and what is "backend" for this release

| | Backend (server.ts, lib.ts, pty-daemon.cjs) | Frontend (web/src, React app) |
|---|---|---|
| **Core** | PTY daemon, workspaces, worktrees, git diff/commit, sharing, notifications, auth | React + Vite + TS app, terminal, editor, diff, installer UI |
| **v1.4 focus** | Finish the PTY cutover + fix correctness | Performance + experience gaps |

---

## Backend focus (correctness first)

### B1. PTY cutover completion — the "running" status is checking the wrong system
- `isRunning()` still polls tmux (`has-session`), but the PTY daemon owns sessions now.
- **Fix:** derive running state from the daemon (sessions list), not tmux.
- Also affects: workspace list `running` flag, `stop`/`delete` (they kill tmux, not the PTY), and the completion watcher (it fires on tmux session end, which no longer matches PTY process exit).
- This is the highest-priority fix: **status, stop, delete, and "done" notifications are all subtly wrong today.**

### B2. Session lifecycle hardening
- Ensure `stop`/`delete` actually close the daemon's PTY session (send `close`, kill process tree).
- Make the completion watcher listen to the daemon's `exit` events instead of polling tmux.
- Test: create → start → echo → stop → verify process gone → delete → verify session gone.

### B3. State consistency
- `started`/`stopped` timestamps should reflect daemon session open/close, not API-call time.
- Multi-server safety: one daemon socket, reconnects handled (already partly done), stale-socket recovery.

---

## Frontend focus (performance + experience)

### F1. Bundle split — lazy-load Monaco
- Monaco is statically imported → 613 KB JS (173 KB gzip) before the terminal even opens.
- **Fix:** `React.lazy` + code-split CodeView/DiffView so the terminal and workspace list load first, Monaco downloads only when the user opens files/diff.
- Expected: first paint JS drops to ~150-200 KB raw; file/diff view still instant when opened.

### F2. Onboarding experience
- First-run flow: access key → **agent install prompt** → **agent setup command** → pick repo → launch.
- Empty state should guide ("install codex to get started") instead of a bare list.
- Agent installer: show install progress + setup command with a copy button.

### F3. Terminal experience
- Reconnect with backoff on WebSocket drop (currently just writes "[disconnected]").
- Scrollback persistence across tab switches (terminals currently remount on tab switch — addon-fit + scrollback should survive).
- Split view: terminal + diff side by side.

### F4. State & polish
- Move workspace refresh to a single store action with optimistic updates on start/stop.
- Keyboard shortcuts (already partly there; make them consistent across views).
- Loading/empty/error states on every view (files, diff, installer).

---

## Explicitly out of scope for v1.4.0

- Automations/scheduling (v1.5.0)
- Mobile app / IDE handoff (later)
- Team collaboration beyond share links (later)
- Native shell (Tauri/Rust) — only if the browser tab ever feels not-enough

---

## Order of work

1. **Backend B1** (PTY cutover) — correctness, do first
2. **Backend B2/B3** — lifecycle + state
3. **Frontend F1** (bundle split) — the big perceived-speed win
4. **Frontend F2/F3/F4** — onboarding, terminal, polish

---

## Definition of done

- [ ] Running status, stop, delete, and completion all derive from the PTY daemon (no tmux in the hot path)
- [ ] Stop/delete terminate the real PTY process tree; verified end-to-end
- [ ] First-load JS bundle splits Monaco out; terminal opens fast
- [ ] Reconnect with backoff; scrollback survives tab switches
- [ ] First-run onboarding: key → install → setup → pick repo → launch
- [ ] CHANGELOG v1.4.0, package.json bumped, tagged, pushed
