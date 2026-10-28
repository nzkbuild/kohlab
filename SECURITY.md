# Security policy

## Reporting a vulnerability

Open a [private security advisory](https://github.com/nzkbuild/kohlab/security/advisories/new)
on this repository. Please do not open a public issue for anything exploitable.

Include what you did, what you expected, and what happened, a command or a
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
  accidentally inherit an open door, the failure mode that shipped once already.
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

## AI hub data

Settings → AI and the model menus read which AIs are on the computer, whether each is
signed in, its models and (for the owner) its account and plan usage. `providers.ts`
builds this, and these rules hold for it. `scripts/check-providers.ts` and
`scripts/check-providers-http.mjs` are the evidence.

- **Owner only:** email, plan, usage windows, versions, error text and actions.
  Members and viewers get which AIs are ready and their models, and nothing else
  (`redactCard`, applied on the server). Share links get a 403.
- **A probe never sends a message or calls a model.** Claude is only asked
  `initialize` and `get_usage`; Codex only `initialize`, `account/read` and
  `account/rateLimits/read`. The fake Claude in the check fails if it is ever sent a
  user message.
- **No file that holds an AI's own sign-in is opened.** The code names no such path
  (checked by a scan of `providers.ts`). Hermes is read through `hermes auth list`
  heading lines only; omp through `omp models --json`. Commands that print keys or
  are slow are never run (`omp token`, `hermes status`, `hermes dump`,
  `hermes --version`, `codex-acp --help`). Kohlab never reads Claude's or Codex's
  own credential files. The one exception is its own: see "Accounts and router
  keys" below.
- **Children get only the allowlisted environment** (`childEnv`): never `KOHLAB_KEY`
  or `ANTHROPIC_*` from the server. The check starts the server with canary secrets
  and proves no probe saw them and no response holds them.
- **Every process is bounded:** a timeout that ends it with SIGKILL, a cap on what it
  may print, its error output dropped, one Claude probe at a time, Codex on private
  standard input and output.
- **Nothing runs on a timer.** A probe runs when someone opens the hub, a menu needs
  it, or the owner presses Refresh (at most once per AI per 10 s, audited as
  `providers.refresh`). Results are cached (1 to 10 min) and a failure is cached for
  30 s, so a broken AI is not started again by every request.
- **Known limit:** the hub reads the server user's accounts. A member whose AI runs
  under their own computer account may be signed in differently from what it shows.
- `GET .../chat/run` shows what the AI was told (the project notes and Kohlab's own
  text) and tool names only: no tool server command line, settings or environment.


## Accounts and router keys

v2.6 lets the owner add a second sign-in for Claude or Codex, and use Claude through a
router or an API address. `accounts.ts` holds all of it. `scripts/check-accounts.mjs`
is the evidence: it uses a canary key and fails if the canary is found anywhere but one
file.

- **One file holds a secret, and it is Kohlab's own:** `<works>/accounts/secrets.json`
  (`{account id: router key}`), mode 0600, in a 0700 folder, written atomically (a temp
  file beside it, then a rename). It is the only file Kohlab writes a secret to and the
  only one it reads one from. `accounts.json` (0600) holds names, ids and router
  addresses, no key.
- **Keys are write-only.** No route returns one; the browser learns only that a key is
  stored (`hasKey`) and the router's host and port, and only the owner learns that. A
  key is never in `state.json`, the audit log, a chat transcript, console output, an
  error, an argument or a request to the PTY daemon. The audit log records the account's
  id and name.
- **A key reaches a process only as an environment variable of a project that is on that
  router** (`accountEnv`: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and the three
  `ANTHROPIC_DEFAULT_*_MODEL` names, nothing else). `childEnv` drops any other extra
  key, and `KOHLAB_KEY` never reaches a child. A project on another account, or on none,
  gets neither the key nor the address.
- **A second Claude or Codex login is a fresh, empty folder signed in once, here.**
  It is the only copy of that login, so no rotating refresh token is split between two
  copies (copying the owner's login was rejected for that reason, and still is). The
  folder is never copied or synced, never inside a project, never `~/.claude`, and every
  process of that account (chat, probe, sign-in) uses the same one. Sign-in runs
  `claude auth login` as a child of the server with piped input and the account's folder;
  no browser sign-in is ever completed by Kohlab itself.
- **Who may use an account:** a project that runs as the server's own account, or as the
  shared agent account (`KOHLAB_AGENT_USER`, whose folder is handed to it). A member whose
  chat runs as their own computer account keeps their own sign-in; the chooser is hidden
  and the server refuses (403). Adding, removing, renaming, changing a key or signing in
  is owner-only and audited (`ai.account.*`).
- **The router check** asks `GET <address>/v1/models` with the key: http or https only, no
  user name or password in the address, no redirects followed, a 5 s timeout, at most
  1 MB read. A router's address in an error is shown as its host only.
  *Ceiling:* the owner can point it at any address the server can reach (a local router
  is the point), so a hostile owner could probe the server's network; a member cannot.
- **Residual risk (measured, spike S4):** Claude's Bash tool sees the process environment,
  so the AI can read, and could be tricked into printing, its router key. Use a revocable
  router key made for Kohlab, and rotate it if a chat may have leaked it.
- **Backups:** `kohlab backup` archives a fixed list of files (state, members, audit log,
  key, push files). `accounts/` is not in it, so `scripts/backup-offbox.sh` never sends
  router keys or sign-in folders off the machine. To keep them, back up
  `<works>/accounts/` yourself, to a place only you can read.

## Full access and "Always allow"

- **Full access is Kohlab answering every permission ask itself.** Claude stays in its
  `default` mode: it is never started in `bypassPermissions`, which it refuses as root.
  A question (`AskUserQuestion`) or a plan (`ExitPlanMode`) is never answered for the
  person. Only the owner can turn it on, or the person whose chat runs as their own
  computer account ("Full access is only for the owner." otherwise, 403); turning it on is
  audited (`ai.fullaccess`), and the page asks for confirmation. On a project that runs as
  the server's own account it means commands run as that account; set `KOHLAB_AGENT_USER`
  to use a smaller one.
- **"Always allow" saves a rule only when it is narrow:** one plain command (no `;`, `&`,
  `|`, backticks, `$`, redirections, newlines), never `sudo`, `rm`, `dd`, `curl`, `wget`,
  a shell or `git push`; file changes only inside the project and never `.git`, `.env` or
  keys; a web address by its domain. A refusal never stores a rule. Rules are checked
  (shape, 200 characters, 50 per project) and passed to Claude with `--allowedTools`;
  removing one restarts Claude when the project is next idle.

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
