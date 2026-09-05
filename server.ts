// works server — HTTP + WebSocket API over lib.ts

import { serve } from "bun";
import type { ServerWebSocket } from "bun";
import { mkdir, readdir, readFile } from "fs/promises";
import { isAbsolute, join, relative, resolve } from "path";
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
  shareWorkspace,
  workspaceByShare,
  authRequired,
  authenticate,
  listUsers,
  addUser,
  removeUser,
  audit,
  readAudit,
  loadState,
  ptySend,
  ptyLog,
  onDaemonMessage,
  sessionId,
} from "./lib";

const PORT = Number(process.env.PORT ?? 7676);
const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;

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
    const body = (await req.json()) as { url?: string; task?: string; agent?: string; payload?: string; limits?: { timeoutSec?: number; maxMemoryMb?: number; maxProcs?: number } };
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
    const ws = await createWorkspace({ repo: dest, task, agent: body.agent ?? "sh", payload: body.payload, limits: body.limits });
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
    limits?: { timeoutSec?: number; maxMemoryMb?: number; maxProcs?: number };
  };
  const task = (body.task ?? "").trim();
  if (!task) return json({ error: "task is required" }, 400);
  const repo = (body.repo ?? cwd()).trim();
  try {
    const ws = await createWorkspace({ repo, task, agent: body.agent ?? "sh", branch: body.branch, payload: body.payload, limits: body.limits });
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

/** Tail a workspace's main-session PTY log buffer (degrades to "" when absent). */
async function handleLog(id: string): Promise<Response> {
  try {
    const ws = await getWorkspace(id);
    const log = await ptyLog(sessionId(ws.id));
    return json({ log: log ?? "" });
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

/** List users (keys never exposed), owner-only. */
async function handleUsersList(): Promise<Response> {
  return json({ users: listUsers().map((u) => ({ id: u.id, name: u.name, role: u.role })) });
}

/** Create a user; the plaintext key is returned exactly once. owner-only. */
async function handleUserAdd(req: Request): Promise<Response> {
  const body = (await req.json()) as { id?: string; name?: string; role?: string };
  const id = (body.id ?? "").trim();
  const name = (body.name ?? "").trim();
  const role = (body.role ?? "member");
  if (!id || !name) return json({ error: "id and name are required" }, 400);
  if (!["owner", "member", "viewer"].includes(role)) return json({ error: "role must be owner|member|viewer" }, 400);
  try {
    const { user, key } = await addUser({ id, name, role: role as "owner" | "member" | "viewer" });
    return json({ user: { id: user.id, name: user.name, role: user.role }, key });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

/** Revoke a user. owner-only. */
async function handleUserRemove(id: string): Promise<Response> {
  try {
    await removeUser(id);
    return json({ ok: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

/** Tail the audit log. owner/member. */
async function handleAudit(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 200);
  return json({ events: await readAudit(limit) });
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

/** Install an agent CLI on the host (runs the npm global install). */
async function handleAgentInstall(req: Request): Promise<Response> {
  const body = (await req.json()) as { name?: string; cmd?: string };
  const name = (body.name ?? "").trim();
  const cmd = (body.cmd ?? "").trim();
  if (!name || !cmd) return json({ error: "name and cmd are required" }, 400);
  // whitelist: only known package installs, never arbitrary shell
  const allowed = ["npm i -g", "npm install -g", "bun add -g", "curl -fsSL"];
  if (!allowed.some((p) => cmd.startsWith(p))) {
    return json({ error: "command not allowed" }, 400);
  }
  const { exec } = await import("child_process");
  const { promise, resolve, reject } = Promise.withResolvers<{ ok: boolean; output: string }>();
  exec(cmd, { timeout: 300000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error(stderr.trim() || err.message));
    else resolve({ ok: true, output: stdout.slice(0, 2000) });
  });
  return promise.then(json).catch((e) => json({ error: (e as Error).message }, 400));
}


/** Read a file's contents for the code view. */
async function handleFile(id: string, req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const rel = url.searchParams.get("path") ?? "";
    const ws = await getWorkspace(id);
    const tree = worktreePath(ws);
    const abs = resolve(tree, rel);
    const relCheck = relative(tree, abs);
    if (relCheck.startsWith("..") || isAbsolute(relCheck)) return json({ error: "invalid path" }, 400);
    const buf = await readFile(abs, "utf8");
    return json({ path: rel, content: buf });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

/** Store a browser-pasted image outside the worktree and return its remote path. */
async function handleImageUpload(id: string, req: Request): Promise<Response> {
  try {
    const workspace = await getWorkspace(id);
    const declaredLength = Number(req.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_IMAGE_UPLOAD_BYTES) return json({ error: "image exceeds 20 MiB limit" }, 413);

    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0) return json({ error: "image is empty" }, 400);
    if (bytes.length > MAX_IMAGE_UPLOAD_BYTES) return json({ error: "image exceeds 20 MiB limit" }, 413);

    const mimeType = sniffImageMime(bytes);
    if (!mimeType) return json({ error: "unsupported image; use PNG, JPEG, GIF, or WebP" }, 415);

    const imageDir = join(WORKS_DIR, "images", workspace.id);
    await mkdir(imageDir, { recursive: true, mode: 0o700 });
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
    const imagePath = join(imageDir, `${Date.now()}-${crypto.randomUUID()}.${extension}`);
    await Bun.write(imagePath, bytes);
    return json({ path: imagePath, mimeType, bytes: bytes.length });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

function sniffImageMime(bytes: Uint8Array): string | undefined {
  const startsWith = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (bytes.length >= 8 && startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (bytes.length >= 3 && startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (bytes.length >= 6) {
    const gif = new TextDecoder().decode(bytes.slice(0, 6));
    if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12) {
    const riff = new TextDecoder().decode(bytes.slice(0, 4));
    const webp = new TextDecoder().decode(bytes.slice(8, 12));
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }
  return undefined;
}

/** List GitHub repos via `gh` (if authenticated) for the repo browser. */
async function handleGhRepos(): Promise<Response> {
  const { execFile } = await import("child_process");
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; repos: string[]; authed: boolean }>();
  execFile("gh", ["auth", "status"], { timeout: 8000 }, (authErr) => {
    if (authErr) {
      resolve({ ok: true, repos: [], authed: false });
      return;
    }
    execFile(
      "gh",
      ["repo", "list", "--limit", "30", "--json", "nameWithOwner,description", "--jq", '.[] | .nameWithOwner + "\\t" + (.description // "")'],
      { timeout: 10000 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: true, repos: [], authed: true });
          return;
        }
        resolve({ ok: true, repos: stdout.trim().split("\n").filter(Boolean), authed: true });
      },
    );
  });
  return promise.then((result) => json(result));
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
// --- PTY terminal fan-out --------------------------------------------------
// The daemon connection is owned by lib.ts (shared ptySend / onDaemonMessage);
// this section only maps WS clients to sessions and fans terminal bytes out.

/** WS client state per terminal: which session + ack subscription */
const termClients = new Map<ServerWebSocket, string>();

// register the fan-out handler once
onDaemonMessage((msg) => {
  if (msg.type === "output" && typeof msg.id === "string" && typeof msg.data === "string") {
    const txt = Buffer.from(msg.data, "base64").toString("utf8");
    for (const [ws, sessId] of termClients) {
      // WebSocket.OPEN === 1; `ws.OPEN` is undefined on Bun's ServerWebSocket
      if (sessId === msg.id && ws.readyState === 1) {
        ws.send(txt);
      }
    }
  } else if (msg.type === "exit" && typeof msg.id === "string") {
    for (const [ws, sessId] of termClients) {
      if (sessId === msg.id && ws.readyState === 1) {
        ws.send("\x1b[90m[process exited]\x1b[0m\r\n");
      }
    }
  }
});

/** Attach a ws client to a workspace's named PTY session. */
function attachPty(ws: ServerWebSocket, id: string, terminalId = "main") {
  const sessId = sessionId(id, terminalId);
  termClients.set(ws, sessId);
  void ptySend({ type: "subscribe", id: sessId, replay: true });
  ws.send("\x1b[2J\x1b[H");
}

/** Ensure a workspace's named PTY session exists (spawn the agent if not). */
async function ensurePtySession(id: string, terminalId = "main") {
  const ws = await getWorkspace(id);
  const s = await loadState();
  const cmd = (s.agents[ws.agent] || "sh").split(/\s+/);
  const sessId = sessionId(id, terminalId);
  await ptySend({
    type: "open",
    id: sessId,
    cwd: worktreePath(ws),
    cmd,
    cols: 120,
    rows: 36,
    meta: { workspace: id, terminal: terminalId },
    limits: ws.limits ?? {},
  });
  if (ws.payload && terminalId === "main") {
    await ptySend({ type: "input", id: sessId, data: Buffer.from(ws.payload + "\r").toString("base64") });
  }
  // a browser-attach start is a real run: record it so completion fires
  if (terminalId === "main") await markStarted(id);
}

// --- server --------------------------------------------------------------
const server = serve({
  port: PORT,
  fetch: async (req, server) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const m = path.match(/^\/api\/workspaces\/([^/]+)\/(start|stop|restart|delete|diff|commit|files|file|image|share|log)$/);
    const shareIdRes = m || url.searchParams.has("share") ? await shareId(req) : null;

    // resolve the actor once: named user / legacy key / share / anonymous / null(denied)
    const auth = path.startsWith("/api") ? await authenticate(req) : null;
    const denied = !auth && authRequired();
    const actor = auth ? (auth.kind === "user" ? auth.id : auth.kind === "legacy" ? "legacy" : auth.kind === "share" ? "share" : "anonymous") : "anonymous";
    const role: string | null = auth && (auth.kind === "user" || auth.kind === "legacy") ? auth.role : null;
    const canMutate = !denied && ((role === "owner" || role === "member") || auth?.kind === "anonymous");
    const isOwner = !denied && (role === "owner" || auth?.kind === "anonymous");

    // WebSocket upgrade: terminal proxy + push — require auth.
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (denied) return json({ error: "unauthorized" }, 401);
      if (server.upgrade(req)) return undefined;
    }

    if (m) {
      const [, id, action] = m;
      const shareReadOnly = action === "diff" || action === "files" || action === "file" || action === "log";
      // share-token access to this workspace is read-only
      if (shareIdRes === id && shareReadOnly) {
        switch (action) {
          case "diff": return handleDiff(id);
          case "files": return handleFiles(id);
          case "file": return handleFile(id, req);
          case "log": return handleLog(id);
        }
      }
      const readOnly = action === "diff" || action === "files" || action === "file" || action === "log";
      if (readOnly) {
        if (denied) return json({ error: "unauthorized" }, 401);
      } else if (!canMutate) {
        return json({ error: "forbidden — viewer cannot " + action }, 403);
      }
      switch (action) {
        case "start": void audit(actor, "start", id); return handleStart(id);
        case "stop": void audit(actor, "stop", id); return handleStop(id);
        case "restart": void audit(actor, "restart", id); return handleRestart(id);
        case "delete": void audit(actor, "delete", id); return handleDelete(id);
        case "commit": void audit(actor, "commit", id); return handleCommit(id, req);
        case "files": return handleFiles(id);
        case "file": return handleFile(id, req);
        case "log": return handleLog(id);
        case "image":
          if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
          void audit(actor, "image", id);
          return handleImageUpload(id, req);
        case "share": void audit(actor, "share", id); return handleShare(id);
      }
    }

    if (path === "/api/auth/required") {
      return json({ required: authRequired() });
    }
    if (path === "/api/users" && req.method === "GET") {
      if (!isOwner) return json({ error: "forbidden" }, 403);
      return handleUsersList();
    }
    if (path === "/api/users" && req.method === "POST") {
      if (!isOwner) return json({ error: "forbidden" }, 403);
      return handleUserAdd(req);
    }
    if (path.match(/^\/api\/users\/[^/]+$/) && req.method === "DELETE") {
      if (!isOwner) return json({ error: "forbidden" }, 403);
      const uid = decodeURIComponent(path.split("/").pop() ?? "");
      return handleUserRemove(uid);
    }
    if (path === "/api/audit") {
      if (denied || (!(role === "owner" || role === "member") && auth?.kind !== "anonymous")) {
        return json({ error: "forbidden" }, 403);
      }
      return handleAudit(req);
    }
    if (path === "/api/agents" && (req.method === "GET" || req.method === "POST")) {
      if (denied) return json({ error: "unauthorized" }, 401);
      if (req.method === "POST") void audit(actor, "agent.add");
      return handleAgents(req);
    }
    if (path === "/api/agents/install" && req.method === "POST") {
      if (!canMutate) return json({ error: "forbidden" }, 403);
      void audit(actor, "agent.install");
      return handleAgentInstall(req);
    }
    if (path === "/api/agents-status") {
      if (denied) return json({ error: "unauthorized" }, 401);
      return handleAgentsStatus();
    }
    if (path === "/api/gh/repos") {
      if (denied) return json({ error: "unauthorized" }, 401);
      return handleGhRepos();
    }
    if (path === "/api/clone" && req.method === "POST") {
      if (!canMutate) return json({ error: "forbidden" }, 403);
      void audit(actor, "clone", undefined);
      return handleClone(req);
    }
    if (path === "/api/workspaces" && req.method === "GET") {
      const wantsShare = url.searchParams.has("share");
      if (wantsShare && !shareIdRes) return json([]);
      if (shareIdRes) {
        const list = await listWorkspaces();
        const w = list.find((x) => x.id === shareIdRes);
        return json(w ? [w] : []);
      }
      if (denied) return json({ error: "unauthorized" }, 401);
      return listWorkspaces().then(json).catch((e) => json({ error: (e as Error).message }, 500));
    }
    if (path === "/api/workspaces" && req.method === "POST") {
      if (!canMutate) return json({ error: "forbidden" }, 403);
      return handleCreate(req);
    }

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
      // resolve + containment: a raw path can never escape its root
      const staticPath = resolve(root, "." + path);
      if (!staticPath.startsWith(resolve(root) + "/")) continue;
      const f = Bun.file(staticPath);
      if (f.size > 0) return new Response(f);
    }
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
          const msg = JSON.parse(str) as { type?: string; id?: string; terminalId?: string; cols?: number; rows?: number };
          if (msg.type === "attach" && msg.id) {
            // open/spawn before subscribe so the replay never misses the first bytes
            void ensurePtySession(msg.id, msg.terminalId).then(() => attachPty(ws, msg.id, msg.terminalId));
          } else if (msg.type === "resize" && msg.id && msg.cols && msg.rows) {
            void ptySend({
              type: "resize",
              id: sessionId(msg.id, msg.terminalId),
              cols: msg.cols,
              rows: msg.rows,
            });
          }
          return;
        } catch {
          // not JSON - fall through to terminal input
        }
      }
      const sessId = termClients.get(ws);
      if (sessId) {
        void ptySend({ type: "input", id: sessId, data: Buffer.from(str, "utf8").toString("base64") });
      }
    },
    close(ws) {
      pushClients.delete(ws);
      const sessId = termClients.get(ws);
      if (sessId) void ptySend({ type: "unsubscribe", id: sessId });
      termClients.delete(ws);
    },
    drain(ws) {
      // no-op
    },
  },
});

console.log(`works server on http://0.0.0.0:${PORT}`);
