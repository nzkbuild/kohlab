# Access UX revamp: "loop zero" (v1.17.0 plan)

**Status:** P1 to P3 shipped in v1.17.0; P4 unscheduled
**Theme:** the access loop, not the paint. v1.10 gave the product one honest
loop (post a task → review the diff → commit). The one loop it never finished
is the loop *before* the product: "I am standing at a new browser on my phone
and this server wants a 48-character key that lives on a different device."
This plan gives that loop a first-class interaction, and hardens the key at
rest and in the browser to the standard the rest of the stack already keeps.
**Version:** 1.17.0 (minor: new frontend feature + additive API + install
hardening, fully backward-compatible).
**Method:** same as EVAL-AND-REDESIGN — every claim is **Read** (from source),
**Proven** (ran it against this box), or **Inferred** (labelled).

---

## 1. What the evaluation found

| # | Finding | Evidence | Label |
|---|---|---|---|
| A1 | The login credential is a 48-hex-char key. AuthGate does everything a field can do (autocomplete, reveal, paste-friendly) — the comment itself cites SC 3.3.8 because a 48-char random string *is* a transcription test. No shorter, typeable form exists. | `web/src/components/AuthGate.tsx:60-174` (SC 3.3.8 comment on the input); `server.ts` key length is 24 random bytes (`lib.ts:40-77` resolveAccessKey) | Read |
| A2 | The retrieval path crosses devices. The gate's own hint says: "find yours by running `kohlab key` on the server." That means: leave the phone, open SSH somewhere else, come back. From a phone at the gate there is no path. | `AuthGate.tsx:60-174` (hint text); `cli.ts:521-522` (`key` is CLI-only) | Read |
| A3 | No pairing mechanism exists anywhere in the product. `pair` matches nothing in `server.ts`, `lib.ts`, `cli.ts`, or `web/src/`. The one remote bootstrap path is `?key=` URL adoption (`api.ts:8-16`), but `kohlab open` prints URLs *without* the key, so the documented remote flow dead-ends at A2. | grep "pair" over the four trees: 0 hits; `web/src/api.ts:8-16`; `cli.ts:192-230` (open prints bare URLs) | Read |
| A4 | Industry answer for "type a short code on the device in front of you, approve on the device that is already trusted" is standardized: RFC 8628 device grant. §6.1: user codes should be short, case-insensitive, grouped, digits-free for mobile keyboards ("WDJB-MJHT" style, base-20). §5.1: an 8-char base-20 code (~34.5 bits) plus a 5-attempt rate limit gives the same 2⁻³² guess probability as a 128-bit key with no limit. | RFC 8628 §5.1, §6.1 (fetched 2026-09-26, datatracker.ietf.org) | Read |
| A5 | The key sits in plaintext in a **world-readable** file: `/etc/systemd/system/kohlab.service` is mode 644 and contains `KOHLAB_KEY=<key>`. | `stat` = `644 root root`; unit read this session | Proven |
| A6 | Why A5 is a real threat here, not box-ticking: v1.8 isolation maps every named member to a POSIX user (`koh-*`) and their agents run as that user on this same box. Any local process can read a 644 file, so a member's *agent* can read the owner's key. | `docs/isolation.md` (model table); A5 | Inferred — model and file mode are verified; no member account verified on this box |
| A7 | Browser storage is localStorage (`kohlab_key`), carried as a Bearer header. OWASP: do not store secrets in localStorage where authentication is assumed; one XSS steals it. Kohlab's mitigations are network posture (loopback bind + tailnet-only TLS) — but the server sends **zero** security headers (CSP, X-Content-Type-Options, Referrer-Policy all absent), so a future XSS has nothing standing in its way. | `web/src/api.ts:8-33,40`; grep for CSP/X-Frame/X-Content-Type/STS in `server.ts`: 0 hits | Read + Proven |
| A8 | Brute force on the main key is handled (20 failures/min per address, map pruned at 4096). Any pairing endpoint must inherit this discipline: per-IP throttle, per-code attempt cap, expiry. | `server.ts:79-107` | Read |
| A9 | The accessibility bar is already high and contractual; the WCAG 2.2 AA pass on AuthGate must be preserved by any new interaction (label, error association, focus management, 44px targets). | `docs/EVAL-AND-REDESIGN.md` (header + B-table), `docs/frontend-contract.md` §1 rules enforced by §9 checks | Read |

