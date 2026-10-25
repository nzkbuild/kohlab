# AI hub: where each provider's status, account, usage and models come from

Research spike, 2026-10-25. Everything below was run on this box (Claude Code 2.1.305, codex-cli 0.163.0, codex-acp 2.2.2, Hermes 0.21.1, omp 18.4.1, 9router in Docker). No credential file was read. No model call was made. Probes ran from `/tmp/aihub/` (scripts: `claude-probe.mjs`, `codex-probe.mjs`, `acp-probe.mjs`). Every spawned process was killed.

Legend: VERIFIED = run here and saw the reply. SCHEMA = taken from the generated protocol schema or `--help`, not run, because it needs a signed-in account. Latencies are wall clock on this VPS, cold unless noted.

## 1. Summary table

| | Claude | Codex | Hermes | omp | 9router (local router) |
|---|---|---|---|---|---|
| Installed + version | `claude --version` -> `2.1.305 (Claude Code)`, 0.06 s | `codex --version` -> `codex-cli 0.163.0`, 0.17 s. `codex-acp --version` -> `2.2.2`, 0.3 s | `hermes acp --version` -> `0.21.1`, 2.1 s. **Avoid `hermes --version`: 10.9 s** | `omp --version` -> `omp/18.4.1`, 0.85 s | `GET :20128/api/health` -> `{"ok":true}`, 10 ms |
| Signed in? | `claude auth status` (JSON, 0.4-1.3 s) or Claude `initialize` reply `account` | `codex login status` (text + exit code, 0.15 s) or app-server `account/read` (0.2 s) | No single "signed in". `hermes auth list` (1.3 s) lists credential labels; `config.yaml` `model.provider` says which one is in use | No status command. `omp models --json` lists only providers that have credentials (empty list in a fresh `PI_CODING_AGENT_DIR`) | Not applicable. Reachable = health 200 |
| Account | `initialize` -> `account.email`, `subscriptionType` ("Claude Pro"), `apiProvider`. `auth status` adds `orgName`, `authMethod` | app-server `account/read` -> `{type:"chatgpt", email, planType}` (SCHEMA, signed-out reply VERIFIED: `account:null`) | Provider name + base_url host from `config.yaml` (`custom_providers[].name`); no email concept | Provider ids from `omp models --json` (`openrouter`, `commandcode`). Email only through `omp usage --json` for OAuth providers (empty here) | None. Dashboard users only |
| Quota + resets | `get_usage` control request: `rate_limits.five_hour` and `seven_day` `{utilization, resets_at ISO}`; 2.0 s extra | app-server `account/rateLimits/read`: `primary`/`secondary` `{usedPercent, windowDurationMins, resetsAt unix s}` + `credits` (SCHEMA; signed-out error VERIFIED) | None. Provider is a router | `omp usage --json` (0.8 s) for OAuth accounts; empty here. OpenRouter: `GET /api/v1/key` with the key (not run, needs key) | `/api/usage/*` exist but need a dashboard login (401 here). Nothing usable without credentials |
| Models now | `initialize` -> `models[]` (5 aliases + 8 pinned ids), no model call | app-server `model/list` (0.01 s after init). Returned 8 models while signed OUT, so it is a bundled catalog; gate on `account/read` | `config.yaml` `custom_providers[].models` keys (27 here). ACP `session/new` also lists, but took 13.9 s | `omp models --json` (2.7-3.5 s, 232 KB, 697 models) | `GET /v1/models` (open, 77 models, 0.9 s then fast) |
| Multi-account isolation | `CLAUDE_CONFIG_DIR=<dir>` (VERIFIED: empty dir -> `loggedIn:false`) | `CODEX_HOME=<dir>` (VERIFIED: app-server reports that `codexHome`, signed out) | `HERMES_HOME=<dir>` (VERIFIED: fresh home, `model: (not set)`) | `PI_CODING_AGENT_DIR=<dir>` (VERIFIED: 0 models) or `--profile <name>` (creates `~/.omp/profiles/<name>`) | n/a, one router, many keys |
| Router / base URL | `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` (VERIFIED, see 2.1) | `-c model_provider=...` / `config.toml [model_providers.x] base_url, env_key`; `codex login --with-api-key` (help text only) | Native: `custom_providers[]` with `base_url` + `api_key` | `models.yml providers.<id>.baseUrl/apiKey` (this box has `commandcode` at `127.0.0.1:8765`); env `OPENROUTER_API_KEY` etc. | It is the router: OpenAI `/v1/chat/completions`, Anthropic `/v1/messages`, Bearer key required |
| Cost / safe at 60 s | 1.6-2.6 s init, 3.9 s with usage. Auth + models: yes at 60 s. Usage: no, 5 min | All cheap (<1 s). Yes at 60 s | `auth list` 1.3 s, `dump` 3.8 s. Read config instead; poll rarely | `models --json` 3 s CPU heavy. 10 min cache | Health/models yes at 60 s |

