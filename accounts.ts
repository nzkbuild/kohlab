/**
 * Accounts: more than one sign-in for Claude or Codex, and Claude through a router or an API address.
 *
 * Rules (SECURITY.md, "Accounts and router keys"):
 *  - ${WORKS_DIR}/accounts/ is 0700. accounts.json (0600) holds no secret. secrets.json (0600) holds the router keys,
 *    {id: key}: it is the one file Kohlab keeps a secret in, and the only one it reads one from.
 *  - A login account is a fresh, empty directory signed in once, here: it is the only copy of that login, so no refresh
 *    token is ever split between two copies. It is never copied, synced, put in a project or shared, and never is ~/.claude.
 *    Every process of that account (chat, probe, sign-in) uses the same directory.
 *  - A key leaves this file only as an environment variable of a process of a project on that router (accountEnv). It is
 *    never an argument, never in state.json, the audit log, a transcript, a reply or an error.
 *  - Writes are atomic (a temp file beside, then rename).
 *
 * Imports only lib, so providers.ts, codex.ts and chat.ts can all use it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WORKS_DIR, agentIdentity, identityOf } from "./lib";
import type { Workspace } from "./types";

// ---- the environment a child gets ----

/** The only keys copied into a child, never the server's secrets (KOHLAB_KEY and friends). Same allowlist as the PTY daemon (SAFE_ENV_KEYS in pty-daemon.cjs). */
const SAFE_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SHELL", "USER", "LOGNAME"];
/** The only extra keys an account may add: which sign-in directory, or which router. Anything else is dropped. */
const ACCOUNT_ENV_KEYS = new Set([
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
]);

/** The environment a child agent gets: the allowlisted keys from the server's, its own HOME, and (only) an account's variables. */
export function childEnv(home: string, extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  env.HOME = home;
  for (const [k, v] of Object.entries(extra ?? {})) if (ACCOUNT_ENV_KEYS.has(k) && typeof v === "string") env[k] = v;
  return env;
}

/** Removes terminal colour, cursor and hyperlink codes. Pure. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

// ---- the store ----

export type Provider = "claude" | "codex";
export interface Account {
  id: string;
  provider: Provider;
  kind: "login" | "router";
  label: string;
  createdAt: number;
  /** the OS account the sign-in directory belongs to (undefined = the server's own) */
  uid?: number;
  gid?: number;
  /** router: the address, without a trailing slash. Never sent to a browser in full. */
  baseUrl?: string;
  /** router: the model ids it listed at the last check */
  models?: string[];
}
interface Overlay {
  names: Record<string, string>;
  custom: { value: string; label: string }[];
}
interface Store {
  accounts: Account[];
  limits: Record<string, number>;
  overlays: Record<string, Overlay>;
}

export class AccountError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const root = () => join(WORKS_DIR, "accounts");
const storeFile = () => join(root(), "accounts.json");
const secretsFile = () => join(root(), "secrets.json");

function ensureRoot(): void {
  mkdirSync(root(), { recursive: true, mode: 0o700 });
  chmodSync(root(), 0o700);
}

/** Writes a file atomically at 0600: a temp file beside it, then a rename. */
function atomicWrite(file: string, data: string): void {
  ensureRoot();
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return j && typeof j === "object" ? (j as T) : fallback;
  } catch {
    return fallback;
  }
}

function readStore(): Store {
  const s = readJson<Partial<Store>>(storeFile(), {});
  return { accounts: Array.isArray(s.accounts) ? s.accounts : [], limits: s.limits && typeof s.limits === "object" ? s.limits : {}, overlays: s.overlays && typeof s.overlays === "object" ? s.overlays : {} };
}
const writeStore = (s: Store) => atomicWrite(storeFile(), JSON.stringify(s, null, 2));
const readSecrets = (): Record<string, string> => readJson<Record<string, string>>(secretsFile(), {});
const writeSecrets = (s: Record<string, string>) => atomicWrite(secretsFile(), JSON.stringify(s));

// ---- accounts ----

const ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const RESERVED_IDS = new Set(["default"]);
export const isAccountId = (x: unknown): x is string => typeof x === "string" && ID.test(x) && !RESERVED_IDS.has(x);

export function listAccounts(provider?: Provider): Account[] {
  return readStore().accounts.filter((a) => !provider || a.provider === provider);
}
export const getAccount = (id: unknown): Account | undefined => (typeof id === "string" ? readStore().accounts.find((a) => a.id === id) : undefined);

