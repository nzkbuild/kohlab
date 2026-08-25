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
  startWatcher,
  onWorkspaceDone,
  notifyWebhook,
  shareWorkspace,
  workspaceByShare,
  authorized,
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

async function handleFiles(id: string): Promise<Response> {
  try {
    const ws = await getWorkspace(id);
    const tree = worktreePath(ws);
    const entries = await readdir(tree, { withFileTypes: true });
    const names = entries
      .filter((e) => e.isDirectory() ? e.name !== ".git" : true)
      .filter((e) => !e.name.startsWith("."))
      .slice(0, 200)
      .map((e) => e.name);
    return json(names);
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

// --- WebSocket terminal proxy -------------------------------------------

function openTmuxSocket(ws: ServerWebSocket, session: string) {
  // tmux has no native websocket; we spawn `tmux attach -t <session>` in a
  // pty so bytes flow both ways. The tmux session itself survives server
  // restarts — this pty is just a viewer.
  console.error("[ws] attaching pty to session", session);
  const pty = spawn("script", ["-qefc", `tmux attach -t ${session}`, "/dev/null"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "xterm-256color", COLUMNS: "120", LINES: "36" },
  }) as ChildProcess & { stdin: NodeJS.WritableStream };
  pty.stdout?.on("data", (d) => ws.send(d.toString()));
  pty.stderr?.on("data", (d) => ws.send(d.toString()));
  pty.on("spawn", () => console.error("[ws] pty spawned pid", pty.pid));
  pty.on("error", (e) => console.error("[ws] pty error:", e.message));
  pty.on("exit", (code, sig) => console.error("[ws] pty exited", code, sig));
  pty.on("close", () => {
    if (ws.readyState === ws.OPEN) ws.send("\x1b[31m[session ended]\x1b[0m\r\n");
  });
  ws.data = pty;
  ws.send("\x1b[2J\x1b[H");
  return pty;
}

// --- server --------------------------------------------------------------

const server = serve({
  port: PORT,
  fetch: async (req, server) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // WebSocket upgrade: any path that asks for an upgrade joins the terminal proxy
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (server.upgrade(req)) return undefined;
    }

    // access key gate: share links stay public-read; everything else needs the key
    const shareIdRes = await shareId(req);
    const isShareLink = !!shareIdRes;
    if (!isShareLink && !authorized(req)) {
      return json({ error: "unauthorized — set ?key= or Authorization: Bearer" }, 401);
    }
    const m = path.match(/^\/api\/workspaces\/([^/]+)\/(start|stop|restart|delete|diff|commit|log|files|share)$/);
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
        case "stop": return handleStop(id);
        case "restart": return handleRestart(id);
        case "delete": return handleDelete(id);
        case "diff": return handleDiff(id);
        case "commit": return handleCommit(id, req);
        case "log": return handleLog(id, req);
        case "files": return handleFiles(id);
        case "share": return handleShare(id);
      }
    }

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

    // Static files
    if (path === "/" || path === "/index.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "index.html")));
    }
    const staticPath = join(import.meta.dir, "public", path.slice(1));
    const f = Bun.file(staticPath);
    if (f.size > 0) return new Response(f);

    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      // every dashboard page is a push subscriber
      pushClients.add(ws);
    },
    message(ws, raw) {
      const str = String(raw);
      // JSON control frames (attach) vs raw terminal input
      if (str.startsWith("{")) {
        try {
          const msg = JSON.parse(str) as { type?: string; id?: string };
          if (msg.type === "attach" && msg.id) {
            openTmuxSocket(ws, `works-${msg.id}`);
          }
          return;
        } catch {
          // not JSON — fall through to terminal input
        }
      }
      const pty = ws.data as (ChildProcess & { stdin: NodeJS.WritableStream }) | undefined;
      if (!pty) {
        console.error("[ws] input without pty attached:", JSON.stringify(str.slice(0, 40)));
        return;
      }
      try {
        pty.stdin.write(str);
      } catch (e) {
        console.error("[ws] pty stdin write failed:", (e as Error).message);
      }
    },
    close(ws) {
      pushClients.delete(ws);
      const pty = ws.data as (ChildProcess & { stdin: NodeJS.WritableStream }) | undefined;
      pty?.kill();
    },
    drain(ws) {
      const pty = ws.data as (ChildProcess & { stdin: NodeJS.WritableStream }) | undefined;
      pty?.stdin?.write("");
    },
  },
});

console.log(`works server on http://0.0.0.0:${PORT}`);