## 2. Per provider detail

### 2.1 Claude

**Installed/version.** `claude --version` -> `2.1.305 (Claude Code)`, 0.06 s. Kohlab already runs `which` plus `claude auth status` (`handleAgentsStatus`, 60 s cache).

**Signed in, account.** Two sources, both VERIFIED:

`claude auth status` (default JSON, `--text` for prose), 0.4 s with an empty config dir, ~1.3 s with the real one:
```json
{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","configDirectory":"/root/.claude",
 "email":"<email>","orgId":"<uuid>","orgName":"<email>'s Organization","subscriptionType":"pro"}
```
Signed out: `{"loggedIn":false,"authMethod":"none",...}` with no email.

Claude `initialize` control request, line `{"type":"control_request","request_id":"x","request":{"subtype":"initialize"}}` on stdin of `claude -p --input-format stream-json --output-format stream-json --verbose --setting-sources project,local --disable-slash-commands --strict-mcp-config` (exactly what `headlessPlanUsage` already spawns). Reply (redacted):
```json
{"type":"control_response","response":{"subtype":"success","request_id":"x","response":{
  "account":{"email":"<email>","organization":"<email>","subscriptionType":"Claude Pro","apiProvider":"firstParty"},
  "models":[{"value":"default","displayName":"Default (recommended)","description":"Sonnet 5.5 · Efficient for routine tasks",
             "supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"],"supportsAdaptiveThinking":true,"supportsFastMode":true}, ...],
  "claude_code_version":"2.1.305","commands":[...],"agents":[...]}}}
```
Latency: 1.4-2.6 s (spawn + reply). Signed out, `account` is `{"tokenSource":"none","apiProvider":"firstParty"}` (no email), models are still returned.

**Quota.** `{"subtype":"get_usage"}`, same process, no model call. 2.0 s on top of init (it calls Anthropic). Reply, redacted to what matters:
```json
{"subscription_type":"pro","rate_limits_available":true,
 "rate_limits":{"five_hour":{"utilization":38,"resets_at":"2026-10-25T17:29:59.9+00:00","limit_dollars":null,"locked_reason":null},
                "seven_day":{"utilization":4,"resets_at":"2026-10-29T22:59:59.9+00:00"},
                "seven_day_opus":null,"seven_day_sonnet":null,"extra_usage":{"is_enabled":false,...},
                "limits":[{"kind":"session","percent":38,"severity":"normal","is_active":true},{"kind":"weekly_all","percent":4,...}],
                "spend":{"used":{"amount_minor":0,"currency":"USD","exponent":2},"limit":null,"enabled":false}},
 "session":{"total_cost_usd":0,...}}
```
`usageOf()` in `chat.ts` already maps `five_hour`/`seven_day`. The reply also has many obfuscated keys (`tangelo`, `amber_ladder`, ...) that are all `null` here; ignore them. `rate_limits.limits[].severity` is a ready-made warning level; use it for the card colour. With an API key or router: `rate_limits_available:false`, `rate_limits:null`, `subscription_type:null` (VERIFIED).

