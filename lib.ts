// works — PTY-daemon-backed coding-agent workspace runner
// State lives in $WORKS_DIR/state.json. Sessions are node-pty sessions
// owned by pty-daemon.cjs, spoken to over a Unix socket.

import type { Workspace, User, Role, WorkspaceLimits } from "./types";
import { existsSync, readFileSync } from "fs";
import { mkdir, readFile, realpath, rm, stat, writeFile, appendFile } from "fs/promises";
import { basename, join } from "path";
import { spawn, execFile } from "child_process";
import { cwd } from "process";

const WORKS_DIR = process.env.WORKS_DIR ?? join(cwd(), ".works");
const STATE_FILE = join(WORKS_DIR, "state.json");
const USERS_FILE = join(WORKS_DIR, "users.json");
const AUDIT_FILE = join(WORKS_DIR, "audit.log");
/** Webhook URL to hit when an agent finishes (optional). */
const NOTIFY_WEBHOOK = process.env.NOTIFY_WEBHOOK;
/** Interval (ms) for the completion watcher. */
const WATCH_INTERVAL = Number(process.env.WATCH_INTERVAL ?? 2000);
/** If set, the dashboard/API require this key (?key= or Bearer). */
const ACCESS_KEY = process.env.KOHLAB_KEY;

/** True when the server is configured to require an access key. */
export function authRequired(): boolean {
  return !!ACCESS_KEY || usersExist();
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

function readUsers(): User[] {
  if (!existsSync(USERS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(USERS_FILE, "utf8")) as { users?: User[] };
    return parsed.users ?? [];
  } catch {
    return [];
  }
}

async function writeUsers(users: User[]): Promise<void> {
  await mkdir(WORKS_DIR, { recursive: true });
  await writeFile(USERS_FILE, JSON.stringify({ users }, null, 2));
}

/** List users (keys hashed). */
export function listUsers(): User[] {
  return readUsers();
}

/** Create a user and return the plaintext key once (it is not stored). */
export async function addUser(opts: { id: string; name: string; role: Role }): Promise<{ user: User; key: string }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(24));
  const key = [...keyBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const users = readUsers();
  if (users.some((u) => u.id === opts.id)) throw new Error(`user '${opts.id}' already exists`);
  const user: User = { id: opts.id, name: opts.name, role: opts.role, key: await hashKey(key) };
  users.push(user);
  await writeUsers(users);
  await audit("system", "user.add", opts.id);
  return { user, key };
}

/** Remove a user (revoke). */
export async function removeUser(id: string): Promise<void> {
  const users = readUsers().filter((u) => u.id !== id);
  await writeUsers(users);
  await audit("system", "user.rm", id);
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

/** True when no access key is configured, or the request carries the right one. */
export function authorized(req: { headers: Headers; url: string }): boolean {
  if (!ACCESS_KEY) return true;
  const url = new URL(req.url);
  const q = url.searchParams.get("key");
  if (q && q.length === ACCESS_KEY.length) {
    const a = new TextEncoder().encode(q);
    const b = new TextEncoder().encode(ACCESS_KEY);
    return a.length === b.length && crypto.subtle
      ? timingSafe(a, b)
      : a.every((v, i) => v === b[i]);
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    const t = auth.slice(7);
    const a = new TextEncoder().encode(t);
    const b = new TextEncoder().encode(ACCESS_KEY);
    return a.length === b.length && (crypto.subtle ? timingSafe(a, b) : a.every((v, i) => v === b[i]));
  }
  return false;
}

function timingSafe(a: Uint8Array, b: Uint8Array): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
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

function ensurePtyDaemon() {
  if (ptyDaemonProc) return;
  const fs = require("fs");
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
    ensurePtyDaemon();
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
  const sessions = await ptyList();
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
    await writeFile(STATE_FILE, JSON.stringify(s, null, 2));
    return s;
  }
  const raw = await readFile(STATE_FILE, "utf8");
  const s = JSON.parse(raw) as State;
  if (!s.agents) s.agents = { ...DEFAULT_AGENTS };
  return s;
}

async function saveState(s: State) {
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2));
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
  return join(WORKS_DIR, ws.id);
}

export function worktreePath(ws: Workspace) {
  return join(wsDir(ws), "tree");
}