/** The directory of a login account's sign-in. Never inside a project or ~/.claude. */
export const dirOf = (id: string): string => join(root(), id);

const cleanLabel = (raw: unknown): string => {
  const label = typeof raw === "string" ? raw.trim() : "";
  if (!label || label.length > 60 || /[\x00-\x1f\x7f]/.test(label)) throw new AccountError(400, "Give the account a name of up to 60 characters.");
  return label;
};

function newId(label: string, taken: Set<string>): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 18).replace(/-+$/, "") || "acct";
  for (let i = 0; i < 20; i++) {
    const id = `${slug}-${randomBytes(2).toString("hex")}`;
    if (!taken.has(id) && isAccountId(id)) return id;
  }
  throw new AccountError(500, "Could not name the account. Try again.");
}

/** The sign-in directory of an account is owned by the OS account the AI runs as, so that account can write its login there. */
function giveDir(dir: string, uid: number, gid: number): void {
  chownSync(dir, uid, gid);
}

/** A second sign-in: an empty directory, signed in later (startSignIn). */
export function createLogin(provider: unknown, label: unknown): Account {
  if (provider !== "claude" && provider !== "codex") throw new AccountError(400, "That AI has no accounts.");
  const clean = cleanLabel(label);
  const s = readStore();
  const id = newId(clean, new Set(s.accounts.map((a) => a.id)));
  const agent = agentIdentity();
  mkdirSync(dirOf(id), { recursive: true, mode: 0o700 });
  chmodSync(dirOf(id), 0o700);
  if (agent) giveDir(dirOf(id), agent.uid, agent.gid);
  const a: Account = { id, provider, kind: "login", label: clean, createdAt: Date.now(), ...(agent ? { uid: agent.uid, gid: agent.gid } : {}) };
  s.accounts.push(a);
  writeStore(s);
  return a;
}