**Models.** From `initialize.models` (above): 5 aliases (`default`, `opus`, `sonnet`, `fable`, `haiku`) and 8 pinned ids (`claude-opus-4-8`, ...). `supportedEffortLevels` per model. Also free. Note it is a static list for the logged-in plan: with `ANTHROPIC_BASE_URL` set it did NOT change (VERIFIED), so for a router account the model list must come from the router's `/v1/models`, and mapping from alias to router model uses `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_MODEL` (Claude Code documented env vars, not exercised here).

**Multiple accounts.** `CLAUDE_CONFIG_DIR=/path` VERIFIED: `auth status` reports `configDirectory` and `loggedIn:false` for a fresh dir; `initialize` works against it (no email). Sessions, credentials and projects are all under that dir, so the existing per-workspace transcript lookup (`~/.claude/projects`) must use the same dir. Sign-in for the second account: `CLAUDE_CONFIG_DIR=/path claude auth login [--claudeai|--console] [--sso] [--email x]` opens a browser/URL flow in a pty; this cannot be driven headlessly, so it needs the terminal (pty) path or capturing the URL from stdout (not tested; a hang risk, see Pitfalls).

**Router / base URL.** VERIFIED with a dummy key and `ANTHROPIC_BASE_URL=http://127.0.0.1:20128`:
- `claude auth status` -> `{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}`. It does NOT validate the key.
- `initialize.account` -> `{"tokenSource":"none","apiKeySource":"ANTHROPIC_API_KEY","apiProvider":"firstParty"}`.
- `get_usage` -> `rate_limits_available:false`.
So for router accounts "connected" has to come from probing the router itself (`/v1/models` returning 200 with that key), not from Claude. A real validity check of an Anthropic-compatible key costs one tiny paid `/v1/messages` call; do not do it on a timer, only on the user pressing "Test".

### 2.2 Codex

**Installed/version.** `codex --version` 0.17 s, `codex-acp --version` 0.3 s. Kohlab already requires both.

**Signed in.** `codex login status`, 0.15 s, exit 0 plus text; `Not logged in` when signed out (VERIFIED signed-out; signed-in text not seen, `parseCodexLoggedIn` already handles it). No email in this output.

**Account + quota + models: use the app-server, not codex-acp.** `codex app-server` speaks JSON-RPC over stdio by default (no daemon, no port; `--listen` and `daemon` exist, do not use them, they are shared). Schema generated with `codex app-server generate-json-schema --out DIR` (0.2 s). Handshake: `initialize {clientInfo:{name,version},capabilities:{}}` -> `{userAgent, codexHome, platformFamily, platformOs}` in 0.2-0.9 s, then notification `initialized`. Requests, VERIFIED signed out (latency from process start, all under 1 s):

| Request | Signed-out reply | Signed-in shape (SCHEMA) |
|---|---|---|
| `account/read {refreshToken:false}` | `{"account":null,"requiresOpenaiAuth":true,"workspaceRouting":null}` | `account: {type:"chatgpt", email, planType:"plus"\|"pro"\|"team"\|...}` or `{type:"apiKey"}` or `{type:"amazonBedrock"}` |
| `account/rateLimits/read` | error -32600 `codex account authentication required to read rate limits` | `{rateLimits:{primary:{usedPercent,windowDurationMins,resetsAt},secondary:{...},credits:{hasCredits,unlimited,balance},planType,limitId,limitName,rateLimitReachedType,spendControlReached}, rateLimitsByLimitId:{codex:{...}}, ordinaryUsageAllowed, rateLimitResetCredits}`. `resetsAt` is unix seconds; `usedPercent` is an integer |
| `account/usage/read` | error (auth required) | token usage: `summary`, `dailyUsageBuckets`, `threadUsage` |
| `model/list {}` | 8 models, 9.8 KB, `isDefault` flag, `hidden`, `supportedReasoningEfforts[{reasoningEffort,description}]`, `defaultReasoningEffort`, `inputModalities`, `serviceTiers` | same, probably account-dependent |

Also a server notification `account/rateLimits/updated {rateLimits}` is pushed during turns, which `codex-acp` forwards inside a session; a live chat can reuse it for free.

