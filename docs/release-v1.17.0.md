# Release plan: v1.17.0

**Status:** release candidate
**Type:** minor (new features, additive API, install hardening; fully backward-compatible)
**Theme:** review comes first, and the key stops leaking.

## Built, not yet committed

| Area | What | Evidence |
|---|---|---|
| Pairing (`access-ux-v1.17.0.md` P1) | `kohlab pair`, `POST /api/pair/claim`, AuthGate pairing mode | smoke.mjs pairing lifecycle; phone test still to do |
| Dashboard merge | `/api/workspaces/:id/merge`, merge button after commit | merge last mile check |
| Review-first UI | one home (review queue, then the list), `/new`, `/w/:id/:tab`, review marks survive tab switches, commit/merge confirm tone, role-aware controls | headless browser run, 2026-10-02 |
| Monaco self-hosted | `web/src/lib/monaco.ts`, token theme, no CDN | zero external requests in a browser run |
| Update polling | paused while the tab is hidden (`ux-v2.0.0.md` D1) | source |
| Browser hardening (P3) | `nosniff`, `Referrer-Policy: no-referrer`, CSP (`script-src 'self' 'wasm-unsafe-eval'`, `style-src` needs `'unsafe-inline'`), `tailscale serve` docs | `curl -I`; zero CSP violations across terminal, review, log, files and Monaco in a browser run |
| Brand | `BrandMark` (brand/kohlab-mark.svg) in sidebar, gate, join; `web/public/favicon.svg` in the accent colour | screenshots; favicon 200 `image/svg+xml` |
| Browser check | `scripts/check-browser.mjs` (check 21): 74 assertions over home, `/new`, workspace, settings at 320/390/768/1280; skips without Chromium | `bun run check` |
| Key at rest (P2) | `install.sh` writes `~/.kohlab/kohlab.env` 0600 + `EnvironmentFile=`; re-running migrates an old unit; `kohlab key` and `doctor` read the env file | migrated this box: env file 600, unit has no key, `kohlab key` matches, API 200, `bun run check` 20/20 |

## Still to do

Nothing: all features are in. What remains is the cut.

## Cut

- `package.json` and `web/package.json` (stale at 1.11.0) to 1.17.0
- CHANGELOG, ROADMAP rows, `access-ux-v1.17.0.md` marked shipped
- `bun run check`, build, a real phone pairing
- `release v1.17.0` commit, tag, OTA
- decide on `.codex/`, `.grok/`, `brand/`: commit or ignore

## Deferred to v1.18+

Phone terminal soft keys and compact cockpit; palette actions; CSS token and
icon cleanup; Settings sections; systemd-creds, QR, per-device revocation (on
stated need). Watch: Monaco is ~700 KB gzip from the box, lazy, but slow on a
weak phone link; a lighter diff viewer is the fix if it hurts.