// --- repo helpers --------------------------------------------------------

function hasGitRoot(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

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
    if (hasGitRoot(cur)) return cur;
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
}): Promise<Workspace & { running: boolean; path: string }> {
  const repo = await findRepoRoot(opts.repo);
  if (!repo) throw new Error(`not a git repo: ${opts.repo}`);
  const rootName = basename(repo);

  const id = `${slugify(rootName)}-${slugify(opts.task)}`;
  const ws = await mutateState(async (s) => {
    if (s.workspaces.some((w) => w.id === id)) {
      throw new Error(`workspace '${id}' already exists (delete or reuse it)`);
    }
    const w: Workspace = {
      id,
      repo,
      task: opts.task,
      agent: opts.agent in s.agents ? opts.agent : "sh",
      created: Date.now(),
      started: null,
      stopped: null,
      payload: opts.payload,
      limits: opts.limits,
    };
    s.workspaces.push(w);
    return w;
  });

  const dir = wsDir(ws);
  const tree = worktreePath(ws);
  await mkdir(dir, { recursive: true });

  // Clone the repo as a new worktree on a branch named after the workspace.
  // A plain `git worktree add` would try to check out a branch matching the
  // path's basename ("tree"), colliding with other workspaces — a named
  // branch keeps every workspace isolated.
  const addArgs = ["worktree", "add", "--quiet", "-b", `kohlab/${ws.id}`, tree];
  await run(repo, "git", addArgs);

  // Map the worktree's git dir into our workspace so `works diff` and other
  // git ops run in the right place.
  const gitDir = join(tree, ".git");
  if (existsSync(gitDir) && !(await stat(gitDir)).isDirectory()) {
    await run(repo, "git", ["worktree", "repair", tree]);
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

  // spawn the main PTY session now so the agent actually starts,
  // not just on first browser attach. The daemon guards duplicate/ghost
  // sessions itself — we await the open-result and surface its error.
  const cmd = (s.agents[ws.agent] || "sh").split(/\s+/);
  const sessId = sessionId(id);
  const res = await ptyRequest<{ ok?: boolean; error?: string }>(
    "open",
    { id: sessId, cwd: worktreePath(ws), cmd, cols: 120, rows: 36, meta: { workspace: id, terminal: "main" }, limits: ws.limits ?? {} },
    "open-result",
  );
  if (res.error) throw new Error(res.error);
  if (ws.payload) {
    await ptySend({ type: "input", id: sessId, data: Buffer.from(ws.payload + "\r").toString("base64") });
  }
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
  const sessions = await ptyList();
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
  const sessions = await ptyList();
  for (const sess of sessions) {
    if (sess.id.startsWith(`works-${id}-`)) {
      await ptySend({ type: "close", id: sess.id });
    }
  }
  try {
    await run(ws.repo, "git", ["worktree", "remove", "--force", worktreePath(ws)]);
  } catch (e) {
    console.warn(`worktree remove failed (${(e as Error).message}); leaving tree on disk`);
  }
  await rm(join(WORKS_DIR, "images", id), { recursive: true, force: true });
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


export async function getDiff(id: string): Promise<{ name: string; diff: string }[]> {
  const ws = await getWorkspace(id);
  const tree = worktreePath(ws);
  const { stdout } = await runOut(tree, "git", ["diff", "--stat", "--no-color"]);
  const stat = stdout.trim() || "(clean)";
  const { stdout: patch } = await runOut(tree, "git", ["diff", "--no-color"]);
  return [{ name: stat, diff: patch }];
}

export async function commitWorkspace(id: string, message: string) {
  const ws = await getWorkspace(id);
  const tree = worktreePath(ws);
  await run(tree, "git", ["add", "-A"]);
  await run(tree, "git", ["commit", "-m", message || `works: ${ws.task}`]);
  return { ok: true };
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

function runOut(cwdArg: string, cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
  const p = spawn(cmd, args, { cwd: cwdArg, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  p.on("error", reject);
  p.on("close", (code) => {
    if (code === 0) resolve({ stdout: out, stderr: err });
    else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}\n${err}`));
  });
  return promise;
}

export { WORKS_DIR, STATE_FILE, loadState, saveState };