Caveat: `model/list` answered while signed out, so it is a bundled catalog and not proof of access. Show Codex models only when `account/read.account != null`.

Sign-in without scraping the CLI: `account/login/start {type:"chatgptDeviceCode"}` -> `{loginId, userCode, verificationUrl}` then notification `account/login/completed`; also `{type:"chatgpt"}` (browser, returns `authUrl`), `{type:"apiKey", apiKey}`. Today `codex.ts` scrapes `codex login --device-auth`; the app-server route would remove the ANSI regex, but is a bigger change. SCHEMA only.

**codex-acp** (`initialize` 1.4 s) returns `authMethods:[{id:"api-key"},{id:"chat-gpt"}]` and `session/new` fails fast with `{"code":-32000,"message":"Authentication required"}` when signed out (1.4 s total). Useful as a cross-check, but it spawns an app-server child (two extra processes), so use `codex app-server` directly for the hub. Do not run `codex-acp --help`: it starts the server and hangs (this killed a shell here).

**Multiple accounts.** `CODEX_HOME=/path` VERIFIED (`codexHome` echoed back; `codex login status` -> Not logged in). Note: Codex creates ~15 sqlite files in it on first start and warns about helper binaries under a temp dir, so use a real directory, not `/tmp`.

**Router / API key.** `codex login --with-api-key` (key on stdin) or `account/login/start {type:"apiKey"}`. A custom base URL is `config.toml` `[model_providers.<id>] base_url=..., env_key=...` with `model_provider="<id>"`, which can be passed per process with `-c model_provider=...` (help text only, not run).

### 2.3 Hermes

**Installed/version.** `hermes acp --version` -> `0.21.1`, 2.1 s. `hermes --version` takes 10.9 s (it prints install dir, Python, SDK, update check): do not call it from a poll. `hermes acp --check` -> `Hermes ACP check OK`, 2.5 s. Every command prints a harmless `rtk: hermes plugin warning` line on stderr/stdout; strip it.

**Signed in, account.** Hermes has no single login. The truth is "which provider is configured and has a credential":
- `hermes dump` (3.8 s): `model: jbt/openai/gpt-5.6-luna`, `provider: custom:vps`, `hermes_home: ~/.hermes`, then an `api_keys:` list of `name  set|not set`. Values are not printed.
- `hermes status` (4.1 s): prose with check marks per provider (`OpenAI Codex ✗ not logged in`, ...). Too slow and prose; skip.
- `hermes auth list` (1.3 s): `provider (N credentials):` then `#1  <LABEL>  api_key id=<6hex> priority=0 <source>`. Labels and sources only (`env:ANTHROPIC_API_KEY`, `gh_cli`, `config:VPS`), no secrets. Safe to parse for "this provider has a credential".
- `~/.hermes/config.yaml` has settings and keys in one file. Reading only key NAMES: `model.default`, `model.provider`, `custom_providers[].name`, `custom_providers[].base_url`, `custom_providers[].models`, `fallback_providers[].{provider,model}`. Never read `api_key`. The existing `model.provider = custom:vps` plus `base_url = http://100.127.210.49:20128/v1` means Hermes here is a client of the local 9router (same host, port 20128).

Card for Hermes: account label = provider name (`VPS`), plus base URL host. Connected = a credential exists for the active provider AND (for a custom router) the router's `/v1/models` answers.

**Quota.** None. It is a client of a router. Fallbacks are `fallback_providers` in config (also see `hermes fallback`).

**Models.** Cheap: the model keys under `custom_providers[].models` (27 here, `models_discovered: true`). Heavy: ACP `session/new` returns `models.availableModels[]` as `{modelId:"anthropic:claude-opus-5", name:"Anthropic · claude-opus-5", description:"Provider: Anthropic"}` for every built-in provider plus `custom:<model>`, **13.9 s** (plus network calls and a Copilot token exchange warning). It is what chat startup already pays; do not use it for the hub. `hermes model --refresh` clears the picker's disk cache but is interactive; do not run.