## 2. The design

### 2.1 `kohlab pair` — the missing first run

On the VPS (where the owner already is, per A2):

```
$ kohlab pair
open on any device:  https://<host>:<port>        (reuse `kohlab open`'s printer)
pairing code:        KWDJ-MJHT
valid 10 minutes, one use, 5 attempts.
```

Spec, straight from RFC 8628:

- **Code:** 8 chars from the base-20 alphabet `BCDFGHJKLMNPQRSTVWXZ` (§6.1),
  displayed as `XXXX-XXXX`. ~34.5 bits. No digits, one case, mobile-keyboard
  safe (fixes A1 for the bootstrap case).
- **Lifetime:** 10 minutes, single-use, consumed on success.
- **Attempts:** hard cap 5 per code; the code dies on the 5th failure. With the
  cap, §5.1's own arithmetic puts guessing at ≤ 2⁻³².
- **Transport of the key:** the claim response returns the real access key over
  the already-protected channel (tailnet TLS in the recommended deployment;
  `docs/reverse-proxy.md` requires TLS for anything public).
- **Storage:** in-memory map only. A restart kills a pending code — rerun
  `kohlab pair`. No `state.json` schema change.

### 2.2 Server: one endpoint

`POST /api/pair/claim` with `{ code }` → `{ key }`. Unauthenticated by
definition — the code *is* the credential. Guard rails (A8 discipline):

- per-IP throttle, reusing the `authThrottle` pattern (`server.ts:89-107`);
- per-code attempt counter and expiry in the same in-memory map;
- never reveals *why* a claim failed (wrong code / expired / exhausted all
  read as one message) — same philosophy the gate already states
  (`AuthGate.tsx` error comment).

### 2.3 AuthGate: second path, same screen

Under the key field, a quiet link: *"got a pairing code? pair this device."*
It swaps the field to the 9-char code input (`inputMode`, `autoComplete=
"one-time-code"`, auto-uppercase, group dashes optional on input) and keeps:

