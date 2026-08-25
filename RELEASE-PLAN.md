# Release Plan — v1.1.0

**Status:** Planned
**Type:** Minor release (new features, fully backward compatible)
**Theme:** From "agents run" to "agents run, and you can trust the result."

---

## Goal

v1.0.0 proved Kohlab's core promise: **parallel, persistent, browser-accessible agents.**
v1.1.0 makes that promise trustworthy and shareable:

> **"Start an agent, walk away, come back to a result you can review and trust."**

Three capabilities, all user-facing, all completing a story v1.0.0 only told halfway:

| # | Feature | What the user gets |
|---|---------|--------------------|
| 1 | **Completion notifications** | Know the moment an agent finishes — no babysitting the dashboard |
| 2 | **Workspace sharing** | Send a workspace to a teammate (or your other device) and see it live |
| 3 | **Safer by default** | A scoped access key so the dashboard can live behind a proxy, not just an SSH tunnel |

---

## Why these three (not a grab bag)

- **Meaningful** — each maps directly to a v1.0.0 pain point: no visibility while away, no way to hand off work, SSH-tunnel-only access.
- **Completes the story** — the dashboard becomes something you leave open and trust, not something you watch.
- **No tech debt** — each feature ships complete with its own docs and testing; nothing half-wired.

---

## Deliverables (each is a complete, tested feature)

### 1. Completion notifications
- Server detects when a workspace's session ends; marks the workspace **done**.
- Dashboard shows done state; optional **desktop/webhook notification** (web push or webhook URL) when an agent finishes.
- Docs: setup + notification configuration.

### 2. Workspace sharing
- Shareable link per workspace, with read-only or full access.
- Live sync — a teammate sees the same terminal stream and diff you see.
- Docs: sharing guide + permission model.

### 3. Scoped access key
- Single access token set via env; dashboard and API require it.
- Enables safe reverse-proxy deployment (Caddy/nginx) without exposing the server naked.
- Docs: deployment + proxy guide.

---

## What this release explicitly does NOT include

- No automations/scheduling (v1.2.0 candidate)
- No IDE handoff, no mobile app (later)
- No internal refactors, no speculative features — anything not user-visible ships later or not at all

---

## Versioning discipline (per project policy)

- **1.1.0** — new features, backward compatible. Correct.
- No 2.x jump — that is reserved for a genuine breakthrough, and none of this is one.
- This plan, once executed, lands in CHANGELOG as **1.1.0** and the README status moves to **v1.1.0**.

---

## Definition of done

- [ ] All three features implemented, tested end-to-end on a live server
- [ ] Docs updated (setup, sharing, proxy deployment)
- [ ] CHANGELOG 1.1.0 section written
- [ ] package.json bumped to 1.1.0, tagged `v1.1.0`, pushed
- [ ] README status → v1.1.0
