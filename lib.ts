// works — PTY-daemon-backed coding-agent workspace runner
// State lives in $WORKS_DIR/state.json. Sessions are node-pty sessions
// owned by pty-daemon.cjs, spoken to over a Unix socket.

import type { Workspace, User, Role, WorkspaceLimits } from "./types";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { appendFile, mkdir, open, readFile, realpath, rename, rm, stat } from "fs/promises";
import { basename, join } from "path";
import { randomBytes } from "crypto";
import { spawn, spawnSync } from "child_process";
import { cwd } from "process";

/**
 * Where state lives. An explicit `WORKS_DIR` always wins.
 *
 * Without one, the two entrypoints want opposite things. The server keeps the
 * historical default — a `.works/` directory beside the code — so a local dev
 * run never silently adopts a deployment's state. A one-shot CLI must not: with
 * no `WORKS_DIR` it used to report an empty fleet against a service serving
 * `/root/.kohlab`, which is worse than useless. So the CLI asks the systemd unit
 * first, and only then falls back.
 */
function resolveWorksDir(): string {
  if (process.env.WORKS_DIR) return process.env.WORKS_DIR;
  const serverProcess = /(^|\/)server\.ts$/.test(process.argv[1] ?? "");
  if (!serverProcess) {
    try {
      const unit = process.env.KOHLAB_UNIT ?? "kohlab";
      const out = spawnSync("systemctl", ["show", unit, "-p", "Environment"], { encoding: "utf8" });
      // systemd merges every Environment= line into ONE line, so WORKS_DIR can
      // sit anywhere on it — matching only at the start finds nothing.
      const m = /.*WORKS_DIR=([^ ]+)/.exec(out.stdout ?? "");
      if (m) return m[1];
    } catch {}
  }
  return join(cwd(), ".works");
}

const WORKS_DIR = resolveWorksDir();
const STATE_FILE = join(WORKS_DIR, "state.json");
const USERS_FILE = join(WORKS_DIR, "users.json");
const AUDIT_FILE = join(WORKS_DIR, "audit.log");
/** Where a key generated at startup is kept, when none was configured. */
const KEY_FILE = join(WORKS_DIR, "key");

/**
 * The access key — or one generated on the spot, when this server is about to be
 * reachable from somewhere other than this box with no authentication at all.
 *
 * Without a key and without named users, every route treats an anonymous caller
 * as the owner, so the first person to find the port owns the machine. That is
 * acceptable only on loopback, where the only caller is already on the box. Bound
 * anywhere else — the default — it is not acceptable, and leaving it to a firewall
 * the operator may not know they need is not a safety net.
 *
 * So: bound beyond loopback, keyless and userless, the server generates a key,
 * stores it beside the state at 0600, and says so. Nothing else changes; a
 * deployment that sets KOHLAB_KEY or has members is untouched.
 */
