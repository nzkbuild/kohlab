#!/usr/bin/env bun
/**
 * The AI hub's cards (providers.ts): what each AI's probe output becomes, who may see what, which
 * models a menu lists, how the cache behaves, and that the module reads no sign-in file and starts
 * no timer. Pure: no AI is started. Fixtures are the shapes in docs/research/ai-hub-sources.md.
 *
 * Run:  bun scripts/check-providers.ts
 */
import { readFileSync } from "node:fs";
import {
  claudeCardFrom,
  codexCardFrom,
  codexPercent,
  getProviders,
  hermesCardFrom,
  ompCardFrom,
  parseHermesAuthList,
  parseOmpModels,
  parseVersion,
  pickerModels,
  providersTest,
  redactCard,
  refreshProviders,
  signedOutCard,
  type ProviderCard,
} from "../providers.ts";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name} ${detail}`);
  }
}

const NOW = 1_792_932_288_000;
const EMAIL = "canary-person@example.test";
const CANARY_PATH = "/canary/secret/path";

// ---- Claude ----
const models = [
  { value: "default", displayName: "Default (recommended)", description: "Sonnet 5.5 · Efficient for routine tasks", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "haiku", displayName: "Haiku", description: "", supportedEffortLevels: [] },
];
const usage = (five: number, week: number, extra: Record<string, unknown> = {}) => ({
  subscription_type: "pro",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: five, resets_at: "2026-10-25T17:29:59.9+00:00" },
    seven_day: { utilization: week, resets_at: "2026-10-29T22:59:59.9+00:00" },
    limits: [
      { kind: "session", percent: five, severity: "normal" },
      { kind: "weekly_all", percent: week, severity: "normal" },
    ],
    ...extra,
  },
});
const probe = (planRaw: unknown, account: unknown = { email: EMAIL, subscriptionType: "Claude Pro", apiProvider: "firstParty" }) => ({ account: account as Record<string, unknown>, models, planRaw, at: NOW });
const claude = claudeCardFrom({ now: NOW, version: "2.1.305", loggedIn: true, method: "claude.ai", probe: probe(usage(38, 4)) });
const acct = claude.accounts[0];
check("claude: connected with one account", claude.state === "connected" && claude.accounts.length === 1 && acct.id === "default");
check("claude: email and plan", acct.email === EMAIL && acct.plan === "Claude Pro" && acct.label === EMAIL);
check("claude: two plan windows in plain words", acct.usage?.windows.map((w) => `${w.label} ${w.percent}`).join(" | ") === "Next few hours 38 | This week 4", JSON.stringify(acct.usage));
check("claude: window reset time kept", acct.usage?.windows[0].resetsAt === "2026-10-25T17:29:59.9+00:00" && acct.usage?.windows[0].windowMins === 300);
check("claude: severity normal", acct.usage?.windows.every((w) => w.severity === "normal") === true);
check("claude: models carry the value, name and effort levels", acct.models[0].value === "default" && acct.models[0].label.startsWith("Default") && acct.models[0].efforts?.length === 5 && acct.models[0].isDefault === true);
check("claude: a model with no efforts has no efforts key", !("efforts" in acct.models[1]));
check("claude: version is kept for the owner", claude.version === "2.1.305");

const full = claudeCardFrom({ now: NOW, version: null, loggedIn: true, method: "claude.ai", probe: probe(usage(100, 4, { limits: [{ kind: "session", percent: 100, severity: "limit" }] })) });
check("claude: a window at its limit makes the card limited", full.state === "limited" && full.accounts[0].state === "limited" && full.accounts[0].usage?.windows[0].severity === "limit" && full.accounts[0].usage?.reachedType === "usage_limit");
const warnProvided = claudeCardFrom({ now: NOW, version: null, loggedIn: true, method: "claude.ai", probe: probe(usage(50, 4, { limits: [{ kind: "session", percent: 50, severity: "warning" }] })) });
check("claude: severity given by the CLI wins over the percent", warnProvided.accounts[0].usage?.windows[0].severity === "warn" && warnProvided.state === "connected");
const derived = claudeCardFrom({ now: NOW, version: null, loggedIn: true, method: "claude.ai", probe: probe(usage(85, 4, { limits: undefined })) });
check("claude: severity derived when the CLI gives none (85 is a warning)", derived.accounts[0].usage?.windows[0].severity === "warn");
const apiKey = claudeCardFrom({
  now: NOW,
  version: null,
  loggedIn: true,
  method: "api_key",
  probe: probe({ rate_limits_available: false, rate_limits: null, subscription_type: null }, { tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" }),
});
check("claude: an API key is connected with no plan windows", apiKey.state === "connected" && apiKey.accounts[0].usage === null && apiKey.accounts[0].auth === "api_key" && apiKey.accounts[0].email === null);
const signedOut = claudeCardFrom({ now: NOW, version: "2.1.305", loggedIn: false, method: "none", probe: probe(null, { tokenSource: "none" }) });
check("claude: signed out has no accounts and no models", signedOut.state === "signed_out" && signedOut.accounts.length === 0 && JSON.stringify(signedOut).includes('"default"') === false);
check("claude: signed out can be signed in on the server", signedOut.actions.some((a) => a.kind === "sign_in" && a.via === "server" && !!a.hint));
const noAcct = claudeCardFrom({ now: NOW, version: null, loggedIn: null, method: null, probe: probe(null, { tokenSource: "none", apiProvider: "firstParty" }) });
check("claude: no email and no key reads as signed out even when the status check was unsure", noAcct.state === "signed_out");

// ---- Codex ----
const out = codexCardFrom({ now: NOW, version: "0.163.0", account: null, rateLimits: null, models: [] });
check("codex: no account is signed out with a device-code sign-in", out.state === "signed_out" && out.accounts.length === 0 && out.actions.some((a) => a.kind === "sign_in" && a.via === "device_code"));
const cx = (primary: number, extra: Record<string, unknown> = {}) =>
  codexCardFrom({
    now: NOW,
    version: "0.163.0",
    account: { type: "chatgpt", email: EMAIL, planType: "plus" },
    rateLimits: {
      rateLimits: {
        primary: { usedPercent: primary, windowDurationMins: 300, resetsAt: 1_792_932_000 },
        secondary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1_793_400_000 },
        credits: { hasCredits: true, unlimited: false, balance: "12.50" },
        ...extra,
      },
    },
    models: [{ value: "gpt-x", displayName: "GPT X", description: "", supportedEffortLevels: [] }],
  });
const a38 = cx(0.38).accounts[0];
check("codex: usedPercent 0.38 is 38", a38.usage?.windows[0].percent === 38);
check("codex: usedPercent 38 is 38", cx(38).accounts[0].usage?.windows[0].percent === 38);
check("codex: usedPercent is clamped to 0..100", codexPercent(250) === 100 && codexPercent(-4) === 0 && codexPercent(1) === 1 && codexPercent("x") === 0);
check("codex: resetsAt unix seconds become an ISO time", a38.usage?.windows[0].resetsAt === new Date(1_792_932_000 * 1000).toISOString());
check("codex: windows named by their length", a38.usage?.windows.map((w) => w.label).join("|") === "Next few hours|This week");
check("codex: other lengths say hours", cx(10, { primary: { usedPercent: 10, windowDurationMins: 1440, resetsAt: 1_792_932_000 } }).accounts[0].usage?.windows[0].label === "24 hours");
check("codex: credits kept", a38.usage?.credits?.balance === "12.50" && a38.usage?.credits?.unlimited === false);
check("codex: email, plan, models from its own cache", a38.email === EMAIL && a38.plan === "plus" && a38.models[0].value === "gpt-x");
check("codex: connected", cx(38).state === "connected");
check("codex: a reached limit is limited", cx(100, { rateLimitReachedType: "usage_limit" }).state === "limited");
const cxKey = codexCardFrom({ now: NOW, version: null, account: { type: "apiKey" }, rateLimits: null, models: [] });
check("codex: an API key account has no plan windows", cxKey.state === "connected" && cxKey.accounts[0].usage === null && cxKey.accounts[0].auth === "api_key");
check("codex: no models of its own yet gives an empty list", codexCardFrom({ now: NOW, version: null, account: { type: "chatgpt" }, rateLimits: null, models: [] }).accounts[0].models.length === 0);

// ---- Hermes ----
const FAKE_KEY_ID = "id=zzfakekey9";
const authList = [
  "rtk: hermes plugin warning: something harmless",
  "custom:vps (1 credentials):",
  `  #1  VPS  api_key ${FAKE_KEY_ID} priority=0 config:VPS`,
  "anthropic (2 credentials):",
  `  #1  ANTHROPIC_API_KEY  api_key ${FAKE_KEY_ID} priority=0 env:ANTHROPIC_API_KEY`,
  "  #2  gh  oauth priority=1 gh_cli",
  "openai (0 credentials):",
].join("\n");
const names = parseHermesAuthList(authList);
check("hermes: only provider names, custom: removed, empty and warning lines ignored", JSON.stringify(names) === '["vps","anthropic"]', JSON.stringify(names));
const hermes = hermesCardFrom({ now: NOW, providers: names, models: [] });
check("hermes: connected, label is the provider names", hermes.state === "connected" && hermes.accounts[0].label === "vps, anthropic");
check("hermes: no key label, id or source leaves the module", !JSON.stringify(hermes).includes("zzfakekey9") && !JSON.stringify(hermes).includes("ANTHROPIC_API_KEY") && !JSON.stringify(hermes).includes("gh_cli"));
check("hermes: nothing listed is signed out", hermesCardFrom({ now: NOW, providers: parseHermesAuthList("rtk: warning\n"), models: [] }).state === "signed_out");

