/**
 * OpenCode for Settings → AI: the install into a Kohlab-owned folder, the connections of each OpenCode profile (a browser
 * code sign-in, or an API key; several per service), and the models those connections give.
 *
 * Rules: every process runs as the AI user (mainRunAs, or runAsOf for a profile), with the allowlisted environment
 * (childEnv), its profile's XDG folders and BROWSER=none. Argv is fixed and every value is checked before it is used.
 * Every command gets `--standalone` (no background service). The one secret, an API key, goes in on stdin as JSON and is
 * never in argv, a log, the audit, a reply or an error. Only the connection's name and the service are ever shown.
 *
 * Imports only accounts and lib, so providers.ts and acp.ts can use it.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AccountError, childEnv, envOfAccount, getAccount, mainRunAs, runAsOf, signInMs, stripAnsi } from "./accounts";
import { WORKS_DIR, agentIdentity, aiUserRefusal } from "./lib";

export const OPENCODE_PACKAGE = "@opencode/cli";
/** Pinned: bump on purpose, after a check. */
export const OPENCODE_VERSION = "2.3.0";
/** The AI user's own OpenCode profile (no folder of Kohlab's): the account Settings shows as "Main account". */
export const MAIN_OPENCODE = "main:opencode";

const INTEGRATION = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const METHOD = /^[a-z][a-z0-9-]{0,39}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const FIND_MS = 20_000;
const NOT_HERE = "Not available here yet.";

/** The services shown first in the sign-in picker. Ids as `opencode auth list` shows them. */
export const POPULAR_INTEGRATIONS: { id: string; name: string }[] = [
  { id: "opencode", name: "OpenCode Console" },
  { id: "openai", name: "OpenAI" },
  { id: "github-copilot", name: "GitHub Copilot" },
  { id: "anthropic", name: "Anthropic" },
];

/** What a method is called on the page; null hides it (a method that needs a browser on the server, or the old one). Unknown ids are shown as they are. */
const METHOD_NAMES: Record<string, string | null> = {
  device: "Browser code",
  "chatgpt-headless": "Sign in with ChatGPT (code)",
  "chatgpt-browser": null,
  "chatgpt-token-sharing": null,
  key: "API key",
};
export const methodName = (id: string): string | null => (id in METHOD_NAMES ? METHOD_NAMES[id] : id);

export interface Connection {
  integration: string;
  name: string;
  /** the id OpenCode keeps the credential under (never shown) */
  id: string;
  label: string;
  method: string;
  active: boolean;
}

/** A connection as the page may see it: never its OpenCode id. */
export const connectionView = (c: Connection) => ({ integration: c.integration, name: c.name, label: c.label, method: c.method, active: c.active });

// ---- pure parsers (fixtures in scripts/check-opencode.mjs) ----

const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);