- the same label/error association pattern (`aria-describedby`, id-hinted
  error — the contract's SC 3.3.1/3.3.3 mechanics),
- the same reveal/`min-h-11` metrics,
- the password-manager path untouched for people who already have the key.

No new screens, no new navigation. Success follows the existing `setKey →
setAuthed` flow (`AuthGate.tsx:60-63`).

### 2.4 Key at rest (A5/A6): EnvironmentFile, 0600

Two options; **A now, B as the upgrade**:

- **A — `EnvironmentFile` (recommended, ~20 min).** install.sh writes the key
  to `/root/.kohlab/kohlab.env` mode 0600 and the unit gets
  `EnvironmentFile=`; the plaintext `KOHLAB_KEY=` line leaves the 644 unit.
  systemd reads it as root; `koh-*` members cannot. No server change at all.
  One CLI touch: `kohlab key` also reads the env file when the unit env is
  empty (`cli.ts:337` reads unit env today).
- **B — `systemd-creds encrypt`** → `SetCredentialEncrypted=` + server reads
  `$CREDENTIALS_DIRECTORY/kohlab-key` (third source in `resolveAccessKey`,
  `lib.ts:61-77`). The textbook mechanism, present here (systemd 255,
  verified), but it touches the server, the CLI, and rotate instructions.
  Do it when A's ceiling (root-level file readability) actually matters.

Migration for this box is part of Phase 2: write env file 0600, add
`EnvironmentFile=` drop-in, remove the plaintext line, `daemon-reload`,
restart. The PTY daemon survives restarts by design (`KillMode=process`,
unit comment) — live agent sessions are kept; the server blips once.

### 2.5 Browser hardening (A7), measured not guessed

- `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff` on
  every response — one middleware line each, zero measurement needed
  (OWASP Secure Headers project, per the HTML5 sheet's pointer).
- `Content-Security-Policy` for the built SPA — **measure first**: if the
  Vite build emits no inline scripts, `script-src 'self'` drops in; if it
  does, use a nonce. Do not ship a CSP that guesses.
- HSTS stays at the proxy layer (documented), not the app: the app cannot
  know it is TLS-terminated.
- `docs/reverse-proxy.md` gains the missing 5-line `tailscale serve` section —
  it is the deployment this operator actually runs (verified live:
  `https://<ts-host>:8444 → 127.0.0.1:7676`, cert automatic).

## 3. What this deliberately does not do

- **No OAuth/OIDC.** Needs an IdP; the product's posture is key-in-hand, like
  ssh (AuthGate's own words). Revisit if a team asks for SSO.
- **No per-device sessions or revocation.** The claim returns the single key;
  a device loses nothing revocable. Named users already exist for exactly
  that need (`lib.ts:495-511`, Account.tsx isNamed copy). `ponytail:` ceiling
  — a paired device cannot be revoked individually; if revocation matters,
  pair as a named member instead.
- **No QR code.** Nine characters on a phone keypad is fine; add a QR when a
  camera-based flow is actually requested.
- **No IndexedDB/WebCrypto key-wrapping.** With CSP + tailnet-only exposure
  the XSS blast radius is network-bounded; wrapping adds complexity the
  threat model here does not pay for (OWASP's own framing).

## 4. Phases (each shippable alone, 1.x semver)

| Phase | Ships | Files touched | Done when |
|---|---|---|---|
| **P1 — loop zero** (v1.17.0) | `kohlab pair`, `POST /api/pair/claim`, AuthGate pairing mode | `cli.ts`, `server.ts`, `lib.ts` (code gen + map), `AuthGate.tsx` | smoke: pair → claim → 200 with working key; wrong code ×4 then 5th → dead; expiry dead; per-IP throttle fires. `bun run check` green. Phone reaches the dashboard with 9 typed chars, no SSH. |
| **P2 — key at rest** | EnvironmentFile 0600, migration, CLI read | `install.sh`, this box's unit, `cli.ts:337` region, `docs/systemd.md` + `security.md` | `stat` env file = 600; unit contains no plaintext key; `kohlab key` still prints; smoke suite green after restart; live workspaces survived |
| **P3 — browser hardening** | headers, CSP (post-measurement), tailscale serve docs, pairing-input autocomplete | `server.ts` (middleware), `docs/reverse-proxy.md` | `curl -I` shows the headers; CSP passes with the built assets on both `/` and gate; no console violations during a full workspace cycle |
| **P4 — upgrades (unscheduled)** | systemd-creds (§2.4 B), QR, per-device revocation via named members | — | only on a stated need |

## 5. Verification plan

- **Contract:** extend `scripts/smoke.mjs` (no framework, per its header) with
  the pairing lifecycle: happy path, attempt cap, expiry, and that a claimed
  key actually authenticates `/api/workspaces`. Run against a throwaway
  `PORT=7699` server per its production-port guard.
- **Gates:** `bun run check` (repo's `check-all.mjs`); `check-review-gate.mjs`
  untouched; frontend-contract §9 checks over the AuthGate edit.
- **A11y:** pairing input keeps a programmatic label + error association and
  `min-h-11`; keyboard-only pass on the gate.
- **Manual:** the operator's phone is the real P1 acceptance test.

## 6. What this plan does not verify (yet)

1. Whether the built SPA (`web/dist`) contains inline scripts — decides CSP
   shape in P3. Measured at implementation time, before the CSP lands.
2. Whether a `koh-*` member account exists on this box today — decides how
   urgent A6 is. Checked with `getent passwd 'koh-*'` before P2 ships.
3. Tailscale `serve` HSTS behavior on the 8444 vhost — documented, not
   asserted, in P3.

## 7. Sources

- RFC 8628 (Device Authorization Grant), §5.1, §6.1 — datatracker.ietf.org, fetched 2026-09-26
- OWASP Cheat Sheet Series: HTML5 Security (Storage APIs, security headers pointer) — fetched 2026-09-26
- OWASP Authentication Cheat Sheet (friction/context guidance) — fetched 2026-09-26
- `systemd-creds(1)` manual (Encrypt/SetCredentialEncrypted examples) — fetched 2026-09-26; local systemd 255 verified
- Repo: `docs/EVAL-AND-REDESIGN.md`, `docs/frontend-contract.md`, `docs/product-v1.10.0.md`, `docs/security.md`, `docs/isolation.md`, `docs/reverse-proxy.md`, `docs/install.md`
- Code: `web/src/AuthGate.tsx`, `web/src/api.ts`, `cli.ts`, `server.ts`, `lib.ts`, `install.sh` (path:line in the table above)