// ---- omp ----
const ompJson = JSON.stringify({
  models: [
    { provider: "openrouter", kind: "x", id: "a/b", selector: "openrouter/a/b", name: "A B", contextWindow: 1, cost: { in: 1 } },
    { provider: "commandcode", id: "c", selector: "commandcode/c", name: "C" },
    { provider: "openrouter", id: "d", name: "D" },
  ],
});
const omp = ompCardFrom({ now: NOW, version: "18.4.1", modelsText: ompJson, usage: null });
const parsed = parseOmpModels(ompJson);
check("omp: trimmed to value, label and group", JSON.stringify(parsed.models[0]) === '{"value":"openrouter/a/b","label":"A B","group":"openrouter"}', JSON.stringify(parsed.models[0]));
check("omp: a model with no selector gets provider/id", parsed.models[2].value === "openrouter/d");
check("omp: providers in the list are the connected ones", JSON.stringify(parsed.providers) === '["openrouter","commandcode"]' && omp.state === "connected");
const ompEmpty = ompCardFrom({ now: NOW, version: "18.4.1", modelsText: '{"models":[]}', usage: null });
check("omp: an empty list is signed out, sign in on the server", ompEmpty.state === "signed_out" && ompEmpty.accounts.length === 0 && ompEmpty.actions.some((a) => a.via === "server" && a.hint === "On the server, run omp login."));
check("omp: unreadable output is signed out, not a crash", ompCardFrom({ now: NOW, version: null, modelsText: "not json", usage: null }).state === "signed_out");

