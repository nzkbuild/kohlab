/**
 * The AI hub's data: for each AI on this computer (Claude, Codex, Hermes, omp), whether it is installed,
 * whether it is signed in, which account, how much of its plan is used and which models it offers.
 *
 * Rules (SECURITY.md, "AI hub data"): a probe never sends a message or calls a model; no file that holds a
 * sign-in or a key is opened; children get only the allowlisted environment (childEnv); every process is
 * bounded by a timeout that kills it and a cap on what it may print; nothing runs on a timer (a probe runs
 * when someone asks); the owner's email, plan, usage, versions and error text never reach anyone else
 * (redactCard).
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { agentModels, childEnv, claudeProbe, type Caps, type ClaudeProbe } from "./chat";
import { clearCodexSignedIn, codexSignedIn } from "./codex";

export type ProviderId = "claude" | "codex" | "hermes" | "omp" | (string & {});

export interface ProviderModel {
  value: string;
  label: string;
  description?: string;
  efforts?: string[];
  isDefault?: boolean;
  group?: string;
}
export interface ProviderWindow {
  id: string;
  label: string;
  percent: number;
  resetsAt: string | null;
  windowMins: number | null;
  severity: "normal" | "warn" | "limit";
}
export interface ProviderUsage {
  readAt: number;
  windows: ProviderWindow[];
  credits?: { balance: string | null; unlimited: boolean } | null;
  reachedType?: string | null;
  note?: string;
}
export interface ProviderAccount {
  id: string;
  label: string;
  email: string | null;
  plan: string | null;
  auth: "oauth" | "api_key" | "router" | "config" | "none";
  state: "connected" | "signed_out" | "limited" | "error";
  isolation: Record<string, string>;
  usage: ProviderUsage | null;
  models: ProviderModel[];
  modelsAt: number | null;
}
export interface ProviderAction {
  kind: "install" | "sign_in" | "add_account" | "fix" | "refresh" | "sign_out" | "open_dashboard";
  label: string;
  via?: "device_code" | "terminal" | "api_key" | "url" | "server";
  accountId?: string;
  hint?: string;
}
export interface ProviderCard {
  id: ProviderId;
  name: string;
  kind: "cli" | "router";
  installed: boolean;
  version: string | null;
  state: "connected" | "signed_out" | "not_installed" | "limited" | "error" | "checking";
  checkedAt: number;
  stale: boolean;
  error?: { code: "timeout" | "spawn" | "protocol" | "network" | "auth"; message: string };
  accounts: ProviderAccount[];
  actions: ProviderAction[];
}

export const PROVIDER_IDS: ProviderId[] = ["claude", "codex", "hermes", "omp"];
const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", hermes: "Hermes", omp: "omp" };
export const NO_MODELS_YET = "Models appear after your first chat with it.";

// ---- time, and the caches (in memory; a call is what starts a probe, never a timer) ----

let clock: () => number = () => Date.now();

const TTL_CARD = 60_000;
const TTL_ERROR = 30_000;
const TTL_USAGE = 300_000;
const TTL_OMP_MODELS = 600_000;
const TTL_HERMES = 300_000;
const FORCE_GAP = 10_000;
const FIRST_WAIT = 8_000;

/** A value kept for ttl ms; callers at the same moment share one run. A failed run is not kept. */
const memos = new Map<string, { at: number; value: Promise<unknown> }>();
function memo<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const have = memos.get(key);
  if (have && clock() - have.at < ttl) return have.value as Promise<T>;
  const value = fn();
  const entry = { at: clock(), value };
  memos.set(key, entry);
  value.catch(() => {
    if (memos.get(key) === entry) memos.delete(key);
  });
  return value;
}
function dropMemos(id: string): void {
  for (const k of memos.keys()) if (k.startsWith(`${id}:`)) memos.delete(k);
}

// ---- running a program: bounded in time and in what it may print ----

type Ran = { out: string; code: number | null; fail: "spawn" | "timeout" | "protocol" | null };