function resolveAccessKey(): string | undefined {
  if (process.env.KOHLAB_KEY) return process.env.KOHLAB_KEY;
  const host = process.env.HOST ?? "0.0.0.0";
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return undefined;
  if (existsSync(USERS_FILE)) return undefined; // named users already gate every route
  const key = randomBytes(24).toString("hex");
  try {
    mkdirSync(WORKS_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(KEY_FILE, key + "\n", { mode: 0o600 });
    console.warn(
      `[kohlab] no KOHLAB_KEY, and this server is reachable beyond localhost — generated one.\n` +
        `[kohlab] it is in ${KEY_FILE}. Set KOHLAB_KEY yourself to choose your own.`,
    );
  } catch (e) {
    console.warn(`[kohlab] no KOHLAB_KEY and this server is exposed; could not store one (${(e as Error).message}). Set KOHLAB_KEY.`);
  }
  return key;
}
/** Webhook URL to hit when an agent finishes (optional). */
const NOTIFY_WEBHOOK = process.env.NOTIFY_WEBHOOK;
/** Interval (ms) for the completion watcher. */
const WATCH_INTERVAL = Number(process.env.WATCH_INTERVAL ?? 2000);
/** If set, the dashboard/API require this key (?key= or Bearer). */
const ACCESS_KEY = resolveAccessKey();
// --- OS-user provisioning helpers (v1.8 isolation) -----------------------
// Every named member maps to a real POSIX user: their agent sessions run as
// that uid/gid with $HOME=/home/<user>, so the filesystem — not just the
// role check — keeps members out of each other's data. Helpers here degrade
// to no-ops when the server isn't root (dev boxes), and `useradd` failures
// surface as clear errors instead of half-created state.

const OS_USER_PREFIX = process.env.KOHLAB_OS_USER_PREFIX ?? "koh";
const SYSTEM_UID = typeof process.getuid === "function" ? process.getuid() : -1;

function isRoot(): boolean {
  return SYSTEM_UID === 0;
}

/** `useradd` never checks an existing uid, so hand-pick a free one. */
function nextFreeUid(): number {
  const used = new Set<number>();
  const out = spawnSync("id", ["-u"], { encoding: "utf8" });
  const self = Number(out.stdout.trim());
  if (Number.isFinite(self) && self > 0) used.add(self);
  const passwd = readFileSync("/etc/passwd", "utf8");
  for (const line of passwd.split("\n")) {
    const m = line.match(/^([^:]+):[^:]*:(\d+)/);
    if (m) used.add(Number(m[2]));
  }
  for (let uid = 10000; uid < 60000; uid++) {
    if (!used.has(uid)) return uid;
  }
  throw new Error("no free uid in 10000-59999");
}

function runCmd(cmd: string, args: string[]): string {
  const out = spawnSync(cmd, args, { encoding: "utf8" });
  if (out.status !== 0) {
    const detail = (out.stderr || out.stdout || "").trim();
    throw new Error(`${cmd} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return out.stdout;
}

/** Read a user's uid/gid/home from /etc/passwd. */
function lookupUser(osUser: string): { uid: number; gid: number; home: string } | null {
  const passwd = readFileSync("/etc/passwd", "utf8");
  for (const line of passwd.split("\n")) {
    const m = line.match(/^([^:]+):[^:]*:(\d+):(\d+):[^:]*:([^:]+)/);
    if (m && m[1] === osUser) return { uid: Number(m[2]), gid: Number(m[3]), home: m[4] };
  }
  return null;
}

/** Sanitize a kohlab user id into a safe POSIX username (koh-<id>). */
export function osUserName(id: string): string {
  const slug = id.toLowerCase().replace(/[^a-z0-9_]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const core = slug.slice(0, 24) || "u";
  return `${OS_USER_PREFIX}-${core}`;
}

/**
 * Provision an OS user for a kohlab member: useradd + /home/<user> + a
 * default agent config skeleton + 0700 home. Idempotent. Runs only when the
 * server is root; otherwise records the mapping without OS accounts.
 */
export async function provisionOsUser(u: User): Promise<{ osUser: string; uid?: number; gid?: number; home?: string }> {
  const osUser = osUserName(u.id);
  if (!isRoot()) {
    console.warn(`not root; skipping OS-user provisioning for '${u.id}' (sessions run as the server user)`);
    return { osUser };
  }
  const existing = lookupUser(osUser);
  if (existing) return { osUser, ...existing };
  const uid = nextFreeUid();
  runCmd("useradd", ["-M", "-u", String(uid), "-U", "-s", "/bin/bash", "-d", `/home/${osUser}`, osUser]);
  const home = `/home/${osUser}`;
  await mkdir(home, { recursive: true, mode: 0o700 });
  runCmd("chown", [osUser, home]);
  await mkdir(join(home, ".config"), { recursive: true, mode: 0o700 });
  runCmd("chown", [osUser, join(home, ".config")]);
  return { osUser, uid, gid: uid, home };
}

/** Remove a member's OS account and its home tree. Best-effort, safe for dev. */
export async function deprovisionOsUser(osUser: string): Promise<{ removed: boolean; detail?: string }> {
  if (!isRoot()) {
    console.warn(`not root; skipping OS-user removal for '${osUser}'`);
    return { removed: false, detail: "not root — the OS account is still there" };
  }
  if (!lookupUser(osUser)) return { removed: true };
  // `userdel` refuses while any process still owns the account, which is exactly
  // the situation when the member's agent is running — the moment you most mean
  // it. Revocation stops them first, then removes the account: a revoked member
  // whose agent keeps running, keeps its home and keeps its uid is not revoked.
  try {
    runCmd("pkill", ["-u", osUser]);
    // let the kills land before userdel looks for survivors
    const paused = Promise.withResolvers<void>();
    setTimeout(paused.resolve, 300);
    await paused.promise;
  } catch {
    /* nothing of theirs was running, which is fine */
  }
  try {
    runCmd("userdel", ["-r", osUser]);
    return { removed: true };
  } catch (e) {
    const detail = (e as Error).message;
    console.warn(`userdel ${osUser} failed: ${detail}`);
    return { removed: false, detail };
  }
}

/**
 * Open a workspace's agent PTY session on the daemon — the single spawn
 * choke point for both the CLI/API start path and the browser-attach path,
 * so the caps AND the owning user's identity handed to the daemon can never
 * drift between them. Throws with the daemon's error on failure.
 */
export async function spawnAgentSession(ws: Workspace, terminalId = "main", cols = 120, rows = 36): Promise<string> {
  const s = await loadState();
  const cmd = (s.agents[ws.agent] || "sh").split(/\s+/);
  const owner = ws.ownerId ? readUsers().find((u) => u.id === ws.ownerId) : undefined;
  const sessId = sessionId(ws.id, terminalId);
  const res = await ptyRequest<{ ok?: boolean; error?: string }>(
    "open",
    {
      id: sessId,
      cwd: worktreePath(ws),
      cmd,
      cols,
      rows,
      meta: { workspace: ws.id, terminal: terminalId },
      limits: ws.limits ?? {},
      // the daemon spawns the agent as this user when present (v1.8)
      uid: owner?.uid,
      gid: owner?.gid,
      home: owner?.home,
    },
    "open-result",
  );
  if (res.error) throw new Error(res.error);
  if (ws.payload && terminalId === "main") {
    await ptySend({ type: "input", id: sessId, data: Buffer.from(ws.payload + "\r").toString("base64") });
  }
  return sessId;
}

/** True when the server is configured to require an access key. */
export function authRequired(): boolean {
  if (ACCESS_KEY) return true;
  // Read FIRST, so corruption latches before the decision is made. Checking the
  // flag before reading left a one-request window: the flag was set *during*
  // usersExist(), too late for the check that had already passed, so the first
  // request after a users.json was damaged was still admitted as anonymous —
  // and a mutating one would have been allowed through.
  const users = readUsers();
  if (usersFileCorrupt) return true;
  return users.length > 0;
}

/** True when at least one named user exists (users.json non-empty). */
export function usersExist(): boolean {
  const us = readUsers();
  return us.length > 0;
}

/** SHA-256 hex of a key — stored, never plaintext. */
async function hashKey(key: string): Promise<string> {
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time compare of a candidate key against a stored hash. */
async function keyMatches(candidate: string, storedHex: string): Promise<boolean> {
  const got = await hashKey(candidate);
  if (got.length !== storedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ storedHex.charCodeAt(i);
  return diff === 0;
}

/**
 * Report a file we could not parse — loudly, and WITHOUT moving it.
 *
 * An earlier version renamed the file aside as `<file>.corrupt-<ts>`. That
 * defeated its own purpose. The "we are damaged" signal is module state, so a
 * restart cleared it — and the renamed-away file then read as simply *absent*:
 * for `users.json` that meant "no members", and therefore "no authentication
 * required", so a damaged auth file re-opened anonymous access on every restart;
 * for `state.json` it meant starting from an empty fleet and presenting that as
 * the truth. Leaving the file in place makes the failure re-arm on every start,
 * which is what failing closed actually requires.
 */
function reportCorrupt(file: string, error: unknown, remedy: string): void {
  console.error(
    `\n[kohlab] ${file} is unreadable: ${error instanceof Error ? error.message : String(error)}` +
      `\n[kohlab] ${remedy}\n`,
  );
}

/**
 * Set when users.json could not be parsed. Latched for the process lifetime:
 * once we cannot trust the user list, we must not conclude there are no users.
 */
let usersFileCorrupt = false;

function readUsers(): User[] {
  if (!existsSync(USERS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(USERS_FILE, "utf8")) as { users?: User[] };
    return parsed.users ?? [];
  } catch (error) {
    // FAIL CLOSED. Returning [] here used to make usersExist() false, which made
    // authRequired() false, which made `denied` false — so a corrupt users.json
    // in a users-based deployment (no KOHLAB_KEY) silently stopped requiring
    // authentication and let anonymous requests mutate. A damaged auth file must
    // tighten access, never loosen it.
    usersFileCorrupt = true;
    reportCorrupt(
      USERS_FILE,
      error,
      "left in place — authentication stays required until it is restored or removed",
    );
    return [];
  }
}

async function writeUsers(users: User[]): Promise<void> {
  await mkdir(WORKS_DIR, { recursive: true });
  // Same atomicity requirement as state.json: this file holds every member's
  // hashed key, and a torn write locks all of them out.
  await writeJsonAtomic(USERS_FILE, { users });
}

/** List users (keys hashed). */
export function listUsers(): User[] {
  return readUsers();
}

/** Create a user, provision its OS account, and return the key once. */
export async function addUser(opts: { id: string; name: string; role: Role }): Promise<{ user: User; key: string }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(24));
  const key = [...keyBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const users = readUsers();
  if (users.some((u) => u.id === opts.id)) throw new Error(`user '${opts.id}' already exists`);
  const user: User = { id: opts.id, name: opts.name, role: opts.role, key: await hashKey(key) };
  users.push(user);
  await writeUsers(users);
  // v1.8: every member maps to an OS account. On failure, roll the user back
  // out — a half-provisioned account is worse than none.
  let osDetail = "no OS account (not root)";
  try {
    const os = await provisionOsUser(user);
    Object.assign(user, os);
    await writeUsers(users);
    if (os.uid) osDetail = "os-user provisioned";
  } catch (e) {
    await writeUsers(users.filter((u) => u.id !== opts.id));
    throw new Error(`could not provision OS account for '${opts.id}': ${(e as Error).message}`);
  }
  await audit("system", "user.add", opts.id, osDetail);
  return { user, key };
}

/** Remove a user (revoke): drop the record and its OS account + home. */
export async function removeUser(id: string): Promise<{ removed: boolean; warning?: string }> {
  const target = readUsers().find((u) => u.id === id);
  const users = readUsers().filter((u) => u.id !== id);
  await writeUsers(users);
  let outcome = { removed: true as boolean, warning: undefined as string | undefined };
  if (target?.osUser) {
    const os = await deprovisionOsUser(target.osUser);
    if (!os.removed) {
      // The account is still on the box: the key is dead but their files and
      // processes are not. Silence here would let an operator believe a member
      // was fully removed when they were not.
      outcome = { removed: false, warning: `the kohlab user is gone, but the OS account ${target.osUser} remains (${os.detail ?? "unknown reason"})` };
    }
  }
  await audit("system", "user.rm", id, outcome.warning ? `incomplete: ${outcome.warning}` : "os-user removed");
  return outcome;
}

/**
 * Resolve the actor of a request. Returns:
 *  - { kind: "user", id, role } for a valid named user
 *  - { kind: "legacy" } for a valid KOHLAB_KEY
 *  - { kind: "share", id } for a valid share token (workspace-scoped read)
 *  - { kind: "anonymous" } when no auth is configured at all
 *  - null when auth is configured but the request fails it
 */
export async function authenticate(req: { headers: Headers; url: string }): Promise<
  { kind: "user"; id: string; role: Role } | { kind: "legacy"; role: Role } | { kind: "share"; id: string } | { kind: "anonymous" } | null
> {
  // 1. named users first
  const key = extractKey(req);
  if (key) {
    for (const u of readUsers()) {
      if (await keyMatches(key, u.key)) return { kind: "user", id: u.id, role: u.role };
    }
  }
  // 2. legacy KOHLAB_KEY
  if (ACCESS_KEY && key) {
    const valid = await keyMatches(key, await hashKey(ACCESS_KEY));
    if (valid) return { kind: "legacy", role: "owner" };
  }
  // 3. share token is resolved separately by callers (needs the workspace id)
  // 4. no auth configured → open
  if (!authRequired()) return { kind: "anonymous" };
  return null;
}

function extractKey(req: { headers: Headers; url: string }): string | null {
  const q = new URL(req.url).searchParams.get("key");
  if (q) return q;
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

/** Append an audit event (append-only, JSON lines). Best-effort. */
export async function audit(user: string, action: string, id?: string, detail?: string) {
  try {
    await mkdir(WORKS_DIR, { recursive: true });
    const line = JSON.stringify({ t: Date.now(), user, action, id, detail });
    await appendFile(AUDIT_FILE, line + "\n");
  } catch {
    /* audit is best-effort; never break the mutation over it */
  }
}

/** Read the audit log (newest first, capped). */
export async function readAudit(limit = 200): Promise<{ t: number; user: string; action: string; id?: string; detail?: string }[]> {
  if (!existsSync(AUDIT_FILE)) return [];
  const lines = readFileSync(AUDIT_FILE, "utf8").trim().split("\n").filter(Boolean);
  return lines
    .slice(-limit)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((x): x is { t: number; user: string; action: string; id?: string; detail?: string } => !!x)
    .reverse();
}

// --- releases (OTA updates) -------------------------------------------------

/** The checkout this code runs from — the thing an update updates. */
const REPO_ROOT = import.meta.dir;

export type ReleaseCheck = {
  current: string;
  latest: string;
  available: boolean;
  commits: string[];
  notes: string;
  upstream: string | null;
  head: string;
  checkedAt: number;
  error: string | null;
};

export type UpdateRun = {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  exit: number | null;
  /**
   * A run that stopped without writing its finish marker: killed mid-flight, or
   * it never got as far as starting. Without this the panel had nothing to
   * report — a log existed, but no exit code, so it showed nothing at all.
   */
  unfinished: boolean;
  log: string;
};

const RELEASE_TTL = Number(process.env.RELEASE_CHECK_TTL ?? 300_000);
// Keyed by repo path, which is only known at runtime (the server checks its own
// checkout; the check suite points the same function at a fixture).
const releaseCache = new Map<string, { at: number; value: ReleaseCheck }>();

/** Both markers are written by scripts/update.sh when the OTA endpoint runs it. */
const UPDATE_LOG = join(WORKS_DIR, "update.log");

/** The version a `## [1.2.3] - 2026-01-01` heading names, or null. */
function headingVersion(line: string): string | null {
  const m = /^##\s+\[?([0-9][^\s\]]*)\]?/.exec(line);
  return m ? m[1] : null;
}

/**
 * What changed since `version`: the changelog from the first `##` heading down
 * to, but not including, that version's own heading. The file is newest-first, so
 * this needs no version comparison — "newer than mine" is exactly what sits
 * above my heading.
 *
 * It starts at the first `##` heading rather than at the top of the file, so the
 * boilerplate above it — `# Changelog`, the versioning philosophy paragraph — is
 * not repeated into every release's notes. (An `## [Unreleased]` section sitting
 * above the released ones IS included: those changes are part of what is coming.)
 */
export function releaseNotes(changelog: string, version: string): string {
  const lines = changelog.split("\n");
  const cut = lines.findIndex((l) => headingVersion(l) === version);
  if (cut <= 0) return "";
  const from = lines.findIndex((l) => /^##\s/.test(l));
  if (from < 0 || from >= cut) return "";
  return lines.slice(from, cut).join("\n").trim();
}

/**
 * What the upstream repo publishes, and what is new since this checkout.
 *
 * `git fetch` is the only network call, and it is what makes "someone pushed a
 * release" visible here — so it is cached (RELEASE_CHECK_TTL, default 5 min)
 * rather than run on every dashboard poll. `force` skips the cache.
 */
export async function checkRelease(repo: string = REPO_ROOT, opts: { force?: boolean } = {}): Promise<ReleaseCheck> {
  const cached = releaseCache.get(repo);
  if (!opts.force && cached && Date.now() - cached.at < RELEASE_TTL) return cached.value;

  const value: ReleaseCheck = {
    current: "",
    latest: "",
    available: false,
    commits: [],
    notes: "",
    upstream: null,
    head: "",
    checkedAt: Date.now(),
    error: null,
  };
  try {
    value.head = (await runOut(repo, "git", ["rev-parse", "--short", "HEAD"])).stdout.trim();
    value.current = JSON.parse(await readFile(join(repo, "package.json"), "utf8")).version;
    value.latest = value.current;
    const up = (
      await runOut(repo, "git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], [1, 128])
    ).stdout.trim();
    value.upstream = up || null;
    if (up) {
      await runOut(repo, "git", ["fetch", "--quiet", "origin", up.replace(/^[^/]+\//, "")]);
      value.latest = JSON.parse((await runOut(repo, "git", ["show", `${up}:package.json`])).stdout).version;
      // Commits behind upstream decide this, never the version strings: a
      // different version could be older, and "update" must not rewind.
      value.available = Number((await runOut(repo, "git", ["rev-list", "--count", `HEAD..${up}`])).stdout.trim()) > 0;
      if (value.available) {
        value.commits = (await runOut(repo, "git", ["log", "--oneline", `HEAD..${up}`])).stdout.trim().split("\n").filter(Boolean);
        const changelog = (await runOut(repo, "git", ["show", `${up}:CHANGELOG.md`], [1, 128])).stdout;
        value.notes = releaseNotes(changelog, value.current);
      }
    }
  } catch (e) {
    value.error = String((e as Error).message ?? e).split("\n")[0];
  }
  // Never cache a failure — a fetch that failed because the network was down
  // must not look like "up to date" for the next five minutes.
  if (!value.error) releaseCache.set(repo, { at: Date.now(), value });
  return value;
}

/**
 * Is an update running, and how did the last one end?
 *
 * Read from the marker lines scripts/update.sh writes into the log, because the
 * reload kills the process that started it: nothing in memory survives to
 * report the outcome.
 */
export async function updateRunState(): Promise<UpdateRun> {
  let text: string;
  try {
    text = await readFile(UPDATE_LOG, "utf8");
  } catch {
    return { running: false, startedAt: null, finishedAt: null, exit: null, unfinished: false, log: "" };
  }
  const started = /^# kohlab update started (\d+) pid (\d+)/m.exec(text);
  const finished = /^# kohlab update finished (\d+) exit (-?\d+)/m.exec(text);
  const log = text.length > 20_000 ? text.slice(-20_000) : text;
  if (finished) {
    return {
      running: false,
      startedAt: started ? Number(started[1]) : null,
      finishedAt: Number(finished[1]),
      exit: Number(finished[2]),
      unfinished: false,
      log,
    };
  }
  let live = false;
  if (started) {
    try {
      process.kill(Number(started[2]), 0);
      live = true;
    } catch {
      live = false;
    }
  }
  if (live) {
    return { running: true, startedAt: Number(started![1]), finishedAt: null, exit: null, unfinished: false, log };
  }
  // No finish marker and no live process: it was killed, or it never started.
  // The log is all there is to go on, so say so rather than saying nothing.
  return {
    running: false,
    startedAt: started ? Number(started[1]) : null,
    finishedAt: null,
    exit: null,
    unfinished: text.trim().length > 0,
    log,
  };
}

/** Completion callbacks (webhook + browser push). Set by the server. */
type NotifyFn = (ws: Workspace) => void;
let notifyDone: NotifyFn[] = [];
export function onWorkspaceDone(fn: NotifyFn) {
  notifyDone.push(fn);
}


// --- PTY daemon client ----------------------------------------------------
// Shared client for the node-pty daemon. Server uses it for terminal
// streaming; lib uses it for lifecycle (isRunning, stop, delete, watcher).

const PTY_SOCKET = process.env.PTY_SOCKET || "/tmp/kohlab-pty.sock";
const PTY_DAEMON = process.env.PTY_DAEMON || join(cwd(), "pty-daemon.cjs");

let ptySock: import("net").Socket | null = null;
let ptyBuf = "";
let ptyDaemonProc: import("child_process").ChildProcess | null = null;
let ptyConnecting: Promise<import("net").Socket> | null = null;
/** daemon message handlers (server registers terminal fan-out here) */
type DaemonHandler = (msg: Record<string, unknown>) => void;
const daemonHandlers: DaemonHandler[] = [];

export function onDaemonMessage(fn: DaemonHandler) {
  daemonHandlers.push(fn);
}

/**
 * Start a daemon — called ONLY after a connection attempt has failed, so a
 * live daemon is never orphaned.
 *
 * Spawning unconditionally (and unlinking the socket first) used to sever the
 * running daemon on every server start: it stayed alive, detached, still
 * holding every agent PTY and its scrollback, but nothing could reach it ever
 * again. A restart silently lost every live session — the opposite of the
 * product's promise — while state.json still reported those workspaces as
 * running.
 */
function ensurePtyDaemon() {
  if (ptyDaemonProc) return; // at most one spawn per server process
  const fs = require("fs");
  // Nothing is listening on this path (we only get here after ECONNREFUSED /
  // ENOENT), so any file here is a stale socket from a dead daemon.
  try { fs.unlinkSync(PTY_SOCKET); } catch {}
  const child = spawn("node", [PTY_DAEMON], { stdio: "ignore", detached: true });
  child.unref();
  ptyDaemonProc = child;
  // watchdog: if the daemon dies, drop the socket + allow a respawn so the
  // next pty op starts a fresh daemon instead of failing forever.
  child.on("exit", () => {
    if (ptyDaemonProc === child) ptyDaemonProc = null;
    ptySock = null;
    ptyConnecting = null;
  });
}

function ptyConnect(): Promise<import("net").Socket> {
  if (ptySock) return Promise.resolve(ptySock);
  if (ptyConnecting) return ptyConnecting;
  ptyConnecting = new Promise<import("net").Socket>((resolve, reject) => {
    const tryConnect = (attempt: number) => {
      const sock = (require("net") as typeof import("net")).createConnection(PTY_SOCKET);
      sock.once("connect", () => {
        ptySock = sock;
        ptyBuf = "";
        sock.on("data", (chunk: Buffer) => {
          ptyBuf += chunk.toString("utf8");
          let idx;
          while ((idx = ptyBuf.indexOf("\n")) >= 0) {
            const line = ptyBuf.slice(0, idx);
            ptyBuf = ptyBuf.slice(idx + 1);
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              daemonHandlers.forEach((h) => h(msg));
            } catch {}
          }
        });
        sock.on("close", () => { ptySock = null; ptyConnecting = null; });
        sock.on("error", () => { ptySock = null; ptyConnecting = null; });
        resolve(sock);
      });
      sock.once("error", (e: Error) => {
        // Connect FIRST: if a daemon is already running it is still holding
        // every live session, so we adopt it rather than replacing it. Only
        // when nothing answers do we start one, then keep retrying.
        ensurePtyDaemon();
        if (attempt < 10) setTimeout(() => tryConnect(attempt + 1), 300);
        else { ptyConnecting = null; reject(e); }
      });
    };
    tryConnect(0);
  });
  return ptyConnecting;
}

export async function ptySend(msg: unknown) {
  const sock = await ptyConnect();
  sock.write(JSON.stringify(msg) + "\n");
}

/** Send a message and wait for the matching reply. */
export async function ptyRequest<T extends Record<string, unknown>>(
  type: string,
  payload: Record<string, unknown>,
  replyType: string,
  timeoutMs = 5000,
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const fail = (err: Error) => {
    clearTimeout(timer);
    removeDaemonHandler(handler);
    reject(err);
  };
  const timer = setTimeout(() => fail(new Error(`daemon ${replyType} timeout`)), timeoutMs);
  const handler: DaemonHandler = (msg) => {
    if (msg.type === replyType) {
      clearTimeout(timer);
      removeDaemonHandler(handler);
      resolve(msg as T);
    }
  };
  daemonHandlers.push(handler);
  try {
    await ptySend({ type, ...payload });
  } catch (e) {
    fail(e as Error);
    return promise;
  }
  return promise;
}

function removeDaemonHandler(fn: DaemonHandler) {
  const i = daemonHandlers.indexOf(fn);
  if (i >= 0) daemonHandlers.splice(i, 1);
}

/**
 * Drop the shared daemon connection.
 *
 * The long-lived server keeps it open on purpose. A one-shot CLI must close it:
 * an open socket holds the event loop, so every command that touched the daemon
 * — `kohlab ls`, `start`, `diff`, `commit` — printed its answer and then hung
 * forever instead of exiting. Closing is also what lets stdout flush, which a
 * `process.exit()` would truncate when the output is a pipe.
 *
 * The daemon treats this as a subscriber detaching and keeps every session
 * alive (pty-daemon.cjs, `sock.on("close")`).
 */
export function ptyDisconnect() {
  const sock = ptySock;
  ptySock = null;
  ptyConnecting = null;
  try {
    sock?.end();
  } catch {}
}

/** List live PTY sessions, or null when the daemon is unreachable. */
export async function ptyList(): Promise<{ id: string; exited: boolean; meta?: Record<string, unknown> }[] | null> {
  try {
    const reply = await ptyRequest<{ sessions: { id: string; exited: boolean; meta?: Record<string, unknown> }[] }>(
      "list", {}, "list-reply",
    );
    return reply.sessions || [];
  } catch {
    return null;
  }
}

/** Fetch a session's buffered output as UTF-8 text, or null if unreachable. */
export async function ptyLog(id: string): Promise<string | null> {
  try {
    const reply = await ptyRequest<{ data?: string }>("log", { id }, "log-reply");
    if (!reply.data) return "";
    return Buffer.from(reply.data, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** Session id for a workspace's named terminal. */
export function sessionId(workspaceId: string, terminalId = "main") {
  return `works-${workspaceId}-${terminalId}`;
}

/** True if the workspace's main PTY session is alive. */
export async function isRunning(ws: Workspace): Promise<boolean> {
  const sessions = (await ptyList()) ?? [];
  if (!sessions) return false;
  const sess = sessions.find((s) => s.id === sessionId(ws.id));
  return !!sess && !sess.exited;
}

export async function markStarted(id: string): Promise<Workspace> {
  return mutateState(async (s) => {
    const ws = s.workspaces.find((w) => w.id === id);
    if (!ws) throw new Error(`no workspace '${id}'`);
    ws.started = ws.started ?? Date.now();
    ws.stopped = null;
    return ws;
  });
}


interface State {
  workspaces: Workspace[];
  agents: Record<string, string>;
}

const DEFAULT_AGENTS: Record<string, string> = {
  omp: "omp",
  claude: "claude",
  codex: "codex",
  sh: "sh",
};

async function loadState(): Promise<State> {
  await mkdir(WORKS_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) {
    const s: State = { workspaces: [], agents: { ...DEFAULT_AGENTS } };
    await saveState(s);
    return s;
  }
  const raw = await readFile(STATE_FILE, "utf8");
  let s: State;
  try {
    s = JSON.parse(raw) as State;
  } catch (error) {
    // Loud, never silent — and the file stays where it is, so the failure
    // repeats on every start instead of quietly becoming an empty fleet.
    reportCorrupt(
      STATE_FILE,
      error,
      "left in place — restore it from a backup, or delete it to start with no workspaces",
    );
    throw new Error(`${STATE_FILE} is corrupt — see the message above, then restart`);
  }
  if (!s.agents) s.agents = { ...DEFAULT_AGENTS };
  return s;
}

/**
 * Write a JSON file atomically and durably.
 *
 * `writeFile` truncates before writing, so a process death mid-write (OOM,
 * `kill -9`, power loss) leaves a half-written file. For `state.json` that loses
 * every workspace at once; for `users.json` it loses every member account.
 *
 * A sibling temp file plus `rename` makes the swap all-or-nothing: a reader sees
 * either the old file or the new one, never a torn one, and the rename is atomic
 * because it stays within one filesystem. The `sync` is for durability rather
 * than atomicity — without it a power loss can commit the rename while the
 * contents are still unwritten.
 */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

async function saveState(s: State) {
  await writeJsonAtomic(STATE_FILE, s);
}

// --- state mutex -----------------------------------------------------------
// loadState/saveState is read-modify-write on a single JSON file; concurrent
// handlers can lost-update each other. Serialize every mutation through this
// promise chain (a simple mutex) so state.json stays consistent under load.

let stateLock: Promise<unknown> = Promise.resolve();

/** Run a state mutation with exclusive access to the state file. */
async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = stateLock.then(fn, fn);
  // keep the chain alive regardless of fn outcome
  stateLock = run.catch(() => {});
  return run;
}

/** Load state inside the lock, mutate, save. Convenience for one-shot writes. */
async function mutateState<T>(fn: (s: State) => T | Promise<T>): Promise<T> {
  return withStateLock(async () => {
    const s = await loadState();
    const res = await fn(s);
    await saveState(s);
    return res;
  });
}

// --- completion watcher --------------------------------------------------

/** Workspaces that were running on the previous watcher tick. */
let previouslyRunning = new Set<string>();

/** Workspaces stopped manually (stop/delete) — their daemon `exit` must not
 *  be reported as an agent completion. */
const intentionallyStopped = new Set<string>();

export function markIntentionallyStopped(id: string) {
  intentionallyStopped.add(id);
}

/**
 * Poll every workspace: when a started workspace stops running, mark it done
 * and fire notifications. Uses a previous-tick snapshot AND the started flag
 * so even short-lived sessions that finish between ticks are caught.
 */
export function startWatcher() {
  // Event-driven completion: a daemon `exit` for a workspace's main session
  // means the agent finished. Mark done + notify immediately.
  onDaemonMessage((msg) => {
    if (msg.type !== "exit" || typeof msg.id !== "string") return;
    if (!msg.id.startsWith("works-")) return;
    // session ids are `works-<id>-<terminal>`; workspace ids contain dashes,
    // so match the exact main-session id (or the legacy id-without-terminal)
    const s = loadStateSync();
    const main = s.workspaces.find((w) => msg.id === sessionId(w.id) || msg.id === `works-${w.id}`);
    if (!main) return;
    const wid = main.id;
    if (intentionallyStopped.has(wid)) return;
    void (async () => {
      const w = await mutateState(async (st) => {
        const found = st.workspaces.find((x) => x.id === wid);
        if (!found) return null;
        if (found.started && !found.stopped) {
          found.stopped = Date.now();
          return found;
        }
        return null;
      });
      if (w) notifyDone.forEach((fn) => fn(w));
    })();
  });

  // Polling fallback: catches sessions that exited before the server was up.
  setInterval(async () => {
    try {
      const sessions = await ptyList();
      if (sessions === null) return; // daemon unreachable — don't read as "all done"
      const s = await loadState();
      const running = new Set<string>();
      const finished = new Set<string>();
      for (const w of s.workspaces) {
        const sess = sessions.find((x) => x.id === sessionId(w.id));
        const alive = !!sess && !sess.exited;
        if (alive) {
          running.add(w.id);
          continue;
        }
        if (intentionallyStopped.has(w.id)) continue;
        if (previouslyRunning.has(w.id) || (w.started && !w.stopped)) {
          finished.add(w.id);
        }
      }
      previouslyRunning = running;
      if (finished.size) {
        // apply the completion marks under the state lock so concurrent API
        // writes can't be lost-updated
        await mutateState((st) => {
          for (const wid of finished) {
            const w = st.workspaces.find((x) => x.id === wid);
            if (w && w.started && !w.stopped) w.stopped = Date.now();
          }
        });
        const st = await loadState();
        for (const wid of finished) {
          const w = st.workspaces.find((x) => x.id === wid);
          if (w) notifyDone.forEach((fn) => fn(w));
        }
      }
    } catch (e) {
      console.error("[watcher]", (e as Error).message);
    }
  }, WATCH_INTERVAL);
}

/** Synchronous state read for the hot daemon-message path. */
function loadStateSync(): State {
  if (!existsSync(STATE_FILE)) return { workspaces: [], agents: { ...DEFAULT_AGENTS } };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return { workspaces: [], agents: { ...DEFAULT_AGENTS } };
  }
}

/** Fire the configured webhook for a completed workspace (best-effort). */
export async function notifyWebhook(ws: Workspace) {
  if (!NOTIFY_WEBHOOK) return;
  try {
    await fetch(NOTIFY_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "workspace.done",
        id: ws.id,
        task: ws.task,
        agent: ws.agent,
        done: new Date(ws.stopped ?? Date.now()).toISOString(),
      }),
    });
  } catch (e) {
    console.error("[webhook]", (e as Error).message);
  }
}


// --- names & paths -------------------------------------------------------

export function slugify(s: string): string {
  const t = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return t.slice(0, 40) || "ws";
}

export function wsDir(ws: Workspace) {
  // owned (isolated) workspaces live under the owner's home; legacy records
  // without `dir` stay under $WORKS_DIR exactly as before.
  return ws.dir ?? join(WORKS_DIR, ws.id);
}

export function worktreePath(ws: Workspace) {
  return join(wsDir(ws), "tree");
}

/** Where pasted screenshots for a workspace live. Inside the private root for
 *  owned workspaces so the owning agent can read them; legacy shared store
 *  otherwise. */
export function imagesDir(ws: Workspace) {
  return ws.dir ? join(ws.dir, "images") : join(WORKS_DIR, "images", ws.id);
}

/** Last path segment of a git URL ("git@h:a/b.git" → "b", "https://h/a.git" → "a"). */
function repoNameFromUrl(url: string): string {
  const clean = url.replace(/\.git$/, "").replace(/\/+$/, "");
  return clean.split(/[\/:]/).filter(Boolean).pop() ?? "repo";
}

// --- repo helpers --------------------------------------------------------

/**
 * Resolve the repo root for a path. If the path is inside a worktree, walk up
 * until we find the common dir file. If inside a regular checkout, find .git.
 * Returns null when the path is not inside any git repo.
 */
export async function findRepoRoot(dir: string): Promise<string | null> {
  let cur = await realpath(dir);
  for (let i = 0; i < 40; i++) {
    const common = join(cur, ".git", "commondir");
    if (existsSync(common)) {
      const rel = (await readFile(common, "utf8")).trim();
      const root = join(cur, ".git", rel);
      return (await realpath(root)).replace(/\/\.git$/, "");
    }
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = join(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

// --- workspace lifecycle -------------------------------------------------

export async function listWorkspaces(): Promise<
  (Workspace & { running: boolean; path: string })[]
> {
  const s = await loadState();
  return Promise.all(
    s.workspaces.map(async (w) => ({
      ...w,
      running: await isRunning(w),
      path: worktreePath(w),
    })),
  );
}

export async function getWorkspace(id: string) {
  const s = await loadState();
  const ws = s.workspaces.find((w) => w.id === id);
  if (!ws) throw new Error(`no workspace '${id}'`);
  return ws;
}
export async function createWorkspace(opts: {
  repo: string;
  task: string;
  agent: string;
  branch?: string;
  payload?: string;
  limits?: WorkspaceLimits;
  ownerId?: string;
  url?: string;
}): Promise<Workspace & { running: boolean; path: string }> {
  const ownerId = opts.ownerId ?? "";
  const ownerUser = ownerId ? readUsers().find((u) => u.id === ownerId) : undefined;
  if (ownerId && !ownerUser) throw new Error(`no such user '${ownerId}'`);
  // owned workspaces are isolated under the owner's home tree: the member's
  // agent can only ever reach repos it clones for itself (members cannot
  // reference host paths, which live outside their reach)
  const isolated = !!ownerUser?.uid && !!ownerUser?.gid && !!ownerUser.home && !!ownerUser.osUser;
  if (opts.url && !isolated) throw new Error("URL workspaces require a provisioned OS owner");
  if (isolated && !opts.url) throw new Error("isolated members must create from a git URL, not a host path");

  const repo = opts.url ? "" : await findRepoRoot(opts.repo);
  if (!opts.url && !repo) throw new Error(`not a git repo: ${opts.repo}`);

  const rootName = opts.url ? repoNameFromUrl(opts.url) : basename(repo!);
  const id = `${slugify(rootName)}-${slugify(opts.task)}`;
  const dir = isolated ? join(ownerUser!.home!, "works", id) : join(WORKS_DIR, id);
  const tree = join(dir, "tree");
  const admin = join(dir, "admin");
  const ws = await mutateState(async (s) => {
    if (s.workspaces.some((w) => w.id === id)) {
      throw new Error(`workspace '${id}' already exists (delete or reuse it)`);
    }
    const w: Workspace = {
      id,
      repo: repo ?? "",
      task: opts.task,
      agent: opts.agent in s.agents ? opts.agent : "sh",
      created: Date.now(),
      started: null,
      stopped: null,
      ownerId,
      dir,
      payload: opts.payload,
      limits: opts.limits,
    };
    s.workspaces.push(w);
    return w;
  });

  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (isolated) {
    // A URL clone under the user's private root: a bare admin repo (server-
    // owned, the durable object store) plus a working tree the agent owns.
    // Create runs as root; the tree is chowned to the user afterwards so
    // their agent can work and commit in it as themselves.
    await run("", "git", ["clone", "--bare", "--quiet", "--no-tags", opts.url!, admin]);
    // -b HEAD is invalid against a remote (literal HEAD isn't a fetch ref);
    // clone without checkout, then check out the default branch.
    await run("", "git", ["clone", "--quiet", "--no-checkout", "--no-local", admin, tree]);
    const defaultBranch = (await runOut(admin, "git", ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
    await run(tree, "git", ["checkout", "-b", `kohlab/${ws.id}`, defaultBranch]);
    await run(tree, "git", ["config", "user.name", ownerUser!.name]);
    await run(tree, "git", ["config", "user.email", `${ownerUser!.osUser}@kohlab.local`]);
    await run("", "chown", ["-R", ownerUser!.osUser!, dir]);
    await run("", "chmod", ["700", dir]);
  } else {
    // legacy path-repo workspace (repo outside the tree, admin-owned):
    // worktree-add into the store exactly as before.
    await run(repo!, "git", ["worktree", "add", "--quiet", "-b", `kohlab/${ws.id}`, tree]);
    const gitDir = join(tree, ".git");
    if (existsSync(gitDir) && !(await stat(gitDir)).isDirectory()) {
      await run(repo!, "git", ["worktree", "repair", tree]);
    }
  }

  return { ...ws, running: false, path: tree };
}

// --- sharing -------------------------------------------------------------

export async function shareWorkspace(id: string) {
  return mutateState(async (s) => {
    const ws = s.workspaces.find((w) => w.id === id);
    if (!ws) throw new Error(`no workspace '${id}'`);
    if (!ws.share) {
      ws.share = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    }
    return { id: ws.id, share: ws.share };
  });
}

/** Resolve a share token to its workspace (read-only view). */
export async function workspaceByShare(token: string) {
  const s = await loadState();
  const ws = s.workspaces.find((w) => w.share === token);
  if (!ws) throw new Error("invalid share link");
  return ws;
}

export async function startWorkspace(id: string) {
  const s = await loadState();
  const ws = s.workspaces.find((w) => w.id === id);
  if (!ws) throw new Error(`no workspace '${id}'`);

  // spawn the main PTY session now so the agent actually starts, not just on
  // first browser attach. spawnAgentSession applies caps AND the owner's uid.
  await spawnAgentSession(ws);
  return mutateState(async (st) => {
    const w = st.workspaces.find((x) => x.id === id);
    if (!w) throw new Error(`no workspace '${id}'`);
    w.started = Date.now();
    w.stopped = null;
    return { ...w, running: true, path: worktreePath(w) };
  });
}

export async function stopWorkspace(id: string) {
  // close every named PTY session for this workspace (main + extra terminals)
  const sessions = (await ptyList()) ?? [];
  for (const sess of sessions ?? []) {
    if (sess.id.startsWith(`works-${id}-`)) {
      await ptySend({ type: "close", id: sess.id });
    }
  }
  markIntentionallyStopped(id);
  return mutateState(async (s) => {
    const ws = s.workspaces.find((w) => w.id === id);
    if (!ws) throw new Error(`no workspace '${id}'`);
    ws.stopped = Date.now();
    return { ...ws, running: false, path: worktreePath(ws) };
  });
}


export async function deleteWorkspace(id: string) {
  const s = await loadState();
  const ws = s.workspaces.find((w) => w.id === id);
  if (!ws) throw new Error(`no workspace '${id}'`);
  // close every named PTY session for this workspace
  const sessions = (await ptyList()) ?? [];
  for (const sess of sessions) {
    if (sess.id.startsWith(`works-${id}-`)) {
      await ptySend({ type: "close", id: sess.id });
    }
  }
  // isolated workspaces have no worktree linkage (they are plain clones under
  // the owner's home) — nothing to un-register, skip straight to the rm.
  if (!ws.dir) {
    try {
      await run(ws.repo, "git", ["worktree", "remove", "--force", worktreePath(ws)]);
    } catch (e) {
      console.warn(`worktree remove failed (${(e as Error).message}); leaving tree on disk`);
    }
  }
  // isolated workspaces live entirely under ws.dir — remove the private root
  // (admin repo + worktree + images). Legacy: shared store + shared images.
  if (ws.dir) await rm(ws.dir, { recursive: true, force: true });
  else await rm(join(WORKS_DIR, "images", id), { recursive: true, force: true });
  markIntentionallyStopped(id);
  return mutateState(async (st) => {
    st.workspaces = st.workspaces.filter((w) => w.id !== id);
    return { ok: true };
  });
}

export async function restartWorkspace(id: string) {
  await stopWorkspace(id);
  return startWorkspace(id);
}


/** New files above this size are listed but not previewed. */
const MAX_DIFF_PREVIEW_BYTES = 512 * 1024;

export async function getDiff(id: string): Promise<{ name: string; diff: string }[]> {
  const ws = await getWorkspace(id);
  const tree = worktreePath(ws);

  // `git diff` only reports tracked edits. Agents create files constantly, and
  // an untracked file is still staged by commitWorkspace's `git add -A` — so
  // without the untracked pass, review silently omits files that get committed.
  const [{ stdout: modified }, { stdout: untracked }] = await Promise.all([
    runOut(tree, "git", ["diff", "--name-only", "--no-color"]),
    runOut(tree, "git", ["ls-files", "--others", "--exclude-standard"]),
  ]);

  const out: { name: string; diff: string }[] = [];

  for (const f of modified.trim().split("\n").filter(Boolean)) {
    try {
      const { stdout: patch } = await runOut(tree, "git", ["diff", "--no-color", "--", f]);
      out.push({ name: f, diff: patch });
    } catch {
      // skip files that vanished mid-diff (deleted between the two calls)
    }
  }

  for (const f of untracked.trim().split("\n").filter(Boolean)) {
    let size: number;
    try {
      ({ size } = await stat(join(tree, f)));
    } catch {
      continue; // vanished between listing and stat
    }
    if (size > MAX_DIFF_PREVIEW_BYTES) {
      out.push({ name: f, diff: `new file — ${size} bytes, too large to preview` });
      continue;
    }
    // --no-index exits 1 whenever the files differ: that is the success path.
    // Output carries `--- /dev/null` + `+++ b/<file>`, a valid unified diff.
    const { stdout: patch } = await runOut(tree, "git", ["diff", "--no-color", "--no-index", "--", "/dev/null", f], [1]);
    out.push({ name: f, diff: patch });
  }

  return out;
}

export async function commitWorkspace(id: string, message: string) {
  const ws = await getWorkspace(id);
  const tree = worktreePath(ws);
  await run(tree, "git", ["add", "-A"]);
  // A clean tree has nothing to stage and `git commit` exits 1, which surfaced
  // as a raw "git commit -m … exited 1". Nothing staged means the workspace is
  // already in the accepted state, so record it and continue — otherwise a
  // stopped workspace with no changes can never leave the review queue, since
  // accepting it is the only path out.
  const { stdout: staged } = await runOut(tree, "git", ["diff", "--cached", "--name-only"]);
  if (staged.trim()) {
    await run(tree, "git", ["commit", "-m", message || `works: ${ws.task}`]);
  } else {
    console.log(`[kohlab] ${id}: nothing to commit — accepting the workspace as-is`);
  }
  return mutateState(async (st) => {
    const w = st.workspaces.find((x) => x.id === id);
    if (!w) throw new Error(`no workspace '${id}'`);
    w.lastCommitAt = Date.now();
    return { ok: true };
  });
}

// --- process helpers -----------------------------------------------------

function run(cwdArg: string, cmd: string, args: string[]): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const p = spawn(cmd, args, { cwd: cwdArg, stdio: ["ignore", "ignore", "inherit"] });
  p.on("error", reject);
  p.on("close", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
  });
  return promise;
}

function runOut(cwdArg: string, cmd: string, args: string[], allowExit: number[] = []): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
  const p = spawn(cmd, args, { cwd: cwdArg, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  p.on("error", reject);
  p.on("close", (code) => {
    if (code === 0 || (code !== null && allowExit.includes(code))) resolve({ stdout: out, stderr: err });
    else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}\n${err}`));
  });
  return promise;
}

export { WORKS_DIR, STATE_FILE, loadState, saveState };
