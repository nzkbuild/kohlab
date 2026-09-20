# Security policy

## Reporting a vulnerability

Open a [private security advisory](https://github.com/nzkbuild/kohlab/security/advisories/new)
on this repository. Please do not open a public issue for anything exploitable.

Include what you did, what you expected, and what happened — a command or a
sequence of clicks is worth more than a description. If you can, say which version
(`kohlab --version`, or the tag you installed from).

Expect an acknowledgement within a few days. This is a small project maintained by
one person, so please allow reasonable time before disclosing publicly. You will be
credited in the changelog unless you ask not to be.

## What Kohlab assumes

Kohlab is built to run on **one machine that you control**, reached over SSH, a
tailnet, or a reverse proxy with TLS. It runs the coding agents you point it at,
with your repositories, and it will execute what those agents ask it to. The trust
model follows from that:

- **The server is trusted.** Anyone who can run commands as the server user owns
  everything Kohlab can reach. There is no sandbox between the server and the box.
- **A workspace is trusted with its own repository.** An agent's branch and working
  tree are its own; it can run any git command inside them. The isolation is
  between *workspaces and users*, not between an agent and the code it was given.
- **A member owns their OS account.** Their home is `0700` and their agents run as
  them. Two members cannot read each other's files, and this is enforced by the
  kernel, not by Kohlab checking.
- **The agents themselves are trusted.** Kohlab starts `claude`, `omp`, `codex` or
  whatever you configure. It does not audit what those programs do.

Out of scope: anything requiring an attacker to already have shell access as the
server user, and anything requiring a member to attack their own account.

## Access model

Three ways in, all covered by the checks in `scripts/`:

| Credential | Grants | Notes |
| --- | --- | --- |
| `KOHLAB_KEY` | owner | Set on the box. The fallback that always works. |
| A member key | `owner` / `member` / `viewer` | Hashed at rest. Self-service rotation from **Settings → Account**. |
| An invitation | one key, once, expiring | A single-use token; only its hash is stored. |
| A share token | read-only, one workspace | For showing someone a diff or a log, not for working. |

Behaviour worth knowing, each asserted by a check:

- **A server that can be reached beyond loopback never starts keyless.** With no
  key, no members and a non-loopback bind, a key is generated, written `0600`, and
  logged once.
- **Every gate answers 401 before 403.** A request with no credentials is told it
  sent nothing; a request with insufficient credentials is told it is not enough.
  Because this is one predicate rather than a convention, a new route cannot
  accidentally inherit an open door — the failure mode that shipped once already.
- **Guessing is throttled** (20 refusals per address per minute, in memory). The key
  is checked before the throttle is consulted, so a correct key still works after a
  run of wrong ones. A dead key reports 429 rather than 401 while the window is
  open: the throttle cannot tell a revoked key from a guessed one.
- **Keys travel in a header**, never in a URL. The sockets carry theirs in a
  WebSocket subprotocol, because a browser cannot set a header on an upgrade. The
  `?key=` form still works for bookmarks and curl, and is never used by the
  dashboard.
- **Every mutating route and every role** is exercised by `scripts/check-invite.mjs`
  and `scripts/check-auth-hardening.mjs` with a real viewer and a real member, both
  created and removed by the check.

## Operational hardening

- Run as the dedicated service user, never as root, and set `KOHLAB_KEY`.
- Never expose port 7676 directly. `docs/reverse-proxy.md`.
- `HOST=127.0.0.1` if the only route in is an SSH tunnel.
- `audit.log` is append-only and never rotated by Kohlab; rotate it yourself if the
  box is long-lived.

## Not a claim

Kohlab has no formal audit or certification, and the checks in `scripts/` are the
only evidence behind the statements above. A finding that a check does not cover is
a valid report.