/** Runs a program with the allowlisted environment. Killed (SIGKILL) at timeoutMs or when it prints more than maxBytes; what it writes to stderr is dropped. */
function run(cmd: string, args: string[], timeoutMs: number, maxBytes = 512 * 1024): Promise<Ran> {
  return new Promise((resolve) => {
    const bin = Bun.which(cmd);
    if (!bin) return resolve({ out: "", code: null, fail: "spawn" });
    let out = "";
    let fail: Ran["fail"] = null;
    let done = false;
    const child = spawn(bin, args, { cwd: homedir(), env: childEnv(homedir()), stdio: ["ignore", "pipe", "pipe"] });
    const end = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ out, code, fail });
    };
    const timer = setTimeout(() => {
      fail = "timeout";
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > maxBytes) {
        out = out.slice(0, maxBytes);
        fail ??= "protocol";
        child.kill("SIGKILL");
      }
    });
    child.stderr!.on("data", () => {});
    child.on("error", () => {
      fail ??= "spawn";
      end(null);
    });
    child.on("close", (code) => end(code));
  });
}

class ProbeError extends Error {
  constructor(
    readonly code: NonNullable<ProviderCard["error"]>["code"],
    message: string,
  ) {
    super(message);
  }
}

const SEMVER = /\d+\.\d+\.\d+[\w.+-]*/;
/** The version number in a CLI's --version line, or null. Pure. */
export function parseVersion(text: string): string | null {
  return SEMVER.exec(text)?.[0] ?? null;
}

// ---- pure parsers (fixtures in scripts/check-providers.ts) ----

/** Parse `claude auth status` stdout: `loggedIn` as a boolean, or null when it is not that JSON. */
export function parseClaudeLoggedIn(stdout: string): boolean | null {
  try {
    const v = JSON.parse(stdout) as { loggedIn?: unknown } | null;
    return typeof v?.loggedIn === "boolean" ? v.loggedIn : null;
  } catch {
    return null;
  }
}

/** The sign-in method `claude auth status` reports ("claude.ai", "api_key", ...), or null. Pure. */
export function parseClaudeAuthMethod(stdout: string): string | null {
  try {
    const v = JSON.parse(stdout) as { authMethod?: unknown } | null;
    return typeof v?.authMethod === "string" ? v.authMethod : null;
  } catch {
    return null;
  }
}

const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);
const clampPercent = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function severityOf(provided: unknown, percent: number): ProviderWindow["severity"] {
  if (typeof provided === "string") {
    const p = provided.toLowerCase();
    if (p === "normal" || p === "ok") return "normal";
    if (/limit|critical|reached|exceed|block/.test(p)) return "limit";
    if (/warn|high|elevated/.test(p)) return "warn";
  }
  return percent >= 100 ? "limit" : percent >= 80 ? "warn" : "normal";
}

/** The two plan windows in a Claude get_usage reply ("Next few hours", "This week"), or null when the account has none (an API key, a router). Pure. */
export function parseClaudeUsage(reply: any, readAt: number): ProviderUsage | null {
  const rl = reply?.rate_limits;
  if (!reply?.rate_limits_available || !rl || typeof rl !== "object") return null;
  const limits: any[] = Array.isArray(rl.limits) ? rl.limits : [];
  const sev = (kind: string) => limits.find((l) => l?.kind === kind)?.severity;
  const windows: ProviderWindow[] = [];
  const add = (id: string, label: string, w: any, kind: string, mins: number) => {
    if (!w || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) return;
    windows.push({
      id,
      label,
      percent: clampPercent(w.utilization),
      resetsAt: typeof w.resets_at === "string" ? w.resets_at : null,
      windowMins: mins,
      severity: severityOf(sev(kind), w.utilization),
    });
  };
  add("five_hour", "Next few hours", rl.five_hour, "session", 300);
  add("weekly", "This week", rl.seven_day, "weekly_all", 10080);
  if (windows.length === 0) return null;
  const hit = windows.some((w) => w.severity === "limit");
  return { readAt, windows, reachedType: hit ? "usage_limit" : null };
}