// ---- versions ----
check("version: from the CLI line", parseVersion("2.1.305 (Claude Code)") === "2.1.305" && parseVersion("codex-cli 0.163.0") === "0.163.0" && parseVersion("omp/18.4.1") === "18.4.1" && parseVersion("none") === null);

// ---- who may see what ----
const rich: ProviderCard = {
  ...claude,
  version: "9.9.9",
  error: { code: "timeout", message: `Claude broke at ${CANARY_PATH}` },
  accounts: [{ ...claude.accounts[0], plan: "CanaryPlan", isolation: { CLAUDE_CONFIG_DIR: CANARY_PATH } }],
  actions: [{ kind: "fix", label: "Fix", hint: `look in ${CANARY_PATH}` }],
};
const red = redactCard(rich);
const redJson = JSON.stringify(red);
for (const secret of [EMAIL, "CanaryPlan", CANARY_PATH, "9.9.9", "Claude Pro"]) check(`redact: no "${secret}"`, !redJson.includes(secret));
check("redact: no usage, no actions, no isolation, label is the provider name", red.accounts[0].usage === null && red.actions.length === 0 && Object.keys(red.accounts[0].isolation).length === 0 && red.accounts[0].label === "Claude" && red.version === null);
check("redact: state, models and ids kept; error text generic", red.state === "connected" && red.accounts[0].models.length === 2 && red.accounts[0].id === "default" && red.error?.message === "This AI isn't available right now.");

// ---- model menus ----
const cards: ProviderCard[] = [
  claude,
  signedOut,
  { ...notInstalledLike("codex") },
  { ...full },
  { ...hermes, id: "hermes-error", state: "error", accounts: hermes.accounts.map((a) => ({ ...a, state: "error" as const })) },
  omp,
];
function notInstalledLike(id: string): ProviderCard {
  return { ...signedOutCard(id, NOW, null, { kind: "sign_in", label: "x" }), state: "not_installed" };
}
const groups = pickerModels(cards);
check("picker: connected and limited are listed, nothing else", groups.map((g) => g.id).join(",") === "claude,claude,omp", groups.map((g) => g.id).join(","));
check("picker: each group has its account label and models", groups[0].account === EMAIL && groups[0].models.length === 2 && groups[2].models[0].group === "openrouter");

// ---- the cache (fake clock, fake probes) ----
let t = NOW;
providersTest.setClock(() => t);
const counts: Record<string, number> = {};
let failing = false;
let release = null as null | (() => void);
function fakeProbes(slow = false) {
  const mk = (id: string) => async () => {
    counts[id] = (counts[id] ?? 0) + 1;
    if (slow) await new Promise<void>((r) => (release = r));
    if (failing && id === "claude") throw new Error("boom");
    return claudeCardFrom({ now: t, version: null, loggedIn: true, method: null, probe: probe(usage(10, 1)) });
  };
  providersTest.setProbes({ claude: mk("claude"), codex: mk("codex"), hermes: mk("hermes"), omp: mk("omp") });
}
const tick = () => new Promise<void>((r) => setImmediate(r));
const total = () => Object.values(counts).reduce((a, b) => a + b, 0);
function resetCounts() {
  for (const k of Object.keys(counts)) delete counts[k];
}

