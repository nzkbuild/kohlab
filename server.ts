// works server — HTTP + WebSocket API over lib.ts

import { serve } from "bun";
import type { ServerWebSocket } from "bun";
import { spawn, type ChildProcess } from "child_process";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { cwd } from "process";
import {
  createWorkspace,
  deleteWorkspace,
  getDiff,
  getWorkspace,
  listWorkspaces,
  restartWorkspace,
  startWorkspace,
  stopWorkspace,
  commitWorkspace,
  worktreePath,
  WORKS_DIR,
  startWatcher,
  onWorkspaceDone,
  notifyWebhook,
  workspaceByShare,
  authorized,
  loadState,
} from "./lib";

const PORT = Number(process.env.PORT ?? 7676);

/** Browser push subscribers (dashboard pages). */
const pushClients = new Set<ServerWebSocket>();

// completion → push to every open dashboard + fire webhook
onWorkspaceDone((ws) => {
  const msg = JSON.stringify({ type: "workspace.done", id: ws.id, task: ws.task, agent: ws.agent });
  for (const c of pushClients) {
    if (c.readyState === c.OPEN) c.send(msg);
  }
  void notifyWebhook(ws);
});

// poll for finished agents
startWatcher();



async function handleClone(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { url?: string; task?: string; agent?: string; payload?: string };
    const url = (body.url ?? "").trim();
    const task = (body.task ?? "work on " + url).trim();
    if (!url) return json({ error: "url is required" }, 400);
    // clone into a fresh dir under WORKS_DIR
    const dest = `${WORKS_DIR}/clones/${Date.now()}`;
    const { mkdir } = await import("fs/promises");
    await mkdir(`${WORKS_DIR}/clones`, { recursive: true });
    const { spawn } = await import("child_process");
    await new Promise<void>((resolve, reject) => {
      const p = spawn("git", ["clone", "--quiet", url, dest]);
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git clone failed (${code})`))));
    });
    const ws = await createWorkspace({ repo: dest, task, agent: body.agent ?? "sh", payload: body.payload });
    return json(ws);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

async function handleShare(id: string): Promise<Response> {
  try {
    const res = await shareWorkspace(id);
    return json(res);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

/** Resolve ?share=<token> to a workspace id, or null. */
async function shareId(req: Request): Promise<string | null> {
  const url = new URL(req.url);
  const token = url.searchParams.get("share");
  if (!token) return null;
  try {
    const ws = await workspaceByShare(token);
    return ws.id;
  } catch {
    return null;
  }
}

async function handleCreate(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    repo?: string;
    task?: string;
    agent?: string;
    branch?: string;
    payload?: string;
  };
  const task = (body.task ?? "").trim();
  if (!task) return json({ error: "task is required" }, 400);
  const repo = (body.repo ?? cwd()).trim();
  try {
    const ws = await createWorkspace({ repo, task, agent: body.agent ?? "sh", branch: body.branch, payload: body.payload });
    return json(ws);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

async function handleStart(id: string): Promise<Response> {
  try {
    const ws = await startWorkspace(id);
    return json(ws);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

async function handleStop(id: string): Promise<Response> {
  try {
    const ws = await stopWorkspace(id);
    return json(ws);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

async function handleRestart(id: string): Promise<Response> {
  try {
    const ws = await restartWorkspace(id);
    return json(ws);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

async function handleDelete(id: string): Promise<Response> {
  try {
    const res = await deleteWorkspace(id);
    return json(res);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

async function handleDiff(id: string): Promise<Response> {
  try {
    const files = await getDiff(id);
    return json(files);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

async function handleCommit(id: string, req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { message?: string };
    const res = await commitWorkspace(id, body.message ?? "");
    return json(res);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

async function handleLog(id: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const lines = Number(url.searchParams.get("lines") ?? 500);
  try {
    const ws = await getWorkspace(id);
    const f = join(WORKS_DIR, ws.id, "session.log");
    let out = "";
    try {
      const buf = await readFile(f, "utf8");
      out = buf.split("\n").slice(-lines).join("\n");
    } catch {
      out = "";
    }
    return json({ log: out });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

async function handleAgents(req: Request): Promise<Response> {
  const s = await loadState();
  if (req.method === "POST") {
    const body = (await req.json()) as { name?: string; cmd?: string };
    const name = (body.name ?? "").trim();
    const cmd = (body.cmd ?? "").trim();
    if (!name || !cmd) return json({ error: "name and cmd are required" }, 400);
    s.agents[name] = cmd;
    await saveState(s);
  }
  return json(s.agents);
}

/** Walk a workspace's worktree and return a nested file tree. */
async function handleFiles(id: string): Promise<Response> {
  try {
    const ws = await getWorkspace(id);
    const tree = worktreePath(ws);
    const root = await walkDir(tree, 0);
    return json(root);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "target", ".works"]);
const MAX_FILES = 500;

async function walkDir(dir: string, depth: number): Promise<{ name: string; type: "dir" | "file"; children?: unknown[] }[]> {
  if (depth > 6) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  let count = 0;
  for (const e of entries) {
    if (count >= MAX_FILES) break;
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push({ name: e.name, type: "dir", children: await walkDir(`${dir}/${e.name}`, depth + 1) });
      count++;
    } else {
      out.push({ name: e.name, type: "file" });
      count++;
    }
  }
  return out;
}

/** Check which agent CLIs are installed on the host. */
async function handleAgentsStatus(): Promise<Response> {
  const names = ["omp", "claude", "codex", "opencode", "pi", "gemini"];
  const { execFile } = await import("child_process");
  const status: Record<string, boolean> = {};
  await Promise.all(
    names.map(
      (n) =>
        new Promise<void>((resolve) => {
          execFile("which", [n], (err) => {
            status[n] = !err;
            resolve();
          });
        }),
    ),
  );
  return json(status);
}


/** Read a file's contents for the code view. */
async function handleFile(id: string, req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const rel = url.searchParams.get("path") ?? "";
    const ws = await getWorkspace(id);
    const tree = worktreePath(ws);
    const abs = `${tree}/${rel}`;
    if (!abs.startsWith(tree)) return json({ error: "invalid path" }, 400);
    const buf = await readFile(abs, "utf8");
    return json({ path: rel, content: buf });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- PTY daemon client ---------------------------------------------------
// The Bun server speaks to a Node node-pty daemon over a Unix socket.
// This replaces the old `script`+`tmux attach` hack: real PTYs, proper
// resize, replay on reconnect, multiple sessions.

const PTY_SOCKET = process.env.PTY_SOCKET || "/tmp/kohlab-pty.sock";
const PTY_DAEMON = process.env.PTY_DAEMON || join(process.cwd(), "pty-daemon.cjs");

let daemonSock: import("net").Socket | null = null;
let daemonBuf = "";
let daemonStarted = false;
let daemonConnecting: Promise<import("net").Socket> | null = null;
function ensureDaemon() {
  if (daemonStarted) return;
  daemonStarted = true;
  const fs = require("fs");
  try { fs.unlinkSync(PTY_SOCKET); } catch {}
  const child = spawn("node", [PTY_DAEMON], { stdio: "ignore", detached: true });
  child.unref();
}

function daemonConnect() {
  if (daemonSock) return Promise.resolve(daemonSock);
  if (daemonConnecting) return daemonConnecting;
  daemonConnecting = new Promise<import("net").Socket>((resolve, reject) => {
    ensureDaemon();
    const tryConnect = (attempt: number) => {
      const sock = (require("net") as typeof import("net")).createConnection(PTY_SOCKET);
      sock.once("connect", () => {
        daemonSock = sock;
        daemonBuf = "";
        sock.on("data", onDaemonData);
        sock.on("close", () => {
          daemonSock = null;
          daemonConnecting = null;
        });
        sock.on("error", () => {
          daemonSock = null;
          daemonConnecting = null;
        });
        resolve(sock);
      });
      sock.once("error", (e: Error) => {
        if (attempt < 10) setTimeout(() => tryConnect(attempt + 1), 300);
        else {
          daemonConnecting = null;
          reject(e);
        }
      });
    };
    tryConnect(0);
  });
  return daemonConnecting;
}

/** WS client state per terminal: which session + ack subscription */
const termClients = new Map<ServerWebSocket, string>();

async function daemonSend(msg: unknown) {
  const sock = await daemonConnect();
  sock.write(JSON.stringify(msg) + "\n");
}

function onDaemonData(chunk: Buffer | string) {
  daemonBuf += chunk.toString("utf8");
  let idx;
  while ((idx = daemonBuf.indexOf("\n")) >= 0) {
    const line = daemonBuf.slice(0, idx);
    daemonBuf = daemonBuf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "output") {
        const txt = Buffer.from(msg.data, "base64").toString("utf8");
        // fan out to all ws clients subscribed to this session
        for (const [ws, sessId] of termClients) {
          // WebSocket.OPEN === 1; `ws.OPEN` is undefined on Bun's ServerWebSocket
          if (sessId === msg.id && ws.readyState === 1) {
            ws.send(txt);
          }
        }
      } else if (msg.type === "exit") {
        for (const [ws, sessId] of termClients) {
          if (sessId === msg.id && ws.readyState === 1) {
            ws.send("\x1b[90m[process exited]\x1b[0m\r\n");
          }
        }
      }
    } catch {}
  }
}

/** Attach a ws client to a workspace's PTY session. */
function attachPty(ws: ServerWebSocket, id: string) {
  const sessId = `works-${id}`;
  termClients.set(ws, sessId);
  void daemonSend({ type: "subscribe", id: sessId, replay: true });
  ws.send("\x1b[2J\x1b[H");
}


/** Ensure a workspace's PTY session exists (spawn the agent if not). */
async function ensurePtySession(id: string) {
  const ws = await getWorkspace(id);
  const s = await loadState();
  const cmd = (s.agents[ws.agent] || "sh").split(/\s+/);
  await daemonSend({
    type: "open",
    id: `works-${id}`,
    cwd: worktreePath(ws),
    cmd,
    cols: 120,
    rows: 36,
  });
  if (ws.payload) {
    await daemonSend({ type: "input", id: `works-${id}`, data: Buffer.from(ws.payload + "\r").toString("base64") });
  }
}

// --- server --------------------------------------------------------------

const server = serve({
  port: PORT,
  fetch: async (req, server) => {
    const url = new URL(req.url);
    const path = url.pathname;
    // access key gate: share links stay public-read; everything else needs the key
    // (checked before websocket upgrade so unauthenticated sockets are refused).
    // Static files (the dashboard shell) are always served — the page itself
    // shows a login screen and does authenticated API calls.
    const isStatic = !path.startsWith("/api") && !req.headers.get("upgrade");
    const shareIdRes = await shareId(req);
    const isShareLink = !!shareIdRes;
    if (!isShareLink && !isStatic && !authorized(req)) {
      return json({ error: "unauthorized — set ?key= or Authorization: Bearer" }, 401);
    }

    // WebSocket upgrade: any path that asks for an upgrade joins the terminal proxy
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (server.upgrade(req)) return undefined;
    }
    const m = path.match(/^\/api\/workspaces\/([^/]+)\/(start|stop|restart|delete|diff|commit|log|files|file|share)$/);
    if (m) {
      const [, id, action] = m;
      // share-mode access is read-only: only diff/log/files allowed
      if (action !== "diff" && action !== "log" && action !== "files" && action !== "share") {
        if (shareIdRes === id) {
          return json({ error: "read-only share link" }, 403);
        }
      }
      switch (action) {
        case "start": return handleStart(id);
        case "delete": return handleDelete(id);
        case "diff": return handleDiff(id);
        case "commit": return handleCommit(id, req);
        case "files": return handleFiles(id);
        case "file": return handleFile(id, req);
        case "share": return handleShare(id);
      }
    }

    if (path === "/api/agents-status") return handleAgentsStatus();
    if (path === "/api/clone" && req.method === "POST") return handleClone(req);
    if (path === "/api/agents" && (req.method === "GET" || req.method === "POST")) return handleAgents(req);



    if (path === "/api/workspaces" && req.method === "GET") {
      const url = new URL(req.url);
      const wantsShare = url.searchParams.has("share");
      // ?share= present but invalid → nothing to show
      if (wantsShare && !shareIdRes) return json([]);
      if (shareIdRes) {
        const list = await listWorkspaces();
        const w = list.find((x) => x.id === shareIdRes);
        return json(w ? [w] : []);
      }
      return listWorkspaces().then(json).catch((e) => json({ error: (e as Error).message }, 500));
    }
    if (path === "/api/workspaces" && req.method === "POST") return handleCreate(req);
    if (path === "/api/agents" && (req.method === "GET" || req.method === "POST")) return handleAgents(req);

    // Static files - serve the React app from web/dist, fall back to legacy public/
    const webDist = join(process.cwd(), "web", "dist");
    const legacy = join(import.meta.dir, "public");
    const roots = [webDist, legacy];
    if (path === "/" || path === "/index.html") {
      for (const root of roots) {
        const f = Bun.file(join(root, "index.html"));
        if (f.size > 0) return new Response(f);
      }
    }
    for (const root of roots) {
      const staticPath = join(root, path.slice(1));
      const f = Bun.file(staticPath);
      if (f.size > 0) return new Response(f);
    }
    return new Response("not found", { status: 404 });

    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      // every dashboard page is a push subscriber
      pushClients.add(ws);
    },
    message(ws, raw) {
      const str = String(raw);

      // JSON control frames (attach/resize) vs raw terminal input
      if (str.startsWith("{")) {
        try {
          const msg = JSON.parse(str) as { type?: string; id?: string; cols?: number; rows?: number };
          if (msg.type === "attach" && msg.id) {
            attachPty(ws, msg.id);
            void ensurePtySession(msg.id);
          } else if (msg.type === "resize" && msg.id && msg.cols && msg.rows) {
            void daemonSend({ type: "resize", id: `works-${msg.id}`, cols: msg.cols, rows: msg.rows });
          }
          return;
        } catch {
          // not JSON - fall through to terminal input
        }
      }
      const sessId = termClients.get(ws);
      if (sessId) {
        void daemonSend({ type: "input", id: sessId, data: Buffer.from(str, "utf8").toString("base64") });
      }
    },
    close(ws) {
      pushClients.delete(ws);
      termClients.delete(ws);
    },
    drain(ws) {
      // no-op
    },
  },
});

console.log(`works server on http://0.0.0.0:${PORT}`);