/** Claude's models for the menus: the value Claude takes, its name and the effort levels it supports. Pure. */
export function claudeModels(models: Caps["models"]): ProviderModel[] {
  return models.map((m) => ({
    value: m.value,
    label: m.displayName,
    ...(m.description ? { description: m.description } : {}),
    ...(m.supportedEffortLevels.length ? { efforts: m.supportedEffortLevels } : {}),
    ...(m.value === "default" ? { isDefault: true } : {}),
  }));
}

/** An AI's own cached model list as the hub's model list. Empty until the AI has been used in a chat. Pure. */
export function cachedModels(models: Caps["models"]): ProviderModel[] {
  return claudeModels(models);
}

/** Codex's usedPercent as 0 to 100. A fraction (0.38) is read as a share; anything else is clamped. Pure. */
export function codexPercent(x: unknown): number {
  const n = typeof x === "number" && Number.isFinite(x) ? x : 0;
  return clampPercent(n <= 1 && !Number.isInteger(n) ? n * 100 : n);
}

/** The label of a Codex window by its length. Pure. */
export function codexWindowLabel(mins: number | null): string {
  if (mins === null) return "Usage";
  if (mins <= 360) return "Next few hours";
  if (mins >= 10080) return "This week";
  return `${Math.max(1, Math.round(mins / 60))} hours`;
}

/** The windows and credits in a Codex account/rateLimits/read reply. Reaching a limit is `rateLimitReachedType`. Pure. */
export function parseCodexUsage(reply: any, readAt: number): ProviderUsage | null {
  const rl = reply?.rateLimits;
  if (!rl || typeof rl !== "object") return null;
  const windows: ProviderWindow[] = [];
  const reached = str(rl.rateLimitReachedType);
  for (const key of ["primary", "secondary"]) {
    const w = rl[key];
    if (!w || typeof w !== "object") continue;
    const percent = codexPercent(w.usedPercent);
    const mins = typeof w.windowDurationMins === "number" && w.windowDurationMins > 0 ? w.windowDurationMins : null;
    const at = typeof w.resetsAt === "number" && w.resetsAt > 0 ? new Date(w.resetsAt * 1000).toISOString() : null;
    windows.push({ id: key, label: codexWindowLabel(mins), percent, resetsAt: at, windowMins: mins, severity: reached ? "limit" : severityOf(null, percent) });
  }
  const c = rl.credits;
  const credits = c && typeof c === "object" ? { balance: str(c.balance) ?? (typeof c.balance === "number" ? String(c.balance) : null), unlimited: c.unlimited === true } : null;
  if (windows.length === 0 && !credits) return null;
  return { readAt, windows, ...(credits ? { credits } : {}), reachedType: reached };
}