**Multiple accounts.** `HERMES_HOME=/path` VERIFIED (`hermes dump` echoes it, model unset). `hermes profile list|create|use` is a second mechanism (profiles, sticky default); `HERMES_HOME` is the safe one because it is per process.

**Router.** Native: add a `custom_providers` entry (name, base_url, api_key, models). Configured by editing config (or `hermes model`, interactive).

### 2.4 omp

**Installed/version.** `omp --version` -> `omp/18.4.1`, 0.85 s.

**Signed in, account.** No `status` command. Facts:
- `omp models --json` (2.7-3.5 s, 232 KB) returns `{"models":[{provider,kind,id,selector,name,contextWindow,maxTokens,reasoning,thinking[],input[],cost}]}` for providers that have credentials only: 697 models = `openrouter` 586 + `commandcode` 111. In a fresh `PI_CODING_AGENT_DIR` the list is empty (VERIFIED). So the set of `provider` values IS the connected-provider list, and each model has `selector` = `provider/id`, the form omp accepts for `--model`.
- `omp usage --json [-r] [-p provider]` (0.8 s) -> `{generatedAt, reports:[], accountsWithoutUsage:[], disabledCredentials:[], capacity:{}}`. Empty here because no OAuth account is logged in; for OAuth providers (anthropic, openai-codex, ...) it carries per-account usage windows (shape not seen, so treat as unknown until an OAuth login exists). `-r` redacts emails.
- `omp auth-broker list --json` is the catalog of loginable providers (`{id,name}`: `openai-codex`, `anthropic`, `zai`, `kimi-code`, `openrouter`, ...), 0.9 s. `omp auth-broker status --json` -> `{"ok":false,"reason":"not_configured"}`: it is about a remote vault, not our case. Do NOT use `omp token`, it prints credentials.
- `omp acp` initialize (1.5-2.6 s): `authMethods:[{id:"agent","name":"Use existing local credentials"}]`; `session/new` 4.2-6.2 s returns `configOptions[id=model].options[]` with exactly the same 697 models (`value` = `provider/id`, `name`). No gain over `omp models --json`.

**Quota.** `omp usage` for OAuth accounts only. OpenRouter credits/limit: `GET https://openrouter.ai/api/v1/key` with `Authorization: Bearer <key>` returns `{data:{label,usage,limit,limit_remaining,is_free_tier,rate_limit}}` (documented OpenRouter API, not run: needs the key, which we must not read). Skip unless the user pastes a key into Kohlab itself.

**Models.** `omp models --json`; `omp models <provider> --json` filters (2.7 s, no faster). `omp models refresh` forces a new catalog fetch (network). Provider counts can be huge (586), so the UI should group by provider and search, and the server should send a trimmed shape.