/** The address of a router, checked: http or https, no sign-in in it, nothing after the path. Returns it without a trailing slash and the host to show. Pure. */
export function parseRouterUrl(raw: unknown): { url: string; host: string } {
  let u: URL;
  try {
    u = new URL(typeof raw === "string" ? raw.trim() : "");
  } catch {
    throw new AccountError(400, "That is not an address. Try http://127.0.0.1:20128.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new AccountError(400, "The address must start with http:// or https://.");
  if (u.username || u.password) throw new AccountError(400, "Leave the user name and password out of the address.");
  if (u.search || u.hash) throw new AccountError(400, "Leave the question mark and what follows out of the address.");
  if (!u.hostname) throw new AccountError(400, "That is not an address. Try http://127.0.0.1:20128.");
  const path = u.pathname.replace(/\/+$/, "");
  return { url: `${u.protocol}//${u.host}${path}`, host: u.host };
}

const cleanKey = (raw: unknown): string => {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 500 || /[\s\x00-\x1f\x7f]/.test(raw)) throw new AccountError(400, "That key is not valid.");
  return raw;
};

export function createRouter(label: unknown, baseUrl: unknown, key: unknown): Account {
  const clean = cleanLabel(label);
  const { url } = parseRouterUrl(baseUrl);
  const k = cleanKey(key);
  const s = readStore();
  const id = newId(clean, new Set(s.accounts.map((a) => a.id)));
  const a: Account = { id, provider: "claude", kind: "router", label: clean, createdAt: Date.now(), baseUrl: url };
  const secrets = readSecrets();
  secrets[id] = k;
  writeSecrets(secrets); // the key first: an account without a stored key is useless, a key without an account is harmless
  s.accounts.push(a);
  writeStore(s);
  return a;
}

/** Renames an account (the name people see; its id and files stay). */
export function renameAccount(id: string, label: unknown): Account {
  const clean = cleanLabel(label);
  const s = readStore();
  const a = s.accounts.find((x) => x.id === id);
  if (!a) throw new AccountError(404, "That account does not exist.");
  a.label = clean;
  writeStore(s);
  return a;
}

/** Replaces a router's key. Write-only: nothing ever reads it back to a caller. */
export function setKey(id: string, key: unknown): void {
  const a = getAccount(id);
  if (!a || a.kind !== "router") throw new AccountError(404, "That account does not exist.");
  const secrets = readSecrets();
  secrets[id] = cleanKey(key);
  writeSecrets(secrets);
}

export const hasKey = (id: string): boolean => typeof readSecrets()[id] === "string";

/** Removes an account: its sign-in directory, its key and everything kept about it. Returns it, or undefined if there was none. */
export function remove(id: string): Account | undefined {
  const s = readStore();
  const a = s.accounts.find((x) => x.id === id);
  if (!a) return undefined;
  s.accounts = s.accounts.filter((x) => x.id !== id);
  delete s.overlays[id];
  for (const k of Object.keys(s.limits)) if (k.endsWith(`:${id}`)) delete s.limits[k];
  writeStore(s);
  const secrets = readSecrets();
  if (id in secrets) {
    delete secrets[id];
    writeSecrets(secrets);
  }
  if (isAccountId(id)) rmSync(dirOf(id), { recursive: true, force: true });
  signIns.get(id)?.child.kill("SIGTERM");
  signIns.delete(id);
  signedIn.delete(id);
  return a;
}

/** Whether a project's AI may use this account: the account's sign-in belongs to the OS account the AI runs as. A router account has no files, but a member's own OS account is kept out of it too: its key would be in that account's process. */
export function usableBy(a: Account, ws: Pick<Workspace, "ownerId" | "asAgent">): boolean {
  const who = identityOf(ws as Workspace);
  if (a.kind === "router") return !who || ws.asAgent === true;
  return (a.uid ?? -1) === (who?.uid ?? -1);
}

/** The home a process of an account runs with. */
const homeOf = (a: Account): string => (a.uid !== undefined ? (agentIdentity()?.home ?? homedir()) : homedir());

/** What a process of an account is given: its directory, or its router. Nothing else. */
export function envOfAccount(a: Account): Record<string, string> {
  if (a.kind === "login") return a.provider === "claude" ? { CLAUDE_CONFIG_DIR: dirOf(a.id) } : { CODEX_HOME: dirOf(a.id) };
  const key = readSecrets()[a.id];
  if (!a.baseUrl || !key) return {};
  const first = a.models?.[0];
  // Claude's own model names (opus, sonnet, haiku) would be sent to the router as they are: point them at a model the router has
  return {
    ANTHROPIC_BASE_URL: a.baseUrl,
    ANTHROPIC_AUTH_TOKEN: key,
    ...(first ? { ANTHROPIC_DEFAULT_OPUS_MODEL: first, ANTHROPIC_DEFAULT_SONNET_MODEL: first, ANTHROPIC_DEFAULT_HAIKU_MODEL: first } : {}),
  };
}

/** The account a project's AI runs on and what it adds to the process: empty for the AI's own login, or when the account is gone, is another AI's, or is not for this project. */
export function accountEnv(ws: Pick<Workspace, "account" | "agent" | "ownerId" | "asAgent">): Record<string, string> {
  if (!ws.account) return {};
  const a = getAccount(ws.account);
  if (!a || a.provider !== ws.agent || !usableBy(a, ws)) return {};
  return envOfAccount(a);
}

/** The sign-in directory a project's Claude writes its transcripts under, when it has its own account; else undefined (the home's .claude). */
export function configDirOf(ws: Pick<Workspace, "account" | "agent" | "ownerId" | "asAgent">): string | undefined {
  return accountEnv(ws).CLAUDE_CONFIG_DIR;
}

/** The identity and home a process of an account runs as (for the probe and the sign-in). */
export function runAsOf(a: Account): { uid?: number; gid?: number; home: string } {
  return { uid: a.uid, gid: a.gid, home: homeOf(a) };
}

/** `provider:id` of a lane's account, for the limit and sign-in tables. */
export const slot = (provider: string, accountId: string | null | undefined): string => `${provider}:${accountId || "default"}`;

/** The lane a conversation is on: the AI, and its account when it has one. Sessions and "what it has seen" are kept per lane. */
export const laneKey = (agent: string, account?: string | null): string => (account ? `${agent}@${account}` : agent);

// ---- limits ----

let limits: Map<string, number> | null = null;
function limitMap(): Map<string, number> {
  if (!limits) limits = new Map(Object.entries(readStore().limits).filter(([, v]) => typeof v === "number"));
  return limits;
}

/** Remembers that an account is at its limit until a time (epoch ms). In memory and in accounts.json. */
export function markLimited(provider: string, accountId: string | null | undefined, until: number): void {
  const m = limitMap();
  const k = slot(provider, accountId);
  m.set(k, until);
  try {
    const s = readStore();
    s.limits = Object.fromEntries([...m].filter(([, v]) => v > Date.now()));
    writeStore(s);
  } catch (e) {
    console.warn("[accounts] could not save the limit:", (e as Error).message);
  }
}

/** When an account's limit lifts (epoch ms), or 0 when it is not at one. Only the cache: it never probes. */
export function limitedUntil(provider: string, accountId: string | null | undefined): number {
  const v = limitMap().get(slot(provider, accountId)) ?? 0;
  return v > Date.now() ? v : 0;
}

/** Forgets a limit (the account was used again, or its plan renewed). */
export function clearLimit(provider: string, accountId: string | null | undefined): void {
  limitMap().delete(slot(provider, accountId));
}

// ---- who is signed in (what the last probe or sign-in found; unknown = not asked) ----

const signedIn = new Map<string, boolean>();
export const setSignedIn = (id: string, v: boolean): void => void signedIn.set(id, v);
export const signedInOf = (id: string): boolean | undefined => signedIn.get(id);

// ---- the router check ----

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetcher = (url, init) => fetch(url, init);
/** For the checks only: a fake network. */
export function setFetch(f: Fetcher | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init));
}