/** The AIs `hermes auth list` says have a sign-in: the provider heading lines only. The lines under them (labels, ids, sources) are never read. Pure. */
export function parseHermesAuthList(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r/g, "");
    if (/^\s*rtk:/i.test(line) || /^\s/.test(line) || line.startsWith("#")) continue; // a warning, or a line under a heading
    const m = /^([^\s(][^()]*?)\s*\((\d+) credentials?\):\s*$/i.exec(line);
    if (!m || Number(m[2]) < 1) continue;
    const name = m[1].replace(/^custom:/i, "").trim().slice(0, 60);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** omp's `models --json`: the models trimmed to a value omp accepts, a name and the provider they come from. The providers that appear are the signed-in ones. Pure. */
export function parseOmpModels(text: string): { providers: string[]; models: ProviderModel[] } {
  let list: any[] = [];
  try {
    const j = JSON.parse(text);
    list = Array.isArray(j?.models) ? j.models : [];
  } catch {
    list = [];
  }
  const models: ProviderModel[] = [];
  const providers: string[] = [];
  for (const m of list) {
    const provider = str(m?.provider);
    const value = str(m?.selector) ?? (provider && str(m?.id) ? `${provider}/${m.id}` : null);
    if (!provider || !value) continue;
    if (!providers.includes(provider)) providers.push(provider);
    if (models.length < 1500) models.push({ value: value.slice(0, 200), label: (str(m?.name) ?? str(m?.id) ?? value).slice(0, 120), group: provider.slice(0, 60) });
  }
  return { providers, models };
}

/** Usage windows in `omp usage --json`, only where the fields are the ones expected; anything else is ignored. Pure. */
export function parseOmpUsage(text: string, readAt: number): ProviderUsage | null {
  let reports: any[] = [];
  try {
    const j = JSON.parse(text);
    reports = Array.isArray(j?.reports) ? j.reports : [];
  } catch {
    return null;
  }
  const windows: ProviderWindow[] = [];
  for (const r of reports.slice(0, 10)) {
    for (const w of [...(Array.isArray(r?.windows) ? r.windows : []), ...(Array.isArray(r?.limits) ? r.limits : [])].slice(0, 6)) {
      const raw = [w?.usedPercent, w?.percent, w?.utilization].find((x) => typeof x === "number");
      if (typeof raw !== "number") continue;
      const percent = codexPercent(raw);
      const mins = typeof w.windowMins === "number" ? w.windowMins : typeof w.windowDurationMins === "number" ? w.windowDurationMins : null;
      const at = typeof w.resetsAt === "string" ? w.resetsAt : typeof w.resetsAt === "number" ? new Date(w.resetsAt * (w.resetsAt < 1e12 ? 1000 : 1)).toISOString() : null;
      windows.push({ id: `w${windows.length}`, label: codexWindowLabel(mins), percent, resetsAt: at, windowMins: mins, severity: severityOf(null, percent) });
    }
  }
  return windows.length ? { readAt, windows } : null;
}

// ---- cards from what the probes read (pure) ----

const refreshAction: ProviderAction = { kind: "refresh", label: "Refresh" };
const serverSignIn = (hint: string): ProviderAction => ({ kind: "sign_in", label: "Sign in", via: "server", hint });

function baseCard(id: ProviderId, now: number): ProviderCard {
  return { id, name: NAMES[id] ?? String(id), kind: "cli", installed: true, version: null, state: "checking", checkedAt: now, stale: false, accounts: [], actions: [refreshAction] };
}

/** A card for an AI that is not on this computer: nothing is started for it. */
export function notInstalledCard(id: ProviderId, now: number): ProviderCard {
  return {
    ...baseCard(id, now),
    installed: false,
    state: "not_installed",
    actions: [{ kind: "fix", label: "Set up", hint: "Ask whoever installed Kohlab to set it up." }, refreshAction],
  };
}

/** A card for an AI that is installed but signed out. */
export function signedOutCard(id: ProviderId, now: number, version: string | null, signIn: ProviderAction): ProviderCard {
  return { ...baseCard(id, now), version, state: "signed_out", actions: [signIn, refreshAction] };
}

const SENTENCES: Record<string, string> = {
  timeout: "didn't answer in time. Try again in a moment.",
  spawn: "couldn't be started on the server.",
  protocol: "answered in a way Kohlab didn't understand.",
  network: "couldn't reach its service just now.",
  auth: "needs to be signed in again on the server.",
};

/** A card for a probe that failed: a plain sentence, and the last good accounts (models, usage) kept, marked stale. */
export function errorCard(id: ProviderId, now: number, code: NonNullable<ProviderCard["error"]>["code"], last?: ProviderCard): ProviderCard {
  const name = NAMES[id] ?? String(id);
  return {
    ...baseCard(id, now),
    installed: last?.installed ?? true,
    version: last?.version ?? null,
    state: "error",
    stale: !!last && last.accounts.length > 0,
    error: { code, message: `${name} ${SENTENCES[code] ?? SENTENCES.protocol}` },
    accounts: (last?.accounts ?? []).map((a) => ({ ...a, state: "error" as const })),
    actions: [{ kind: "fix", label: "Try again", hint: `Check that ${name} works on the server, then press Refresh.` }, refreshAction],
  };
}

function accountCard(id: ProviderId, now: number, version: string | null, account: ProviderAccount): ProviderCard {
  return { ...baseCard(id, now), version, state: account.state === "limited" ? "limited" : "connected", accounts: [account] };
}

/** Claude's card from `auth status` and one initialize + get_usage reading. Signed out shows no models; an API key shows no plan windows. Pure. */
export function claudeCardFrom(
  a: { now: number; version: string | null; loggedIn: boolean | null; method: string | null; probe: Pick<ClaudeProbe, "account" | "models" | "planRaw" | "at"> },
): ProviderCard {
  const acct = a.probe.account ?? {};
  const email = str((acct as any).email);
  const apiKey = a.method === "api_key" || (str((acct as any).apiKeySource) !== null && str((acct as any).apiKeySource) !== "none");
  if (a.loggedIn === false || (!email && !apiKey)) return signedOutCard("claude", a.now, a.version, serverSignIn("On the server, run claude auth login."));
  const usage = apiKey ? null : parseClaudeUsage(a.probe.planRaw, a.probe.at);
  const limited = usage?.windows.some((w) => w.severity === "limit") ?? false;
  return accountCard("claude", a.now, a.version, {
    id: "default",
    label: email ?? "API key",
    email,
    plan: str((acct as any).subscriptionType),
    auth: apiKey ? "api_key" : "oauth",
    state: limited ? "limited" : "connected",
    isolation: {},
    usage,
    models: claudeModels(a.probe.models),
    modelsAt: a.probe.at,
  });
}

/** Codex's card from its sign-in check, its account/read reply, its rate limits and its own cached model list. Pure. */
export function codexCardFrom(a: { now: number; version: string | null; account: any; rateLimits: any; models: Caps["models"] }): ProviderCard {
  const acct = a.account;
  if (!acct || typeof acct !== "object") return signedOutCard("codex", a.now, a.version, { kind: "sign_in", label: "Sign in with ChatGPT", via: "device_code" });
  const chat = acct.type === "chatgpt";
  const usage = chat ? parseCodexUsage(a.rateLimits, a.now) : null;
  const limited = !!usage && (usage.reachedType != null || usage.windows.some((w) => w.severity === "limit"));
  const email = str(acct.email);
  return accountCard("codex", a.now, a.version, {
    id: "default",
    label: email ?? (chat ? "ChatGPT" : "API key"),
    email,
    plan: str(acct.planType),
    auth: chat ? "oauth" : "api_key",
    state: limited ? "limited" : "connected",
    isolation: {},
    usage,
    models: cachedModels(a.models),
    modelsAt: a.models.length ? a.now : null,
  });
}

/** Hermes' card from the providers `hermes auth list` named. Pure. */
export function hermesCardFrom(a: { now: number; providers: string[]; models: Caps["models"] }): ProviderCard {
  if (a.providers.length === 0) return signedOutCard("hermes", a.now, null, serverSignIn("On the server, add a sign-in with hermes auth."));
  return accountCard("hermes", a.now, null, {
    id: "default",
    label: a.providers.join(", ").slice(0, 80),
    email: null,
    plan: null,
    auth: "config",
    state: "connected",
    isolation: {},
    usage: null,
    models: cachedModels(a.models),
    modelsAt: a.models.length ? a.now : null,
  });
}

/** omp's card from `omp models --json` (the providers in it are the signed-in ones) and its usage reading. Pure. */
export function ompCardFrom(a: { now: number; version: string | null; modelsText: string; usage: ProviderUsage | null }): ProviderCard {
  const { providers, models } = parseOmpModels(a.modelsText);
  if (providers.length === 0) return signedOutCard("omp", a.now, a.version, serverSignIn("On the server, run omp login."));
  const limited = a.usage?.windows.some((w) => w.severity === "limit") ?? false;
  return accountCard("omp", a.now, a.version, {
    id: "default",
    label: providers.join(", ").slice(0, 80),
    email: null,
    plan: null,
    auth: "config",
    state: limited ? "limited" : "connected",
    isolation: {},
    usage: a.usage,
    models,
    modelsAt: a.now,
  });
}

// ---- who may see what ----

const GENERIC_ERROR = "This AI isn't available right now.";

/** The card another person (a member, a viewer) may see: which AIs are ready and their models. No email, plan, usage, version, error text, paths or actions. Pure. */
export function redactCard(c: ProviderCard): ProviderCard {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    installed: c.installed,
    version: null,
    state: c.state,
    checkedAt: c.checkedAt,
    stale: c.stale,
    ...(c.error ? { error: { code: c.error.code, message: GENERIC_ERROR } } : {}),
    accounts: c.accounts.map((a) => ({
      id: a.id,
      label: c.name,
      email: null,
      plan: null,
      auth: "none" as const,
      state: a.state,
      isolation: {},
      usage: null,
      models: a.models,
      modelsAt: a.modelsAt,
    })),
    actions: [],
  };
}

