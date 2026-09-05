# Release Plan — v1.6.0

**Status:** planning (this doc)
**Type:** Team-collaboration feature release
**Theme:** "From one key to a team. Named users, roles, and an audit trail — still no database."

---

## Context

Kohlab today has a single trust domain: one `KOHLAB_KEY`, one state file, and
anonymous read-only share links. That's fine for a solo dev, but a small team
(2–10 people on one box) hits walls immediately:

- **One key = everyone is admin.** Any teammate who can reach the box can start,
  stop, commit, and delete every workspace.
- **No idea who did what.** There's no record of who stopped an agent, who
  committed a diff, or who deleted a workspace.
- **Reviewers can't be restricted.** The only read path is a public share token —
  anonymous, so you can't tell *who* looked, and it can't be revoked per-person.

v1.6.0 fixes all three while preserving Kohlab's identity: **JSON files, no
database, no containers.** It does not move to OIDC/OAuth, multi-host, or
quotas — those stay explicitly out of scope.

---

## Model

### Users

A `users.json` file inside the workspace state directory (`$WORKS_DIR/users.json`):

```json
{
  "users": [
    { "id": "alice",  "name": "Alice",  "key": "…hashed…", "role": "owner" },
    { "id": "bob",    "name": "Bob",    "key": "…hashed…", "role": "member" },
    { "id": "carol",  "name": "Carol",  "key": "…hashed…", "role": "viewer" }
  ]
}
```

- **`key` is stored hashed** (SHA-256), never plaintext. The live key only
  appears once, when it's generated.
- **Roles:**
  - `owner` — full control, incl. managing other users.
  - `member` — create/start/stop/commit/delete workspaces, manage agents.
  - `viewer` — read-only (watch terminals, read diffs/logs/files), like today's
    share links but *named* and *revocable*.

### Backward compatibility

- If `users.json` is absent, fall back to the existing single `KOHLAB_KEY`
  (exact current behavior — nothing breaks for existing installs).
- If `KOHLAB_KEY` is unset AND no `users.json`, the server stays open (current
  keyless behavior).

### Audit log

Append-only `audit.log` in the same directory — one JSON line per event:

```json
{"t":1788621887083,"user":"bob","action":"stop","id":"kohlab-fix-billing"}
{"t":1788621888000,"user":"alice","action":"commit","id":"kohlab-fix-billing","detail":"fix: billing"}
```

Recorded on every mutation (create/start/stop/restart/delete/commit/share/
agent-install/user-manage). Written via the existing `withStateLock` chain so
it can't race. Served read-only to `owner`/`member` via `GET /api/audit`.

---

## API surface

| Route | Who | Purpose |
|---|---|---|
| `GET /api/auth/required` | anyone | already exists; extended to also report when users exist |
| `POST /api/users` | owner | create a user (generates + returns the key once) |
| `DELETE /api/users/<id>` | owner | revoke a user |
| `GET /api/users` | owner | list users (keys never exposed) |
| `GET /api/audit` | owner, member | tail the audit log |

Auth resolution order on every request:
1. valid **user key** (Bearer or `?key=`) → that user's role governs.
2. legacy `KOHLAB_KEY` → `owner`.
3. valid **share token** → read-only `viewer` scoped to that one workspace.
4. none → `401` if auth is configured, else open.

---

## Work

1. **`users.json` + key hashing + role type** (`lib.ts`, `types.ts`).
2. **`authenticate(req)` → `{ user, role }` | legacy | share | anonymous** — one
   resolver replacing scattered `authorized()` calls; additive, `authorized()`
   remains for the legacy-only path.
3. **Role gating on every mutating route** in `server.ts` (viewer blocked from
   start/stop/commit/delete/install/user-manage).
4. **Audit writer** — a `logAudit(user, action, id?, detail?)` helper invoked in
   `mutateState` call sites; served at `/api/audit`.
5. **`kohlab user` CLI** — `add` (prints key once), `list`, `rm`, plus `kohlab audit`.
6. **Frontend**: settings gains a "Team" section (list/add/revoke users, show
   audit tail) — gated to `owner`/`member`.

## Explicitly out of scope (unchanged from v1.4.0)

- OIDC/OAuth / SSO delegation
- Multi-host scheduling
- Per-workspace resource quotas
- RBAC groups / fine-grained permissions beyond the three roles
- Mobile / IDE handoff

## Definition of done

- [ ] `users.json` hashed-key users with owner/member/viewer roles; legacy `KOHLAB_KEY` still works untouched
- [ ] `viewer` is blocked from every mutation; `member` from user-management
- [ ] `/api/audit` returns an append-only trail of every mutation, attributed to a named user
- [ ] `kohlab user add|list|rm` + `kohlab audit` CLI
- [ ] Settings → Team section (list/add/revoke/audit) for owner/member
- [ ] CHANGELOG v1.6.0, package.json bumped, tagged, pushed