providersTest.reset();
fakeProbes();
check("cache: nothing is probed before a call", total() === 0);
t += 3_600_000;
check("cache: time passing starts no probe", total() === 0);
const first = await getProviders();
check("cache: the first call builds every card", first.providers.length === 4 && total() === 4);
await getProviders();
check("cache: a second call inside 60 s uses the cache", total() === 4);
t += 61_000;
const swr = await getProviders();
check("cache: after 60 s the old card comes back at once, marked stale", swr.providers.every((p) => p.stale) && total() === 8, `total ${total()}`);
await tick();
const fresh = await getProviders();
check("cache: the background read replaced it", fresh.providers.every((p) => !p.stale) && total() === 8);

providersTest.reset();
resetCounts();
fakeProbes(true);
const both = [getProviders(), getProviders()];
await tick();
check("cache: two callers at once share one probe per AI", total() === 4, `total ${total()}`);
for (let i = 0; i < 4; i++) {
  await tick();
  release?.();
}
await Promise.all(both);

providersTest.reset();
resetCounts();
fakeProbes();
failing = true;
t += 1000;
const bad = await getProviders();
const badClaude = bad.providers.find((p) => p.id === "claude")!;
check("cache: a failing probe gives an error card with a plain sentence", badClaude.state === "error" && /Claude/.test(badClaude.error?.message ?? "") && !/boom/.test(JSON.stringify(badClaude)));
const n = counts.claude;
t += 29_000;
await getProviders();
await tick();
check("cache: an error card is kept for 30 s", counts.claude === n);
t += 2_000;
await getProviders();
await tick();
check("cache: then it is read again", counts.claude === n + 1);
failing = false;
await tick();
t += 31_000;
await getProviders();
await tick();
const recovered = (await getProviders()).providers.find((p) => p.id === "claude")!;
check("cache: it recovers", recovered.state === "connected");
failing = true;
t += 61_000;
await getProviders();
await tick();
t += 1_000;
const kept = (await getProviders()).providers.find((p) => p.id === "claude")!;
check("cache: a failure after a good read keeps the last models, stale", kept.state === "error" && kept.stale === true && kept.accounts[0]?.models.length === 2, JSON.stringify(kept).slice(0, 200));
failing = false;

providersTest.reset();
resetCounts();
fakeProbes();
await getProviders();
const base = counts.claude;
t += 5_000;
await refreshProviders("claude");
check("refresh: a forced read goes through", counts.claude === base + 1);
t += 3_000;
const limited = await refreshProviders("claude");
check("refresh: a second one inside 10 s is not run; the cached card is marked stale", counts.claude === base + 1 && limited.providers.find((p) => p.id === "claude")!.stale === true);
check("refresh: other AIs are not read when one is named", counts.codex === 1);
t += 11_000;
await refreshProviders("claude");
check("refresh: after 10 s it runs again", counts.claude === base + 2);
await refreshProviders();
check("refresh: with no name every AI is read", counts.codex === 2 && counts.omp === 2);
providersTest.reset();

// ---- the source: no sign-in file, no timer, no message ----
const src = readFileSync(new URL("../providers.ts", import.meta.url), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("source: no setInterval", !/setInterval/.test(src));
for (const [what, re] of [
  ["credentials file", /\.credentials/],
  ["auth.json", /auth\.json/],
  ["config.yaml", /config\.yaml/],
  [".env file", /(^|[\s"'`/])\.env\b/],
  ["agent.db", /agent\.db/],
  ["models.yml", /models\.yml/],
  [".codex folder", /\.codex\b/],
  [".hermes folder", /\.hermes\b/],
  [".omp folder", /\.omp\b/],
] as const)
  check(`source: no ${what}`, !re.test(src));
check('source: never writes a type "user" line', !/type\s*:\s*["'`]user["'`]/.test(src));
check("source: no commands that print a key or are slow", !/["'`]token["'`]/.test(code) && !/["'`]dump["'`]/.test(code) && !/hermes[^\n]*--version/.test(code) && !/codex-acp[^\n]*--help/.test(code) && !/["'`]status["'`]\s*\]/.test(code.replace(/\["auth", "status"\]/g, "")));
check("source: children only get childEnv", !/process\.env/.test(code) && (code.match(/env: childEnv\(homedir\(\)\)/g) ?? []).length >= 2);
check("source: every spawn is killed with SIGKILL", (code.match(/SIGKILL/g) ?? []).length >= 3 && !/SIGTERM/.test(code));

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