export interface PickerGroup {
  id: ProviderId;
  name: string;
  account: string;
  accountId: string;
  models: ProviderModel[];
}

/** The AIs a model menu lists: signed in (connected, or limited for now) only, each with its models. Pure. */
export function pickerModels(cards: ProviderCard[]): PickerGroup[] {
  const out: PickerGroup[] = [];
  for (const c of cards) {
    if (c.state !== "connected" && c.state !== "limited") continue;
    for (const a of c.accounts) {
      if (a.state !== "connected" && a.state !== "limited") continue;
      out.push({ id: c.id, name: c.name, account: a.label, accountId: a.id, models: a.models });
    }
  }
  return out;
}

// ---- the probes ----

type Ctx = { force: boolean };

/** claude auth status: signed in or not, and how. Shared for 60 s. */
function claudeAuth(): Promise<{ loggedIn: boolean | null; method: string | null }> {
  return memo("claude:auth", TTL_CARD, async () => {
    const r = await run("claude", ["auth", "status"], 8000);
    if (r.fail === "spawn") throw new ProbeError("spawn", "");
    if (r.fail) return { loggedIn: null, method: null };
    return { loggedIn: parseClaudeLoggedIn(r.out), method: parseClaudeAuthMethod(r.out) };
  });
}

/** Whether Claude is signed in on this server (shared for 60 s). Null when it could not be told. */
export function claudeSignedIn(): Promise<boolean | null> {
  return claudeAuth().then(
    (a) => a.loggedIn,
    () => null,
  );
}