export type RouterCheck = "ok" | "key_rejected" | "unreachable";
const BODY_CAP = 1024 * 1024;

/** Asks a router for its models with the key. Never paid. 200 is connected; 401 and 403 are a key it did not accept; anything else, a redirect, a timeout or a refusal is unreachable. The models come back as ids (a body over 1 MB is cut, and what could not be read is ignored). */
export async function checkRouter(baseUrl: string, key: string): Promise<{ check: RouterCheck; models: string[] }> {
  try {
    const res = await fetchImpl(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${key}` }, redirect: "manual", signal: AbortSignal.timeout(5000) });
    if (res.status === 401 || res.status === 403) {
      void res.body?.cancel().catch(() => {});
      return { check: "key_rejected", models: [] };
    }
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => {});
      return { check: "unreachable", models: [] };
    }
    let text = "";
    if (res.body) {
      const reader = res.body.getReader();
      let size = 0;
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        text += dec.decode(value, { stream: true });
        if (size > BODY_CAP) {
          void reader.cancel().catch(() => {});
          text = "";
          break;
        }
      }
    }
    let ids: string[] = [];
    try {
      const j = JSON.parse(text);
      ids = (Array.isArray(j?.data) ? j.data : []).map((m: any) => m?.id).filter((x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 200 && !/[\s\x00-\x1f]/.test(x)).slice(0, 1000);
    } catch {
      /* connected, but not a list we can read */
    }
    return { check: "ok", models: ids };
  } catch {
    return { check: "unreachable", models: [] };
  }
}

/** Checks a router account with its stored key and keeps the model ids it listed. */
export async function testRouter(id: string): Promise<{ check: RouterCheck; models: string[] }> {
  const a = getAccount(id);
  const key = readSecrets()[id];
  if (!a || a.kind !== "router" || !a.baseUrl) throw new AccountError(404, "That account does not exist.");
  if (!key) return { check: "key_rejected", models: [] };
  const got = await checkRouter(a.baseUrl, key);
  if (got.check === "ok" && got.models.length) {
    const s = readStore();
    const row = s.accounts.find((x) => x.id === id);
    if (row) {
      row.models = got.models;
      writeStore(s);
    }
  }
  return got;
}

/** The router's models grouped by the part before the first "/" (the provider the router calls them by). Pure. */
export function groupRouterModels(ids: string[]): { group: string; ids: string[] }[] {
  const out = new Map<string, string[]>();
  for (const id of ids) {
    const i = id.indexOf("/");
    const g = i > 0 ? id.slice(0, i) : "other";
    out.set(g, [...(out.get(g) ?? []), id]);
  }
  return [...out].map(([group, list]) => ({ group, ids: list }));
}

// ---- models: names and custom ones, per account ----

const ownerKey = (provider: string, accountId: string): string => (accountId === "default" ? `default:${provider}` : accountId);

/** A model id a person may add: up to 200 characters, no spaces or control characters. */
export const validModelId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\s\x00-\x1f\x7f]/.test(v);
const cleanModelLabel = (raw: unknown, fallback: string): string => {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (!t) return fallback.slice(0, 60);
  if (t.length > 60 || /[\x00-\x1f\x7f]/.test(t)) throw new AccountError(400, "A model name can be up to 60 characters.");
  return t;
};

export function overlayOf(provider: string, accountId: string): Overlay {
  const o = readStore().overlays[ownerKey(provider, accountId)];
  return { names: o?.names ?? {}, custom: o?.custom ?? [] };
}

function editOverlay(provider: string, accountId: string, fn: (o: Overlay) => void): void {
  if (accountId !== "default" && !getAccount(accountId)) throw new AccountError(404, "That account does not exist.");
  const s = readStore();
  const k = ownerKey(provider, accountId);
  const o = (s.overlays[k] ??= { names: {}, custom: [] });
  o.names ??= {};
  o.custom ??= [];
  fn(o);
  writeStore(s);
}

export function addCustomModel(provider: string, accountId: string, value: unknown, label: unknown): void {
  if (!validModelId(value)) throw new AccountError(400, "A model id has no spaces and is up to 200 characters.");
  const name = cleanModelLabel(label, value);
  editOverlay(provider, accountId, (o) => {
    if (o.custom.some((m) => m.value === value)) throw new AccountError(409, "That model is already there.");
    if (o.custom.length >= 100) throw new AccountError(400, "That is as many custom models as can be added.");
    o.custom.push({ value, label: name });
  });
}

export function renameModel(provider: string, accountId: string, value: unknown, label: unknown): void {
  if (!validModelId(value)) throw new AccountError(400, "That model is not valid.");
  const name = cleanModelLabel(label, value);
  editOverlay(provider, accountId, (o) => {
    const c = o.custom.find((m) => m.value === value);
    if (c) c.label = name;
    else o.names[value] = name;
  });
}

export function removeCustomModel(provider: string, accountId: string, value: unknown): void {
  if (!validModelId(value)) throw new AccountError(400, "That model is not valid.");
  editOverlay(provider, accountId, (o) => {
    if (!o.custom.some((m) => m.value === value)) throw new AccountError(404, "That is not a custom model.");
    o.custom = o.custom.filter((m) => m.value !== value);
    delete o.names[value];
  });
}

// ---- the view a browser gets ----

export interface AccountView {
  id: string;
  provider: Provider;
  kind: "login" | "router";
  label: string;
  baseUrlHost?: string;
  hasKey?: boolean;
  signedIn?: boolean;
  createdAt: number;
}

/** An account as the browser may see it: never a key, a directory or the full address. Only the owner gets the host. */
export function accountView(a: Account, owner: boolean): AccountView {
  let host: string | undefined;
  try {
    host = a.baseUrl ? new URL(a.baseUrl).host : undefined;
  } catch {
    host = undefined;
  }
  const si = signedInOf(a.id);
  return {
    id: a.id,
    provider: a.provider,
    kind: a.kind,
    label: a.label,
    ...(owner && host ? { baseUrlHost: host } : {}),
    ...(owner && a.kind === "router" ? { hasKey: hasKey(a.id) } : {}),
    ...(si !== undefined ? { signedIn: si } : {}),
    createdAt: a.createdAt,
  };
}

// ---- Claude sign-in as a managed child (spike S1) ----

const SIGNIN_MS = 15 * 60_000;
const FIND_MS = 20_000;
export interface SignInView {
  state: "idle" | "waiting" | "done" | "failed" | "manual";
  url?: string;
  needsCode?: boolean;
  command?: string;
  error?: string;
}
interface SignIn {
  child: ChildProcess;
  state: "waiting" | "done" | "failed" | "manual";
  url?: string;
  needsCode: boolean;
  error?: string;
  out: string;
  ready: Promise<void>;
  settled: boolean;
}
const signIns = new Map<string, SignIn>();

/** The sign-in link in `claude auth login` output, colour and hyperlink codes allowed. Null until it is in the text. Pure. */
export function parseClaudeLoginUrl(text: string): string | null {
  const url = stripAnsi(text).match(/https:\/\/[^\s"'<>\x00-\x1f\x7f]+/)?.[0];
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null; // only a plain https link ever reaches an href
  } catch {
    return null;
  }
}

/** Where a sign-in stands, for the page to poll. */
export function signInState(id: string): SignInView {
  const s = signIns.get(id);
  if (!s) return { state: "idle" };
  return {
    state: s.state,
    ...(s.state === "waiting" && s.url ? { url: s.url, needsCode: s.needsCode } : {}),
    ...(s.state === "manual" ? { command: `CLAUDE_CONFIG_DIR=${dirOf(id)} claude auth login` } : {}),
    ...(s.error ? { error: s.error } : {}),
  };
}

/** Starts `claude auth login --claudeai` under the account's own directory, or returns the one already waiting. Resolves once the link is printed (or it could not be). */
export async function startSignIn(id: string): Promise<SignInView> {
  const a = getAccount(id);
  if (!a || a.kind !== "login" || a.provider !== "claude") throw new AccountError(404, "That account does not exist.");
  const have = signIns.get(id);
  if (have?.state === "waiting") {
    await have.ready;
    return signInState(id);
  }
  const bin = Bun.which("claude");
  const run = runAsOf(a);
  let settle!: () => void;
  const cur: SignIn = { child: undefined as unknown as ChildProcess, state: "waiting", needsCode: false, out: "", ready: new Promise<void>((r) => (settle = r)), settled: false };
  signIns.set(id, cur);
  if (!bin) {
    cur.state = "manual";
    cur.settled = true;
    settle();
    return signInState(id);
  }
  const child = spawn(bin, ["auth", "login", "--claudeai"], { cwd: run.home, uid: run.uid, gid: run.gid, env: childEnv(run.home, { CLAUDE_CONFIG_DIR: dirOf(id) }), stdio: ["pipe", "pipe", "pipe"] });
  cur.child = child;
  child.stdin!.on("error", () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = () => {
    cur.settled = true;
    settle();
  };
  const fail = (error: string) => {
    clearTimeout(timer);
    clearTimeout(findTimer);
    if (cur.state === "waiting") {
      cur.state = "failed";
      cur.error = error;
    }
    done();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  const onData = (d: Buffer) => {
    cur.out = (cur.out + d).slice(-8000);
    const url = parseClaudeLoginUrl(cur.out);
    if (url && !cur.url) {
      cur.url = url;
      cur.needsCode = /paste code/i.test(stripAnsi(cur.out));
      clearTimeout(findTimer);
      done();
    }
    if (cur.url && /paste code/i.test(stripAnsi(cur.out))) cur.needsCode = true;
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  child.on("error", () => {
    clearTimeout(findTimer);
    if (!cur.url) {
      cur.state = "manual"; // it could not be started here: the person can run the command themselves
      done();
    } else fail("Could not start the sign-in. Try again.");
  });
  child.on("exit", (code) => {
    clearTimeout(timer);
    clearTimeout(findTimer);
    if (cur.state !== "waiting") return;
    if (code === 0) {
      cur.state = "done";
      setSignedIn(id, true);
      done();
    } else fail(/login failed/i.test(stripAnsi(cur.out)) ? "That code was not accepted. Start again." : cur.url ? "Sign-in did not finish. Start again." : "Could not start the sign-in. Try again.");
  });
  const findTimer = setTimeout(() => {
    if (!cur.url && cur.state === "waiting") {
      cur.state = "manual";
      done();
      child.kill("SIGTERM");
    }
  }, FIND_MS);
  timer = setTimeout(() => fail("The sign-in expired. Start again."), SIGNIN_MS);
  await cur.ready;
  return signInState(id);
}

/** Gives the code the person pasted from the sign-in page to the waiting sign-in. */
export function submitCode(id: string, code: unknown): SignInView {
  const s = signIns.get(id);
  if (!s || s.state !== "waiting" || !s.needsCode) throw new AccountError(409, "No sign-in is waiting for a code.");
  const c = typeof code === "string" ? code.trim() : "";
  if (!/^[\w\-#.~%+=/]{4,500}$/.test(c)) throw new AccountError(400, "That code does not look right. Copy all of it.");
  s.child.stdin!.write(`${c}\n`);
  return signInState(id);
}

/** Ends sign-ins still waiting, so no `claude auth login` outlives the server. */
export function stopSignIns(): void {
  for (const s of signIns.values()) if (s.state === "waiting" && s.child && s.child.exitCode === null) s.child.kill("SIGTERM");
}

/** For the checks only: forget in-memory state. */
export const accountsTest = {
  reset(): void {
    limits = null;
    signedIn.clear();
    for (const s of signIns.values()) s.child?.kill("SIGKILL");
    signIns.clear();
  },
  exists: (id: string) => existsSync(dirOf(id)),
};