/** The methods a `--method` probe lists after "Available:". Pure. */
export function parseMethods(text: string): string[] {
  const m = stripAnsi(text).match(/Available:\s*([^\r\n]+)/);
  if (!m) return [];
  return m[1]
    .replace(/\.\s*$/, "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => METHOD.test(s));
}

/** The link and code of a browser-code sign-in (`Enter code: …` and the https link), colour and spinner codes allowed. Null until both are in the text. Pure. */
export function parseDeviceAuth(text: string): { url: string; code: string } | null {
  const plain = stripAnsi(text).replace(/\r/g, "");
  const code = plain.match(/Enter code:\s*([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/)?.[1];
  const raw = plain.match(/https:\/\/[^\s"'<>]+/)?.[0];
  let url: string | undefined;
  try {
    if (raw && new URL(raw).protocol === "https:") url = raw; // only a plain https link ever reaches an href
  } catch {
    url = undefined;
  }
  return url && code ? { url, code } : null;
}

/** `opencode auth list --format json`: one connection per credential, with the service it is for. Null when it is not that JSON. Pure. */
export function parseAuthList(text: string): Connection[] | null {
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const out: Connection[] = [];
  for (const it of list as any[]) {
    const integration = str(it?.id);
    if (!integration) continue;
    const name = (str(it?.name) ?? integration).slice(0, 60);
    for (const c of Array.isArray(it?.connections) ? it.connections : []) {
      const label = str(c?.label);
      if (!label) continue;
      out.push({ integration, name, id: str(c?.id) ?? "", label: label.slice(0, 60), method: str(c?.method) ?? "", active: false }); // auth list has no "active": listConnections fills it in from the export
    }
  }
  return out.slice(0, 200);
}

/** `opencode auth export` (which carries the secrets): only which credential ids are in use. Everything else, the keys above all, is dropped here. Null when it is not that JSON. Pure. */
export function parseActiveIds(text: string): Set<string> | null {
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const ids = new Set<string>();
  for (const it of list as any[]) if (it?.active === true && typeof it?.id === "string") ids.add(it.id);
  return ids;
}

/** `opencode models` lines: `provider/model`, grouped by the provider. Pure. */
export function parseModels(text: string): { value: string; label: string; group: string }[] {
  const out: { value: string; label: string; group: string }[] = [];
  for (const raw of stripAnsi(text).split("\n")) {
    const line = raw.trim();
    const m = /^([a-z0-9][a-z0-9._-]{0,63})\/(\S{1,180})$/i.exec(line);
    if (!m) continue;
    out.push({ value: line, label: m[2], group: m[1] });
    if (out.length >= 1500) break;
  }
  return out;
}

/** The `auth import` payload: one credential, all five fields. The key is in it and nowhere else. Pure. */
export function importPayload(credId: string, integration: string, label: string, key: string): string {
  return JSON.stringify([{ id: credId, integrationID: integration, label, active: false, value: { type: "key", key } }]);
}

// ---- checks of what a person typed (refused before anything runs) ----

const checkIntegration = (x: unknown): string => {
  if (typeof x !== "string" || !INTEGRATION.test(x)) throw new AccountError(400, "That service id is not valid.");
  return x;
};
const checkLabel = (raw: unknown, fallback?: string): string => {
  const t = typeof raw === "string" ? raw.trim() : "";
  const label = t || fallback || "";
  if (!label || label.length > 60 || CONTROL.test(label) || label.startsWith("-")) throw new AccountError(400, "Give the connection a name of up to 60 characters.");
  return label;
};

// ---- running opencode: as the AI user, in the profile ----

interface Run {
  bin: string;
  cwd: string;
  uid?: number;
  gid?: number;
  env: Record<string, string>;
}

/** The OpenCode install: the Kohlab-owned folder for the AI user, or under the server's data folder when there is no AI user. */
export function toolsDir(): string {
  const who = agentIdentity();
  return who ? join(who.home, ".kohlab-tools", "opencode") : join(WORKS_DIR, "tools", "opencode");
}

/** The opencode to run: the one Kohlab installed, else one on the server's PATH, else null. */
export function opencodeBin(): string | null {
  const local = join(toolsDir(), "node_modules", ".bin", "opencode");
  return existsSync(local) ? local : Bun.which("opencode");
}

/** How a process of a key runs: the AI's own profile (MAIN_OPENCODE) or an account's profile folder. Throws when there is no install or no such account. */
function runOf(key: string): Run {
  const bin = opencodeBin();
  if (!bin) throw new AccountError(409, "OpenCode isn't installed yet. Install it first.");
  if (key === MAIN_OPENCODE) {
    const m = mainRunAs();
    return { bin, cwd: m.home, uid: m.uid, gid: m.gid, env: { ...childEnv(m.home), BROWSER: "none" } };
  }
  const a = getAccount(key);
  if (!a || a.kind !== "login" || a.provider !== "opencode") throw new AccountError(404, "That account does not exist.");
  const r = runAsOf(a);
  return { bin, cwd: r.home, uid: r.uid, gid: r.gid, env: { ...childEnv(r.home, envOfAccount(a)), BROWSER: "none" } };
}

/** Runs opencode with the given argv (the caller adds --standalone), optional stdin, and a time limit. Output is kept for parsing only. */
function exec(run: Run, args: string[], opts: { input?: string; ms?: number } = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(run.bin, args, { cwd: run.cwd, uid: run.uid, gid: run.gid, env: run.env, stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"] });
    let out = "";
    const take = (d: Buffer) => {
      if (out.length < 64_000) out += d.toString("utf8");
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    child.stdin?.on("error", () => {});
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.ms ?? 15_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, out });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
  });
}

/** A command that reports its own result in the output: exit 0 and no "Failed" line. */
const succeeded = (r: { code: number | null; out: string }) => r.code === 0 && !/Failed/.test(stripAnsi(r.out));

/** Runs one command for a key at a time, so two writes to one profile never overlap. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(fn);
  queues.set(
    key,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

/** The connections of a key's profile. Throws when OpenCode's list could not be read. `auth list` does not say which one is in use, only `auth export` does (and it prints the keys): its output is reduced to the ids at once and never kept or logged. */
export async function listConnections(key: string): Promise<Connection[]> {
  const run = runOf(key);
  const r = await exec(run, ["auth", "list", "--format", "json", "--standalone"]);
  const list = r.code === 0 ? parseAuthList(stripAnsi(r.out)) : null;
  if (!list) throw new AccountError(500, "Could not read OpenCode's accounts. Try again.");
  if (list.length) {
    const e = await exec(run, ["auth", "export", "--standalone"]);
    const on = e.code === 0 ? parseActiveIds(stripAnsi(e.out)) : null;
    e.out = "";
    if (on) for (const c of list) c.active = on.has(c.id);
  }
  return list;
}

/** The models the profile's connections give (`provider/model`). Empty when there is none. */
export async function modelsOf(key: string): Promise<{ value: string; label: string; group: string }[]> {
  const r = await exec(runOf(key), ["models", "--standalone"], { ms: 20_000 });
  if (r.code !== 0) throw new AccountError(500, "Could not read OpenCode's models. Try again.");
  return parseModels(r.out);
}

/** The version the installed opencode reports, or null. */
export async function opencodeVersion(): Promise<string | null> {
  let run: Run;
  try {
    run = runOf(MAIN_OPENCODE);
  } catch {
    return null; // no AI user to run as: the card says "can't check", not an error
  }
  const r = await exec(run, ["--version"], { ms: 8000 });
  return /\d+\.\d+\.\d+[\w.+-]*/.exec(r.out)?.[0] ?? null;
}

// ---- which services a profile can connect to (asked of opencode, cached 10 min) ----

const methodsCache = new Map<string, { at: number; methods: { id: string; name: string }[] }>();
const METHODS_MS = 600_000;

/** The sign-in methods for a service, as the page shows them. The probe asks for a method that does not exist, so nothing signs in and no model is called. */
export async function methodsOf(integration: unknown): Promise<{ id: string; name: string }[]> {
  const int = checkIntegration(integration);
  const have = methodsCache.get(int);
  if (have && Date.now() - have.at < METHODS_MS) return have.methods;
  const r = await exec(runOf(MAIN_OPENCODE), ["auth", "login", int, "--method", "zzz", "--standalone"], { ms: 15_000 });
  const methods = parseMethods(stripAnsi(r.out)).flatMap((id) => {
    const name = methodName(id);
    return name ? [{ id, name }] : [];
  });
  if (methods.length) methodsCache.set(int, { at: Date.now(), methods });
  return methods;
}

// ---- browser-code sign-in (a child waits until the person approves in their browser) ----

export type SignInState = "idle" | "waiting" | "done" | "failed" | "expired";
export interface OpencodeSignIn {
  state: SignInState;
  url?: string;
  code?: string;
  error?: string;
}
interface Pending {
  integration: string;
  method: string;
  child: ChildProcess;
  state: Exclude<SignInState, "idle">;
  url?: string;
  code?: string;
  error?: string;
  out: string;
}
const pending = new Map<string, Pending>();

const stopChild = (p: Pending): void => {
  if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGTERM");
};

/** Where a key's sign-in stands, for the page to poll. */
export function signInStateOf(key: string): OpencodeSignIn {
  const p = pending.get(key);
  if (!p) return { state: "idle" };
  return { state: p.state, ...(p.state === "waiting" && p.url ? { url: p.url, code: p.code } : {}), ...(p.error ? { error: p.error } : {}) };
}

/** Starts a browser-code sign-in for a service, or returns the one already waiting for it. Resolves once the link and code are printed (or it failed). A new start replaces a sign-in that is not waiting any more, and stops one that is. */
export async function startOpencodeSignIn(key: string, integration: unknown, method: unknown): Promise<OpencodeSignIn> {
  const int = checkIntegration(integration);
  if (typeof method !== "string" || !METHOD.test(method) || method === "key") throw new AccountError(400, "That sign-in method is not valid.");
  const run = runOf(key);
  const have = pending.get(key);
  if (have?.state === "waiting" && have.integration === int && have.method === method) {
    await waitUntil(key);
    return signInStateOf(key);
  }
  if (have) stopChild(have);
  const child = spawn(run.bin, ["auth", "login", int, "--method", method, "--standalone"], { cwd: run.cwd, uid: run.uid, gid: run.gid, env: run.env, stdio: ["ignore", "pipe", "pipe"] });
  const cur: Pending = { integration: int, method, child, state: "waiting", out: "" };
  pending.set(key, cur);
  let settle!: () => void;
  const ready = new Promise<void>((r) => (settle = r));
  readyOf.set(key, ready);
  let findTimer: ReturnType<typeof setTimeout> | undefined;
  let expireTimer: ReturnType<typeof setTimeout> | undefined;
  const fail = (error: string) => {
    clearTimeout(findTimer);
    clearTimeout(expireTimer);
    if (cur.state === "waiting") {
      cur.state = "failed";
      cur.error = error;
    }
    stopChild(cur);
    settle();
  };
  const onData = (d: Buffer) => {
    cur.out = (cur.out + d.toString("utf8")).slice(-8000);
    if (/interactive terminal/i.test(stripAnsi(cur.out))) return fail(NOT_HERE);
    const found = parseDeviceAuth(cur.out);
    if (found && !cur.url) {
      cur.url = found.url;
      cur.code = found.code;
      clearTimeout(findTimer);
      settle();
    }
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  child.on("error", () => fail("Could not start OpenCode's sign-in. Try again."));
  child.on("exit", async (code) => {
    clearTimeout(findTimer);
    clearTimeout(expireTimer);
    if (cur.state !== "waiting") return;
    if (code === 0) {
      // the approval is only real when OpenCode now lists a connection for this service
      const ok = await listConnections(key).then(
        (c) => c.some((x) => x.integration === int),
        () => false,
      );
      if (cur.state !== "waiting") return; // the time ran out meanwhile
      if (!ok) return fail("Sign-in did not finish. Start again.");
      cur.state = "done";
      settle();
      return;
    }
    fail(cur.url ? "Sign-in did not finish. Start again." : "Could not start OpenCode's sign-in. Try again.");
  });
  findTimer = setTimeout(() => {
    if (!cur.url) fail("Could not read the sign-in code from OpenCode. Try again.");
  }, FIND_MS);
  expireTimer = setTimeout(() => {
    if (cur.state !== "waiting") return;
    cur.state = "expired";
    cur.error = "Sign-in timed out. Start again.";
    stopChild(cur);
    settle();
  }, signInMs());
  await ready;
  return signInStateOf(key);
}

/** The "ready" promise of a key's latest sign-in (resolved once its link is printed or it ended). */
const readyOf = new Map<string, Promise<void>>();
async function waitUntil(key: string): Promise<void> {
  await readyOf.get(key);
}

/** Ends sign-ins still waiting, so no `opencode auth login` outlives the server. */
export function stopOpencodeSignIns(): void {
  for (const p of pending.values()) if (p.state === "waiting") stopChild(p);
}

/** Forgets a key's sign-in (its profile was removed). */
export function forgetOpencodeProfile(key: string): void {
  const p = pending.get(key);
  if (p) stopChild(p);
  pending.delete(key);
  readyOf.delete(key);
}

// ---- API keys (stdin only) and the connections of a profile ----

/** Saves an API key as a connection of a service: the key goes to `auth import` on stdin, under a new id Kohlab makes. The first connection of a service is used at once; so is any the person chose to use now. Returns the profile's connections. */
export async function addKey(key: string, integration: unknown, secret: unknown, label: unknown, useNow: unknown): Promise<Connection[]> {
  const int = checkIntegration(integration);
  if (typeof secret !== "string" || secret.length < 8 || secret.length > 4000 || CONTROL.test(secret)) throw new AccountError(400, "That key is not valid.");
  const name = checkLabel(label, "API key");
  return serial(key, async () => {
    const run = runOf(key);
    const before = await listConnections(key);
    if (before.some((c) => c.integration === int && c.label === name)) throw new AccountError(409, "That name is already used for this service.");
    const credId = `cred_kohlab_${randomBytes(9).toString("hex")}`;
    const r = await exec(run, ["auth", "import", "--standalone"], { input: importPayload(credId, int, name, secret), ms: 20_000 });
    if (r.code !== 0) throw new AccountError(500, "Could not save that key. Check it and try again.");
    const after = await listConnections(key);
    if (!after.some((c) => c.integration === int && c.label === name)) throw new AccountError(500, "Could not save that key. Check it and try again.");
    if (useNow === true || !before.some((c) => c.integration === int)) {
      if (!succeeded(await exec(run, ["auth", "switch", int, name, "--standalone"]))) throw new AccountError(500, "Saved, but could not use it now. Try again.");
    }
    return listConnections(key);
  });
}

/** Makes one connection of a service the one OpenCode uses. Returns the profile's connections. */
export function switchConnection(key: string, integration: unknown, label: unknown): Promise<Connection[]> {
  const int = checkIntegration(integration);
  const name = checkLabel(label);
  return serial(key, async () => {
    if (!succeeded(await exec(runOf(key), ["auth", "switch", int, name, "--standalone"]))) throw new AccountError(400, "Could not change it. Check the name and try again.");
    return listConnections(key);
  });
}

/** Removes one connection of a service. Returns the profile's connections. */
export function logoutConnection(key: string, integration: unknown, label: unknown): Promise<Connection[]> {
  const int = checkIntegration(integration);
  const name = checkLabel(label);
  return serial(key, async () => {
    if (!succeeded(await exec(runOf(key), ["auth", "logout", int, name, "--standalone"]))) throw new AccountError(400, "Could not sign out of that one. Try again.");
    return listConnections(key);
  });
}

// ---- the install (owner only, no root, pinned version, scripts approved) ----

export type InstallState = "idle" | "installing" | "done" | "failed";
let install: { state: InstallState; error?: string } = { state: "idle" };

/** The argv of each install step, in order. The steps after the first run in the install folder. Pure. */
export function installArgs(dir: string): string[][] {
  return [
    ["install", "--prefix", dir, `${OPENCODE_PACKAGE}@${OPENCODE_VERSION}`, "--ignore-scripts=false"],
    ["install-scripts", "approve", OPENCODE_PACKAGE],
    ["rebuild", "--prefix", dir, OPENCODE_PACKAGE],
  ];
}

/** Runs the install steps through `exec` (argv, folder) and says how it ended. The first failed step ends it. */
export async function runInstall(dir: string, exec: (args: string[], cwd: string) => Promise<boolean>): Promise<"done" | "failed"> {
  for (const args of installArgs(dir)) if (!(await exec(args, dir))) return "failed";
  return "done";
}

/** Where the install stands. A copy already there counts as done. */
export function installStatus(): { state: InstallState; error?: string } {
  if (install.state === "installing") return install;
  if (opencodeBin()) return { state: "done" };
  return install.state === "failed" ? install : { state: "idle" };
}

/** Starts the install in the background, or returns the one running. Runs npm as the AI user, with a minimal environment. */
export function startInstall(): { state: InstallState; error?: string } {
  if (install.state === "installing") return install;
  const refusal = aiUserRefusal({});
  if (refusal) throw new AccountError(409, refusal);
  if (opencodeBin()) return { state: "done" };
  const npm = Bun.which("npm");
  if (!npm) return (install = { state: "failed", error: "npm isn't installed on this server." });
  const dir = toolsDir();
  const m = mainRunAs();
  const who = agentIdentity();
  install = { state: "installing" };
  void (async () => {
    try {
      // root never creates or chowns anything in the AI user's home (it could be a planted link): the AI user makes the folder
      if (who) await new Promise<void>((resolve, reject) => execFile("mkdir", ["-p", "--", dir], { env: childEnv(m.home), uid: m.uid, gid: m.gid, timeout: 30_000 }, (err) => (err ? reject(err) : resolve())));
      else mkdirSync(dir, { recursive: true, mode: 0o755 });
      const env = childEnv(m.home);
      const result = await runInstall(dir, (args, cwd) => new Promise<boolean>((resolve) => execFile(npm, args, { cwd, env, uid: m.uid, gid: m.gid, timeout: 600_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (err) => resolve(!err))));
      install = result === "done" && opencodeBin() ? { state: "done" } : { state: "failed", error: "Install did not finish. Try again." };
    } catch {
      install = { state: "failed", error: "Install did not finish. Try again." };
    }
  })();
  return install;
}

/** For the checks only: forget the install state and any memory of sign-ins and method lists. */
export const opencodeTest = {
  reset(): void {
    install = { state: "idle" };
    methodsCache.clear();
    for (const p of pending.values()) p.child.kill("SIGKILL");
    pending.clear();
    readyOf.clear();
    queues.clear();
  },
};