function versionOf(key: string, cmd: string, args: string[]): Promise<string | null> {
  // once per process: a version does not change under a running server
  return memo(`${key}:version`, Number.POSITIVE_INFINITY, async () => parseVersion((await run(cmd, args, 5000, 4096)).out));
}

function classify(e: unknown): NonNullable<ProviderCard["error"]>["code"] {
  if (e instanceof ProbeError) return e.code;
  const m = (e as Error)?.message ?? "";
  if (/in time|timed out|timeout/i.test(m)) return "timeout";
  if (/not installed|stopped|ENOENT|spawn/i.test(m)) return "spawn";
  return "protocol";
}

async function claudeProbeCard(ctx: Ctx): Promise<ProviderCard> {
  const now = clock();
  if (!Bun.which("claude")) return notInstalledCard("claude", now);
  const version = await versionOf("claude", "claude", ["--version"]);
  const auth = await claudeAuth();
  if (auth.loggedIn === false) return signedOutCard("claude", now, version, serverSignIn("On the server, run claude auth login."));
  const probe = await claudeProbe(ctx.force ? 0 : TTL_USAGE);
  return claudeCardFrom({ now, version, loggedIn: auth.loggedIn, method: auth.method, probe });
}

/** One short conversation with `codex app-server` on private stdio: initialize, account/read, and the rate limits for a ChatGPT account. No model is called. Killed when done or at 10 s. */
async function codexRead(): Promise<{ account: any; rateLimits: any }> {
  const bin = Bun.which("codex");
  if (!bin) throw new ProbeError("spawn", "");
  const child = spawn(bin, ["app-server"], { cwd: homedir(), env: childEnv(homedir()), stdio: ["pipe", "pipe", "pipe"] });
  child.stderr!.on("data", () => {});
  child.stdin!.on("error", () => {});
  let seq = 0;
  let bytes = 0;
  const waits = new Map<number, { res: (m: any) => void; rej: (e: Error) => void }>();
  const failAll = (e: Error) => {
    for (const w of waits.values()) w.rej(e);
    waits.clear();
  };
  child.stdout!.on("data", (d: Buffer) => {
    bytes += d.length;
    if (bytes > 2 * 1024 * 1024) child.kill("SIGKILL");
  });
  createInterface({ input: child.stdout! }).on("line", (l) => {
    let m: any;
    try {
      m = JSON.parse(l);
    } catch {
      return;
    }
    if (typeof m?.id === "number" && waits.has(m.id)) {
      waits.get(m.id)!.res(m);
      waits.delete(m.id);
    }
  });
  child.on("error", () => failAll(new ProbeError("spawn", "")));
  child.on("exit", () => failAll(new ProbeError("protocol", "")));
  const timer = setTimeout(() => {
    failAll(new ProbeError("timeout", ""));
    child.kill("SIGKILL");
  }, 10_000);
  const call = (method: string, params?: unknown) =>
    new Promise<any>((res, rej) => {
      const id = ++seq;
      waits.set(id, { res, rej });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n");
    });
  try {
    await call("initialize", { clientInfo: { name: "kohlab", version: "1" }, capabilities: {} });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    const acct = await call("account/read", { refreshToken: false });
    const account = acct?.result?.account ?? null;
    let rateLimits: any = null;
    if (account?.type === "chatgpt") {
      const rl = await call("account/rateLimits/read");
      rateLimits = rl?.error ? null : (rl?.result ?? null);
    }
    return { account, rateLimits };
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}

async function codexProbeCard(ctx: Ctx): Promise<ProviderCard> {
  const now = clock();
  if (!Bun.which("codex") || !Bun.which("codex-acp")) return notInstalledCard("codex", now);
  const version = await versionOf("codex", "codex", ["--version"]);
  const signedIn = await codexSignedIn();
  if (signedIn === null) throw new ProbeError("protocol", "");
  if (!signedIn) return signedOutCard("codex", now, version, { kind: "sign_in", label: "Sign in with ChatGPT", via: "device_code" });
  void ctx;
  const read = await memo("codex:read", TTL_USAGE, codexRead);
  return codexCardFrom({ now, version, account: read.account, rateLimits: read.rateLimits, models: agentModels("codex") });
}

async function hermesProbeCard(): Promise<ProviderCard> {
  const now = clock();
  if (!Bun.which("hermes")) return notInstalledCard("hermes", now);
  const text = await memo("hermes:auth", TTL_HERMES, async () => {
    const r = await run("hermes", ["auth", "list"], 10_000);
    if (r.fail || r.code !== 0) throw new ProbeError(r.fail ?? "protocol", "");
    return r.out;
  });
  return hermesCardFrom({ now, providers: parseHermesAuthList(text), models: agentModels("hermes") });
}

async function ompProbeCard(): Promise<ProviderCard> {
  const now = clock();
  if (!Bun.which("omp")) return notInstalledCard("omp", now);
  const version = (await versionOf("omp", "omp", ["--version"])) ?? null;
  const modelsText = await memo("omp:models", TTL_OMP_MODELS, async () => {
    const r = await run("omp", ["models", "--json"], 10_000, 2_500_000);
    if (r.fail || r.code !== 0) throw new ProbeError(r.fail ?? "protocol", "");
    return r.out;
  });
  let usage: ProviderUsage | null = null;
  if (parseOmpModels(modelsText).providers.length) {
    usage = await memo("omp:usage", TTL_USAGE, async () => {
      const r = await run("omp", ["usage", "--json"], 8000);
      return r.fail || r.code !== 0 ? null : parseOmpUsage(r.out, clock());
    }).catch(() => null);
  }
  return ompCardFrom({ now, version, modelsText, usage });
}

type Probe = (ctx: Ctx) => Promise<ProviderCard>;
let probes: Record<string, Probe> = {
  claude: claudeProbeCard,
  codex: codexProbeCard,
  hermes: hermesProbeCard,
  omp: ompProbeCard,
};

// ---- cards: cached, one probe at a time per AI, stale while a new one runs ----

interface Kept {
  card: ProviderCard;
  at: number;
  ttl: number;
}
const kept = new Map<string, Kept>();
const lastGood = new Map<string, ProviderCard>();
const inflight = new Map<string, Promise<ProviderCard>>();
const lastForced = new Map<string, number>();

function build(id: string, force: boolean): Promise<ProviderCard> {
  const have = inflight.get(id);
  if (have) return have;
  const p = (probes[id] ?? (() => Promise.reject(new ProbeError("protocol", ""))))({ force })
    .then(
      (card) => {
        const t = clock();
        const full: ProviderCard = { ...card, checkedAt: t, version: card.version };
        if (full.state === "connected" || full.state === "limited") lastGood.set(id, full);
        else if (full.state === "signed_out" || full.state === "not_installed") lastGood.delete(id);
        kept.set(id, { card: full, at: t, ttl: TTL_CARD });
        return full;
      },
      (e) => {
        console.warn(`[providers] ${id}:`, (e as Error).message || classify(e));
        const t = clock();
        const full = errorCard(id, t, classify(e), lastGood.get(id));
        kept.set(id, { card: full, at: t, ttl: TTL_ERROR });
        return full;
      },
    )
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

function checkingCard(id: string): ProviderCard {
  const c = baseCard(id, clock());
  return { ...c, installed: !!Bun.which(id === "codex" ? "codex" : id), actions: [] };
}

function current(): { providers: ProviderCard[]; at: number } {
  const t = clock();
  const providers = PROVIDER_IDS.map((id) => {
    const k = kept.get(id);
    if (!k) return checkingCard(id);
    return t - k.at >= k.ttl && !k.card.stale ? { ...k.card, stale: true } : k.card;
  });
  return { providers, at: Math.max(0, ...providers.map((p) => p.checkedAt)) };
}

/** Every AI's card, at once from the cache. A card older than its time is served marked stale while one new probe runs in the background. The first call after a start waits up to 8 s for the first cards; a probe still running then shows as "checking". */
export async function getProviders(): Promise<{ providers: ProviderCard[]; at: number }> {
  const t = clock();
  const first: Promise<unknown>[] = [];
  for (const id of PROVIDER_IDS) {
    const k = kept.get(id);
    if (!k) first.push(build(id, false));
    else if (t - k.at >= k.ttl) void build(id, false);
  }
  if (first.length) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(first), new Promise((r) => (timer = setTimeout(r, FIRST_WAIT)))]);
    clearTimeout(timer);
  }
  return current();
}

/** Forgets what is cached for one AI (or all) and reads it again. At most one forced read per AI per 10 s: inside that, the cached card is returned marked stale. */
export async function refreshProviders(id?: string): Promise<{ providers: ProviderCard[]; at: number }> {
  const ids = id && PROVIDER_IDS.includes(id) ? [id] : PROVIDER_IDS;
  await Promise.all(
    ids.map(async (pid) => {
      const t = clock();
      const last = lastForced.get(pid);
      const k = kept.get(pid);
      if (last !== undefined && t - last < FORCE_GAP && k) {
        kept.set(pid, { ...k, card: { ...k.card, stale: true } });
        return;
      }
      lastForced.set(pid, t);
      dropMemos(pid);
      if (pid === "codex") clearCodexSignedIn();
      await build(pid, true);
    }),
  );
  return current();
}

/** For the checks only: a fake clock, fake probes, and a clean slate. */
export const providersTest = {
  setClock(fn: () => number): void {
    clock = fn;
  },
  setProbes(p: Record<string, Probe>): void {
    probes = p;
  },
  reset(): void {
    kept.clear();
    lastGood.clear();
    inflight.clear();
    lastForced.clear();
    memos.clear();
  },
};
