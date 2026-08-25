// works — tmux-backed coding-agent workspace runner
// State lives in $WORKS_DIR/state.json. Sessions are plain tmux sessions.

import type { Workspace } from "./types";
import { mkdir, readFile, writeFile, stat, realpath } from "fs/promises";
import { existsSync } from "fs";
import { basename, join } from "path";
import { spawn, execFile } from "child_process";
import { cwd } from "process";

const WORKS_DIR = process.env.WORKS_DIR ?? join(cwd(), ".works");
const STATE_FILE = join(WORKS_DIR, "state.json");

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

// --- tmux ----------------------------------------------------------------

async function tmux(args: string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile("tmux", args, { timeout: 10000 }, (err, stdout, stderr) => {
    if (err) reject(new Error(stderr.trim() || err.message));
    else resolve(stdout.trim());
  });
  return promise;
}

function tid(ws: Workspace) {
  return `works-${ws.id}`;
}

/** True if the workspace's tmux session is alive. */
export async function isRunning(ws: Workspace): Promise<boolean> {
  try {
    await tmux(["has-session", "-t", tid(ws)]);
    return true;
  } catch {
    return false;
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

  // Clone the repo as a new worktree. `git worktree add` on a branch is
  // preferred; a plain add creates a detached HEAD.
  const addArgs = ["worktree", "add", "--quiet", tree];
  if (opts.branch) addArgs.push("-b", opts.branch);
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

export async function startWorkspace(id: string) {
  const ws = await getWorkspace(id);
  const s = await loadState();

  if (await isRunning(ws)) return { ...ws, running: true, path: worktreePath(ws) };

  const cmd = (s.agents[ws.agent] || "sh").split(/\s+/);
  const tree = worktreePath(ws);

  await tmux(["new-session", "-d", "-s", tid(ws), "-c", tree, cmd[0], ...cmd.slice(1)]);
  if (ws.payload) {
    await tmux(["send-keys", "-t", tid(ws), ws.payload.replace(/\n/g, "\r"), "Enter"]);
  }

  ws.started = Date.now();
  ws.stopped = null;
  await saveState(s);
  return { ...ws, running: true, path: tree };
}

export async function stopWorkspace(id: string) {
  const ws = await getWorkspace(id);
  const s = await loadState();
  if (await isRunning(ws)) await tmux(["kill-session", "-t", tid(ws)]);
  ws.stopped = Date.now();
  await saveState(s);
  return { ...ws, running: false, path: worktreePath(ws) };
}

export async function deleteWorkspace(id: string) {
  const ws = await getWorkspace(id);
  const s = await loadState();
  if (await isRunning(ws)) await tmux(["kill-session", "-t", tid(ws)]);
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
