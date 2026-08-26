// works — PTY-daemon-backed coding-agent workspace runner
// State lives in $WORKS_DIR/state.json. Sessions are node-pty sessions
// owned by pty-daemon.cjs, spoken to over a Unix socket.

import type { Workspace } from "./types";
import { mkdir, readFile, writeFile, stat, realpath } from "fs/promises";
import { existsSync } from "fs";
import { basename, join } from "path";
import { spawn, execFile } from "child_process";
import { cwd } from "process";

const WORKS_DIR = process.env.WORKS_DIR ?? join(cwd(), ".works");
const STATE_FILE = join(WORKS_DIR, "state.json");
/** Webhook URL to hit when an agent finishes (optional). */
const NOTIFY_WEBHOOK = process.env.NOTIFY_WEBHOOK;
/** Interval (ms) for the completion watcher. */
const WATCH_INTERVAL = Number(process.env.WATCH_INTERVAL ?? 2000);
/** If set, the dashboard/API require this key (?key= or Bearer). */
const ACCESS_KEY = process.env.KOHLAB_KEY;

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
let ptyStarted = false;
let ptyConnecting: Promise<import("net").Socket> | null = null;
/** daemon message handlers (server registers terminal fan-out here) */
type DaemonHandler = (msg: Record<string, unknown>) => void;
const daemonHandlers: DaemonHandler[] = [];

export function onDaemonMessage(fn: DaemonHandler) {
  daemonHandlers.push(fn);
}

function ensurePtyDaemon() {
  if (ptyStarted) return;
  ptyStarted = true;
  const fs = require("fs");
  try { fs.unlinkSync(PTY_SOCKET); } catch {}
  const child = spawn("node", [PTY_DAEMON], { stdio: "ignore", detached: true });
  child.unref();
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
  const timer = setTimeout(() => reject(new Error(`daemon ${replyType} timeout`)), timeoutMs);
  const handler: DaemonHandler = (msg) => {
    if (msg.type === replyType) {
      clearTimeout(timer);
      removeDaemonHandler(handler);
      resolve(msg as T);
    }
  };
  daemonHandlers.push(handler);
  await ptySend({ type, ...payload });
  return promise;
}

function removeDaemonHandler(fn: DaemonHandler) {
  const i = daemonHandlers.indexOf(fn);
  if (i >= 0) daemonHandlers.splice(i, 1);
}

/** List live PTY sessions: [{ id, exited, meta }]. */
export async function ptyList(): Promise<{ id: string; exited: boolean; meta?: Record<string, unknown> }[]> {
  try {
    const reply = await ptyRequest<{ sessions: { id: string; exited: boolean; meta?: Record<string, unknown> }[] }>(
      "list", {}, "list-reply",
    );
    return reply.sessions || [];
  } catch {
    return [];
  }
}

/** Session id for a workspace's named terminal. */
export function sessionId(workspaceId: string, terminalId = "main") {
  return `works-${workspaceId}-${terminalId}`;
}

/** True if the workspace's main PTY session is alive. */
export async function isRunning(ws: Workspace): Promise<boolean> {
  const sessions = await ptyList();
  const sess = sessions.find((s) => s.id === sessionId(ws.id));
  return !!sess && !sess.exited;
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

// --- completion watcher --------------------------------------------------

/** Workspaces that were running on the previous watcher tick. */
let previouslyRunning = new Set<string>();

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
    const workspaceId = msg.id.slice("works-".length);
    const dash = workspaceId.indexOf("-");
    const terminalId = dash >= 0 ? workspaceId.slice(dash + 1) : "main";
    const wid = dash >= 0 ? workspaceId.slice(0, dash) : workspaceId;
    if (terminalId !== "main") return; // only the main agent session marks done
    void (async () => {
      const s = await loadState();
      const w = s.workspaces.find((x) => x.id === wid);
      if (!w) return;
      if (w.started && !w.stopped) {
        w.stopped = Date.now();
        await saveState(s);
        notifyDone.forEach((fn) => fn(w));
      }
    })();
  });

  // Polling fallback: catches sessions that exited before the server was up.
  setInterval(async () => {
    try {
      const s = await loadState();
      const running = new Set<string>();
      for (const w of s.workspaces) {
        const alive = await isRunning(w);
        if (alive) {
          running.add(w.id);
          continue;
        }
        if (previouslyRunning.has(w.id) || (w.started && !w.stopped)) {
          w.stopped = Date.now();
          await saveState(s);
          notifyDone.forEach((fn) => fn(w));
        }
      }
      previouslyRunning = running;
    } catch (e) {
      console.error("[watcher]", (e as Error).message);
    }
  }, WATCH_INTERVAL);
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
}): Promise<Workspace & { running: boolean; path: string }> {
  const s = await loadState();

  const repo = await findRepoRoot(opts.repo);
  if (!repo) throw new Error(`not a git repo: ${opts.repo}`);
  const rootName = basename(repo);

  const id = `${slugify(rootName)}-${slugify(opts.task)}`;
  if (s.workspaces.some((w) => w.id === id)) {
    throw new Error(`workspace '${id}' already exists (delete or reuse it)`);
  }

  const ws: Workspace = {
    id,
    repo,
    task: opts.task,
    agent: opts.agent in s.agents ? opts.agent : "sh",
    created: Date.now(),
    started: null,
    stopped: null,
    payload: opts.payload,
  };

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

  s.workspaces.push(ws);
  await saveState(s);

  return { ...ws, running: false, path: tree };
}

// --- sharing -------------------------------------------------------------

/** Generate a read-only share token for a workspace (idempotent). */
export async function shareWorkspace(id: string) {
  const s = await loadState();
  const ws = s.workspaces.find((w) => w.id === id);
  if (!ws) throw new Error(`no workspace '${id}'`);
  if (!ws.share) {
    ws.share = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await saveState(s);
  }
  return { id: ws.id, share: ws.share };
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
  // not just on first browser attach
  const cmd = (s.agents[ws.agent] || "sh").split(/\s+/);
  const sessId = sessionId(id);
  await ptySend({
    type: "open",
    id: sessId,
    cwd: worktreePath(ws),
    cmd,
    cols: 120,
    rows: 36,
    meta: { workspace: id, terminal: "main" },
  });
  if (ws.payload) {
    await ptySend({ type: "input", id: sessId, data: Buffer.from(ws.payload + "\r").toString("base64") });
  }
  ws.started = Date.now();
  ws.stopped = null;
  await saveState(s);
  return { ...ws, running: true, path: worktreePath(ws) };
}

export async function stopWorkspace(id: string) {
  const s = await loadState();
  const ws = s.workspaces.find((w) => w.id === id);
  if (!ws) throw new Error(`no workspace '${id}'`);
  // close every named PTY session for this workspace (main + extra terminals)
  const sessions = await ptyList();
  for (const sess of sessions) {
    if (sess.id.startsWith(`works-${id}-`)) {
      await ptySend({ type: "close", id: sess.id });
    }
  }
  ws.stopped = Date.now();
  await saveState(s);
  return { ...ws, running: false, path: worktreePath(ws) };
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
  s.workspaces = s.workspaces.filter((w) => w.id !== id);
  await saveState(s);
  return { ok: true };
}

export async function restartWorkspace(id: string) {
  await stopWorkspace(id);
  return startWorkspace(id);
}

// --- diff ----------------------------------------------------------------

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