**Multiple accounts.** `PI_CODING_AGENT_DIR=<dir>` (default `~/.omp/agent`; holds `agent.db`, `models.db`, `models.yml`, `config.yml`) VERIFIED. `omp --profile <name>` makes `~/.omp/profiles/<name>` and is for interactive use; the probe created one and it was deleted. Provider keys come from env (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`, ...) or `omp login <provider>` (OAuth, interactive).

**Router.** `models.yml`: `providers: { <id>: { baseUrl, apiKey, compat } }` (here `commandcode` -> `http://127.0.0.1:8765`). Key names only were read.

### 2.5 9router (/opt/9router)

What it is: `decolua/9router:opencode-fix`, a local Docker image (container `9router`, host network, `PORT=20128`, data at `/opt/9router/data`; `run.sh` shows how it is started). It is a Next.js multi-provider router with an OpenAI-compatible and an Anthropic-compatible front. Hermes points at it (`base_url http://100.127.210.49:20128/v1`).

Probes (VERIFIED, no credentials, `127.0.0.1:20128`):

| Path | Result |
|---|---|
| `GET /api/health` | 200 `{"ok":true}`, 10 ms |
| `GET /v1/models` | 200, **no auth needed**, 33 KB, 77 models, 0.9 s first then ~50 ms. Shape: `{object:"list",data:[{id:"dsk/deepseek-flash",owned_by:"dsk",capabilities:{vision,tools,reasoning,thinkingFormat,contextWindow,maxOutput,...},context_length,max_completion_tokens}]}`. `id` is `<prefix>/<model>`; prefixes here: `opc` 36, `cmc` 29, `jbtai` 9, `dsk` 3 |
| `GET /v1/models/info?id=` | 400 without `id` (per-model info) |
| `POST /v1/messages` (Anthropic API) | 401 without a Bearer key; the route exists, so it works as `ANTHROPIC_BASE_URL` for Claude |
| `GET /api/usage/stats`, `/api/providers/test` | 401 `Unauthorized` (dashboard session). Container routes also include `/api/usage/{history,providers,chart,request-logs,[connectionId]}` and `/api/keys`; all dashboard-gated. Whether an API key unlocks them is unknown |

Conclusion: for a router account the hub can show reachability, model list and (from `owned_by`) which upstreams are live. It can not show quota unless the owner pastes a dashboard login, which we should not ask for. Show "usage: see router dashboard" with a link instead. The same `/v1/models` convention holds for OpenRouter (`https://openrouter.ai/api/v1/models`, public) and most routers.

## 3. Recommended probe design: `providers.ts`

### 3.1 Principle
One `Probe` per provider returns a `ProviderCard` (section 4). Cheap things (installed, auth) are refreshed often, expensive things (models, usage) rarely and on demand, always with stale-while-revalidate: the HTTP handler returns the cached card immediately and kicks one background refresh if stale. No probe ever blocks a request more than ~10 s, and every probe is bounded by a timeout and kill (`SIGKILL` like `headlessPlanUsage`).

### 3.2 What to probe, per provider

| Provider | Presence + version | Auth + account | Models | Usage |
|---|---|---|---|---|
| claude | `Bun.which`, `--version` once | One headless process: `initialize` + `get_usage` together (3.9 s) -> account, models and usage in one spawn. Add `auth status` only to learn `authMethod`/`orgName` | from the same `initialize` | from the same `get_usage` |
| codex | `Bun.which` both bins, `--version` once | One `codex app-server` process (private stdio): `initialize`, `account/read` | `model/list` only if `account != null` | `account/rateLimits/read` only if signed in (and `account.type == "chatgpt"`) |
| hermes | `Bun.which`; version via `hermes acp --version` once per boot, or skip | Read `config.yaml` key names (`model`, `custom_providers[].{name,base_url}`) + `hermes auth list` for credential presence | config `custom_providers[].models` keys | none |
| omp | `Bun.which`, `--version` once | `omp models --json` (providers present = connected) | same call | `omp usage --json` (only if any OAuth provider) |
| router (9router, OpenRouter, any base URL) | `GET /api/health` or `/v1/models` | key accepted? `GET /v1/models` with `Authorization: Bearer` (free); a real key check needs a paid call, so on-demand "Test" only | same `/v1/models` | none, link to dashboard; OpenRouter `GET /api/v1/key` if Kohlab holds the key |

Run all provider probes in parallel, each in its own try/catch. Share the existing helpers: `childEnv()` for the process environment (add the account's `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `HERMES_HOME` / `PI_CODING_AGENT_DIR` / `ANTHROPIC_*` on top), the `controlReplyOf` parser and `usageOf` mapper from `chat.ts`, the `claudeAuthCheck` and `codex.ts` sign-in caches (fold them into this module). Reuse the live-chat Claude usage reading when under 2 min old (already done by `ownerPlanUsage`); don't spawn a second Claude then.

### 3.3 Cache and refresh

| Data | TTL | Refresh trigger |
|---|---|---|
| installed + version | process lifetime for version; 60 s for `which` | boot, "recheck" button |
| auth/account | 60 s (matches today's checks) | after a sign-in/out finishes (clear cache, as `clearCodexSignedIn` does), "refresh" |
| models | 10 min in memory, persist to disk like `agent-<name>.models.json` | sign-in, account added, "refresh" |
| usage | 5 min server-side (Claude `get_usage` hits Anthropic; 3.6 s) | Settings AI hub open: client polls every 60 s but the server only re-reads if older than 5 min; one in-flight read shared by all callers (like `inflightUsage`); on error back off 5 -> 15 min |
| router `/v1/models` | 5 min | "refresh" |
| failures | cache the error card for 30 s so a broken provider is not re-spawned by every poll | |

Do not probe at all when nobody is looking: refresh only while a request for the hub (or a model picker needing it) arrives, never from a timer. Model pickers read the cached cards (connected providers only), so opening a picker costs nothing; if no card has ever been built, build once.

Safe at 60 s? Auth-level probes (codex app-server 0.2 s, `auth status` 0.4-1.3 s, router health 10 ms, config read ~0): yes. Heavier: `omp models` (3 s, 232 KB JSON parse), Hermes CLI (1.3-4 s): 10 min. Claude headless init+usage (3.9 s and a network call to Anthropic): 5 min. Claude spawns a Node process of ~100+ MB each time, so never concurrent.

### 3.4 Not installed / not signed in
- Not installed: card `state:"not_installed"`, `version:null`, one action `install` (already supported by `handleAgentInstall`: `npm i -g <pkg>`), no further probes (no spawn, no cache beyond 60 s).
- Installed, signed out: `state:"signed_out"`, `account:null`, `models:[]`, `usage:null`; action `sign_in` with `via`. Claude signed-out still returns a model list, but the picker must not show it (connected only). Codex signed-out `model/list` is also non-empty: ignore it.
- Probe error or timeout: `state:"error"` with `error:{code,message}` plain sentence, last good `models`/`usage` kept with `stale:true` (a failed usage read must not hide the card, same as today's footer).
- Rate limited or "usage limit": from Claude `limits[].severity` / Codex `rateLimitReachedType` -> `state:"limited"` with `resetsAt`; the v2.6 fallback logic can key off the same field.
- Distinguish "signed in" from "key present": router/API-key accounts are `connected` only when the `/v1/models` check passed, else `error`.
- Redaction: email, org name and plan are owner-only data (same rule as `shownUsage`); members see `{state, name}` and model lists only.

### 3.5 Pitfalls found
- `hermes --version` 10.9 s; `hermes status` 4.1 s; Hermes ACP `session/new` 13.9 s. Never on a poll path.
- `claude auth status` trusts any `ANTHROPIC_API_KEY`: loggedIn is true with a dummy key.
- Codex `model/list` and Claude `initialize.models` return lists when signed out.
- `codex-acp --help` starts the server and never exits. Don't call it.
- Codex under `CODEX_HOME` in `/tmp` prints a warning and creates sqlite files; use a persistent per-account dir (e.g. `~/.kohlab/accounts/<id>/codex`).
- `claude auth login` and `omp login` are browser/OAuth flows that wait for the user; run them in the pty path or a managed child with a timeout (as `startCodexLogin` does, 15 min), never inside the 60 s polling.
- Spawn with `uid`/`gid` of the member when probing a member's account (`chat.ts` does this for chats); the owner hub only probes the server user's accounts.

## 4. Proposed `ProviderCard` JSON

One card per provider; v2.6 adds more entries in `accounts[]` with the same shape.

```ts
type ProviderId = "claude" | "codex" | "hermes" | "omp" | string; // router/custom accounts get their own id

interface ProviderCard {
  id: ProviderId;
  name: string;                       // "Claude", "Codex", "Hermes", "omp", "Router (9router)"
  kind: "cli" | "router";             // router = base URL based account list
  installed: boolean;
  version: string | null;             // "2.1.305"
  state: "connected" | "signed_out" | "not_installed" | "limited" | "error" | "checking";
  checkedAt: number;                  // epoch ms of the last completed probe
  stale: boolean;                     // true when serving a cached card while refreshing, or after a failed refresh
  error?: { code: "timeout" | "spawn" | "protocol" | "network" | "auth"; message: string }; // plain sentence for the UI
  accounts: ProviderAccount[];        // [] when not installed; one "default" entry today
  actions: ProviderAction[];
}

interface ProviderAccount {
  id: string;                         // "default", "work", "router-vps"
  label: string;                      // what the person sees: email, or "VPS (100.127.x.x)", or "OpenRouter"
  email: string | null;               // owner only
  plan: string | null;                // "Claude Pro", "plus", "pro"; owner only
  auth: "oauth" | "api_key" | "router" | "config" | "none";
  state: "connected" | "signed_out" | "limited" | "error";
  isolation: Record<string, string>;  // env NAMES -> path/URL (never keys): { CLAUDE_CONFIG_DIR: "/root/.claude" }
  usage: {
    readAt: number;
    windows: { id: "five_hour" | "weekly" | string; label: string; percent: number; resetsAt: string | null; windowMins: number | null; severity?: "normal" | "warn" | "limit" }[];
    credits?: { balance: string | null; unlimited: boolean } | null;
    reachedType?: string | null;      // Codex rateLimitReachedType, "usage_limit" for Claude
    note?: string;                    // "Usage is on the router dashboard"
  } | null;                           // null = not available for this account (router, API key)
  models: { value: string; label: string; description?: string; efforts?: string[]; isDefault?: boolean; group?: string }[];
  modelsAt: number | null;
}

interface ProviderAction {
  kind: "install" | "sign_in" | "add_account" | "fix" | "refresh" | "sign_out" | "open_dashboard";
  label: string;                      // "Sign in with ChatGPT"
  via?: "device_code" | "terminal" | "api_key" | "url" | "server";  // how the page should run it
  accountId?: string;
}
```

Sample (Claude, this box, owner view):
```json
{"id":"claude","name":"Claude","kind":"cli","installed":true,"version":"2.1.305","state":"connected",
 "checkedAt":1792932288000,"stale":false,
 "accounts":[{"id":"default","label":"<email>","email":"<email>","plan":"Claude Pro","auth":"oauth","state":"connected",
   "isolation":{"CLAUDE_CONFIG_DIR":"/root/.claude"},
   "usage":{"readAt":1792932288000,"windows":[
      {"id":"five_hour","label":"5-hour","percent":38,"resetsAt":"2026-10-25T17:29:59Z","windowMins":300,"severity":"normal"},
      {"id":"weekly","label":"Weekly","percent":4,"resetsAt":"2026-10-29T22:59:59Z","windowMins":10080,"severity":"normal"}]},
   "models":[{"value":"default","label":"Default (recommended)","description":"Sonnet 5.5 · Efficient for routine tasks","efforts":["low","medium","high","xhigh","max"]}],
   "modelsAt":1792932288000}],
 "actions":[{"kind":"add_account","label":"Add another Claude account","via":"terminal"},{"kind":"refresh","label":"Refresh"}]}
```
Sample (Codex, signed out): `state:"signed_out"`, `accounts:[]`, `actions:[{"kind":"sign_in","label":"Sign in with ChatGPT","via":"device_code"}]`.

Model pickers: `cards.filter(c => c.state === "connected" || c.state === "limited").flatMap(c => c.accounts.filter(a => a.state !== "signed_out").flatMap(a => a.models))`, grouped by `card.id` and `account.id`. A model `value` should stay what each agent already takes (`default`/`sonnet` for Claude, codex-acp model ids, omp `provider/id`, Hermes `custom:<name>`), prefixed with the account id only when v2.6 has more than one account for the provider.

## 5. Open items / unverified
- Codex signed-in replies (`account/read` with email, `account/rateLimits/read`) are from the generated schema; they need one real sign-in to confirm field values and whether `usedPercent` is 0-100.
- `omp usage` report shape for an OAuth account is unknown (empty here).
- Whether a 9router API key unlocks `/api/usage/*` (the dashboard routes returned 401 without credentials).
- `ANTHROPIC_DEFAULT_*_MODEL` aliasing and `claude auth login` under `CLAUDE_CONFIG_DIR` from a headless child were not run (the latter would open an auth flow).
- Claude's `get_usage` rate limit on Anthropic's side is undocumented; the 5 min TTL is conservative, not measured.
