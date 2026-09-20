// works server — HTTP + WebSocket API over lib.ts

import { serve } from "bun";
import type { ServerWebSocket } from "bun";
import { execFile, spawn } from "child_process";
import { mkdir, open, readdir, readFile } from "fs/promises";
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
  imagesDir,
  spawnAgentSession,
  // ensurePtySession() calls markStarted() to record a browser-attach as a real
  // run. The call existed but the import did not, so the first terminal attach
  // threw ReferenceError and took the whole server process down.
  markStarted,
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
  saveState,
  ptySend,
  ptyLog,
  onDaemonMessage,
  sessionId,
  checkRelease,
  updateRunState,
  createInvite,
  acceptInvite,
  setUserRole,
  canProvisionOsUsers,
} from "./lib";

const PORT = Number(process.env.PORT ?? 7676);
/** Where to bind. `HOST=127.0.0.1` keeps it to this box; the default serves the
 *  tailnet or the LAN, which is why a keyless server there generates one. */
const HOST = process.env.HOST ?? "0.0.0.0";
const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Browser push subscribers (dashboard pages). */
const pushClients = new Set<ServerWebSocket>();

// completion → push to every open dashboard + fire webhook
onWorkspaceDone((ws) => {
  const msg = JSON.stringify({ type: "workspace.done", id: ws.id, task: ws.task, agent: ws.agent });
  for (const c of pushClients) {
    // `c.OPEN` does not exist on a Bun ServerWebSocket, so this comparison was
    // always false and the done-ping never reached a single client.
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  }
  containFailure(notifyWebhook(ws), "notify webhook");
});

// poll for finished agents
/**
 * v1.8 ownership gate. Owners / legacy-key / anonymous (open server) may touch
 * every workspace. A named member may only touch workspaces they own; legacy
 * root-owned workspaces (no ownerId) are off-limits to members entirely.
 * Viewer is treated like member here (read-only is enforced separately).
 */
async function mayAccessWorkspace(auth: { kind?: string; id?: string; role?: string | null } | null, wsId: string): Promise<boolean> {
  if (!auth || auth.kind !== "user") return true; // legacy, share, anonymous-open
  if (auth.role === "owner") return true;
  try {
    const ws = await getWorkspace(wsId);
    return !!ws.ownerId && ws.ownerId === auth.id;
  } catch {
    return false;
  }
}
startWatcher();



async function handleClone(req: Request, actorUserId?: string): Promise<Response> {
  try {
    const body = (await req.json()) as { url?: string; task?: string; agent?: string; payload?: string; limits?: { timeoutSec?: number; maxMemoryMb?: number; maxProcs?: number } };
    const url = (body.url ?? "").trim();
    const task = (body.task ?? "work on " + url).trim();
    if (!url) return json({ error: "url is required" }, 400);
    if (actorUserId) {
      // a named member clones into their own isolated workspace (server does
      // the git work as root, then hands the tree to the member's OS user)
      const ws = await createWorkspace({ repo: "", url, task, agent: body.agent ?? "sh", payload: body.payload, limits: body.limits, ownerId: actorUserId });
      return json(ws);
    }
    // legacy/anonymous path: clone into a fresh dir under WORKS_DIR
    const dest = `${WORKS_DIR}/clones/${Date.now()}`;
    await mkdir(`${WORKS_DIR}/clones`, { recursive: true });
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

async function handleCreate(req: Request, actorUserId?: string): Promise<Response> {
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
  // `cwd()` was never imported here, so creating a workspace without an
  // explicit repo threw ReferenceError and killed the server.
  const repo = (body.repo ?? process.cwd()).trim();
  const url = repo.match(/^[a-z]+:\/\//) ? repo : undefined;
  // A named member may only create from a git URL: a host repo path would run
  // the agent in the legacy root-owned flow (privilege escalation) or reach
  // outside the member's home. Owners/anonymous keep the host-path flow.
  if (actorUserId && !url) return json({ error: "members create workspaces from a git URL" }, 403);
  try {
    const ws = await createWorkspace({
      repo,
      url,
      task,
      agent: body.agent ?? "sh",
      branch: body.branch,
      payload: body.payload,
      limits: body.limits,
      ownerId: actorUserId,
    });
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
  const out: { name: string; type: "dir" | "file"; children?: unknown[] }[] = [];
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
  return json({
    // `pending` is an invitation nobody has accepted yet; `canInvite` says whether
    // this server can give a new member their own account, so the panel can say
    // so before someone is invited into the owner's account by mistake.
    users: listUsers().map((u) => ({ id: u.id, name: u.name, role: u.role, pending: !u.key })),
    canInvite: canProvisionOsUsers(),
  });
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

/**
 * Create an invitation and return the link once.
 *
 * The link's fragment carries the token, never a query string: a fragment is not
 * sent to the server, so the token cannot land in an access log, and it does not
 * travel in a Referer header if the page loads anything from elsewhere.
 */
async function handleInviteCreate(req: Request, actor: string): Promise<Response> {
  const body = (await req.json()) as { id?: string; name?: string; role?: string };
  const id = (body.id ?? "").trim();
  const name = (body.name ?? "").trim() || id;
  const role = (body.role ?? "member") as "owner" | "member" | "viewer";
  if (!id) return json({ error: "id is required" }, 400);
  if (!["owner", "member", "viewer"].includes(role)) return json({ error: "role must be owner|member|viewer" }, 400);
  try {
    const { token, expires } = await createInvite({ id, name, role, invitedBy: actor });
    return json({ id, role, expires, path: `/join#${token}` });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

/** Redeem an invitation. The only route reachable without a key. */
async function handleJoin(req: Request): Promise<Response> {
  const body = (await req.json()) as { token?: string };
  const token = (body.token ?? "").trim();
  if (!token) return json({ error: "token is required" }, 400);
  try {
    const { id, name, role, key } = await acceptInvite(token);
    return json({ user: { id, name, role }, key });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

async function handleUserRole(id: string, req: Request): Promise<Response> {
  const body = (await req.json()) as { role?: string };
  const role = body.role as "owner" | "member" | "viewer";
  if (!["owner", "member", "viewer"].includes(role)) return json({ error: "role must be owner|member|viewer" }, 400);
  try {
    const user = await setUserRole(id, role);
    return json({ user: { id: user.id, name: user.name, role: user.role } });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

async function handleUserRemove(id: string): Promise<Response> {
  try {
    const { warning } = await removeUser(id);
    // The revoke succeeded as far as the API goes, but if their OS account
    // survived, the caller has to hear it rather than assume they are gone.
    return json(warning ? { ok: true, warning } : { ok: true });
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

/** A package name: `thing` or `@scope/thing`. Nothing else — no flags, no
 *  paths, no shell metacharacters, no URLs. */
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

/**
 * Install an agent globally.
 *
 * The input is user-supplied text that becomes a process, so both halves are
 * load-bearing:
 *
 *  - **No shell.** This used to be `exec(cmd)`, i.e. `/bin/sh -c`, behind a
 *    `cmd.startsWith("npm i -g")` "whitelist". `npm i -g x; cp -r
 *    /home/koh-alice /tmp/loot` passed that check and ran as the server user —
 *    root. Since any *member* may call this route, it was a member-to-root
 *    escalation that made the v1.8 per-OS-user isolation decorative: Bob did not
 *    need to read Alice's home himself, he could ask the server to. `execFile`
 *    takes argv, so there is no shell to inject into.
 *  - **Argv allowlisted.** Only the package managers the UI installs from, and
 *    exactly `<manager> [i|install|add] -g <package>`. That rejects flags
 *    (`--prefix /etc`), extra arguments, and `curl http://169.254.169.254/...`,
 *    which is a credential-theft primitive on a VPS with a metadata service.
 */
async function handleAgentInstall(req: Request): Promise<Response> {
  const body = (await req.json()) as { name?: string; cmd?: string };
  const name = (body.name ?? "").trim();
  const cmd = (body.cmd ?? "").trim();
  if (!name || !cmd) return json({ error: "name and cmd are required" }, 400);

  const argv = cmd.split(/\s+/);
  const [bin, verb, globalFlag, pkg, ...rest] = argv;
  const verbOk = (bin === "npm" && (verb === "i" || verb === "install")) || (bin === "bun" && verb === "add");
  if (!verbOk || globalFlag !== "-g" || !pkg || rest.length > 0 || !PACKAGE_NAME.test(pkg)) {
    return json({ error: "only global package installs are allowed, as: npm i -g <package>" }, 400);
  }

  const { promise, resolve, reject } = Promise.withResolvers<{ ok: boolean; output: string }>();
  execFile(bin, argv.slice(1), { timeout: 300000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error((stderr || err.message).trim()));
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

    const imageDir = imagesDir(workspace);
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

/**
 * Start the update script and return immediately.
 *
 * Detached, with stdout and stderr going to $WORKS_DIR/update.log. The reload
 * restarts this server before the script is finished, so that file — and the
 * marker lines the script writes into it — is the only surviving record of how
 * the update went. `KOHLAB_OTA=1` is what tells the script it is being recorded.
 */
async function handleReleaseUpdate(): Promise<Response> {
  const logPath = join(WORKS_DIR, "update.log");
  try {
    await mkdir(WORKS_DIR, { recursive: true });
    const fd = await open(logPath, "w");
    const child = spawn("bash", [join(import.meta.dir, "scripts", "update.sh")], {
      cwd: import.meta.dir,
      env: { ...process.env, KOHLAB_OTA: "1" },
      stdio: ["ignore", fd.fd, fd.fd],
      detached: true,
    });
    child.unref();
    // the child has its own descriptor now
    await fd.close().catch(() => {});
    return json({ started: true, log: logPath });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
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
  } else if (msg.type === "error") {
    // The daemon answers { type:"error", message } — e.g. "unknown session"
    // when a buffer is gone. Unhandled before, so a failed subscribe was
    // indistinguishable from a slow one in both the client and the logs.
    console.error(
      `[kohlab] pty daemon error for session ${String(msg.id ?? "-")}: ${String(msg.message ?? "unknown")}`,
    );
  }
});

/**
 * The size each session was last asked to be, keyed by session id.
 *
 * The client sends `attach` and then `resize` immediately, but the PTY is
 * created asynchronously — so the first resize routinely arrives before the
 * session exists and would be dropped. The latest size is remembered here and
 * re-applied as soon as the attach finishes. Bounded by the number of open
 * terminals, which is bounded by the number of workspaces.
 */
const pendingResize = new Map<string, { cols: number; rows: number }>();

/** Attach a ws client to a workspace's named PTY session. */
function attachPty(ws: ServerWebSocket, id: string, terminalId = "main") {
  const sessId = sessionId(id, terminalId);
  termClients.set(ws, sessId);
  containFailure(ptySend({ type: "subscribe", id: sessId, replay: true }), `subscribe ${id}`);
  ws.send("\x1b[2J\x1b[H");
}

/**
 * Run a fire-and-forget promise with its rejection contained.
 *
 * Every terminal/push operation below is fire-and-forget by design, but an
 * unhandled rejection on a socket callback exits the Bun process — one client
 * attaching twice would take the server down for everyone. Rejections here are
 * logged and dropped, never fatal.
 */
function containFailure(promise: Promise<unknown>, what: string): void {
  void promise.catch((error: unknown) => {
    console.error(`[kohlab] ${what} failed:`, error instanceof Error ? error.message : error);
  });
}

/** Ensure a workspace's named PTY session exists (spawn the agent if not). */
async function ensurePtySession(id: string, terminalId = "main") {
  const ws = await getWorkspace(id);
  /**
   * Do not resurrect a run that has ENDED.
   *
   * `stopped` is set when the agent exits, so a finished workspace used to be
   * relaunched just by opening it. That also defeated accepting it: accepting is
   * the only way out of the review queue, but the run that opening it started
   * ended after the acceptance and put the workspace straight back in the queue.
   *
   * A workspace that has never run is still spawned here on purpose — creating a
   * workspace does not start it, and both the onboarding copy and the README
   * promise that opening it does. Only the ended case is blocked.
   */
  if (ws.stopped !== null) return;

  try {
    await spawnAgentSession(ws, terminalId);
  } catch (error) {
    // Re-attaching to a session that is already live is the normal case for a
    // browser reload or a second tab, not a failure. The daemon reports it as
    // an error ("session already exists: <id>", pty-daemon.cjs), and this is
    // our own daemon's message, so matching it here is an internal contract.
    if (!/session already exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
  // a browser-attach start is a real run: record it so completion fires
  if (terminalId === "main") await markStarted(id);
}

// --- server --------------------------------------------------------------
serve({
  port: PORT,
  // Every interface by default, as before — but now a choice with a consequence:
  // bound anywhere but loopback with no key and no users, the server generates
  // itself one (see resolveAccessKey in lib.ts).
  hostname: HOST,
  fetch: async (req, server) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const m = path.match(/^\/api\/workspaces\/([^/]+)\/(start|stop|restart|delete|diff|commit|files|file|image|share|log)$/);
    const shareIdRes = m || url.searchParams.has("share") ? await shareId(req) : null;

    // resolve the actor once: named user / legacy key / share / anonymous / null(denied)
    // The terminal and done-ping sockets connect to `/`, not `/api`, so the
    // upgrade request must be authenticated too — otherwise `auth` is null,
    // `denied` is true, and every socket is rejected 401 the moment an access
    // key is configured.
    const isWebSocket = req.headers.get("upgrade")?.toLowerCase() === "websocket";
    const auth = path.startsWith("/api") || isWebSocket ? await authenticate(req) : null;
    const denied = !auth && authRequired();
    const actor = auth ? (auth.kind === "user" ? auth.id : auth.kind === "legacy" ? "legacy" : auth.kind === "share" ? "share" : "anonymous") : "anonymous";
    const role: string | null = auth && (auth.kind === "user" || auth.kind === "legacy") ? auth.role : null;
    const actorUserId = auth?.kind === "user" ? auth.id : undefined;
    const canMutate = !denied && ((role === "owner" || role === "member") || auth?.kind === "anonymous");
    const isOwner = !denied && (role === "owner" || auth?.kind === "anonymous");

    // WebSocket upgrade: terminal proxy + push — require auth.
    if (isWebSocket) {
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
      // v1.8 ownership: a named member/viewer may only touch their own
      // workspaces (share-token reads already returned above). Owners and
      // the legacy/anonymous single-user flows pass through.
      const readOnly = action === "diff" || action === "files" || action === "file" || action === "log";
      if (!(await mayAccessWorkspace(auth, id))) {
        return json({ error: "forbidden — not your workspace" }, 403);
      }
      if (readOnly) {
        if (denied) return json({ error: "unauthorized" }, 401);
      } else if (!canMutate) {
        return json({ error: "forbidden — viewer cannot " + action }, 403);
      }
      switch (action) {
        case "start": containFailure(audit(actor, "start", id), "audit"); return handleStart(id);
        case "stop": containFailure(audit(actor, "stop", id), "audit"); return handleStop(id);
        case "restart": containFailure(audit(actor, "restart", id), "audit"); return handleRestart(id);
        case "delete": containFailure(audit(actor, "delete", id), "audit"); return handleDelete(id);
        case "commit": containFailure(audit(actor, "commit", id), "audit"); return handleCommit(id, req);
        case "diff": return handleDiff(id);
        case "files": return handleFiles(id);
        case "file": return handleFile(id, req);
        case "log": return handleLog(id);
        case "image":
          if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
          containFailure(audit(actor, "image", id), "audit");
          return handleImageUpload(id, req);
        case "share": containFailure(audit(actor, "share", id), "audit"); return handleShare(id);
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
      // GET and DELETE next to this both require isOwner. This had no check at
      // all — not even `denied` — so any authenticated caller could POST
      // {role: "owner"} and mint themselves an owner key. A viewer escalating to
      // owner is the whole box, and it provisions an OS account while it does it.
      if (denied) return json({ error: "unauthorized" }, 401);
      if (!isOwner) return json({ error: "forbidden — only an owner can add members" }, 403);
      return handleUserAdd(req);
    }
    // Inviting, and redeeming an invitation. `/api/join` is the one route that
    // must work without credentials: the token *is* the credential, it is
    // single-use and it expires. Inviting is an owner action.
    if (path === "/api/invites" && req.method === "POST") {
      if (denied) return json({ error: "unauthorized" }, 401);
      if (!isOwner) return json({ error: "forbidden — only an owner can invite" }, 403);
      return handleInviteCreate(req, actor);
    }
    if (path === "/api/join" && req.method === "POST") {
      return handleJoin(req);
    }
    if (path.match(/^\/api\/users\/[^/]+$/) && req.method === "PATCH") {
      if (denied) return json({ error: "unauthorized" }, 401);
      if (!isOwner) return json({ error: "forbidden — only an owner can change roles" }, 403);
      const uid = decodeURIComponent(path.split("/").pop() ?? "");
      return handleUserRole(uid, req);
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
      // A launcher is a command that later runs in someone's workspace, and
      // adding one writes state. Viewers read; this is not a read.
      if (req.method === "POST" && !canMutate) return json({ error: "forbidden — viewer cannot add agents" }, 403);
      if (req.method === "POST") containFailure(audit(actor, "agent.add"), "audit");
      return handleAgents(req);
    }
    if (path === "/api/agents/install" && req.method === "POST") {
      if (!canMutate) return json({ error: "forbidden" }, 403);
      containFailure(audit(actor, "agent.install"), "audit");
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
    // OTA: what the pushed upstream publishes, and — owner only — apply it.
    if (path === "/api/release") {
      if (denied) return json({ error: "unauthorized" }, 401);
      const force = url.searchParams.get("force") === "1";
      return json({ ...(await checkRelease(undefined, { force })), ...(await updateRunState()) });
    }
    if (path === "/api/release/update" && req.method === "POST") {
      // Updating rewrites the checkout and restarts the service, so it is an
      // owner action, never a member/viewer one, and never a share token.
      // No credentials is 401; credentials without the role is 403.
      if (denied) return json({ error: "unauthorized" }, 401);
      if (!isOwner) return json({ error: "forbidden — only an owner can update the server" }, 403);
      if ((await updateRunState()).running) return json({ error: "an update is already running" }, 409);
      containFailure(audit(actor, "update", undefined, "OTA"), "audit");
      return handleReleaseUpdate();
    }
    if (path === "/api/clone" && req.method === "POST") {
      if (!canMutate) return json({ error: "forbidden" }, 403);
      containFailure(audit(actor, "clone", undefined), "audit");
      return handleClone(req, actorUserId);
    }
    if (path === "/api/workspaces" && req.method === "GET") {
      const wantsShare = url.searchParams.has("share");
      if (wantsShare && !shareIdRes) return json([]);
      if (shareIdRes) {
        const list = await listWorkspaces();
        const w = list.find((x) => x.id === shareIdRes);
        if (w && !(await mayAccessWorkspace(auth, w.id))) return json({ error: "forbidden — not your workspace" }, 403);
        return json(w ? [w] : []);
      }
      if (denied) return json({ error: "unauthorized" }, 401);
      // a named member only ever sees their own workspaces
      const list = await listWorkspaces();
      const scoped = auth?.kind === "user" && auth.role !== "owner" ? list.filter((w) => w.ownerId === auth.id) : list;
      return json(scoped);
    }
    if (path === "/api/workspaces" && req.method === "POST") {
      if (!canMutate) return json({ error: "forbidden" }, 403);
      return handleCreate(req, actorUserId);
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

    // SPA history fallback. Client routes (/w/:id, /workspaces, /settings) have
    // no file behind them, so without this a refresh or a shared deep link
    // 404s in production while `vite dev` hides it behind its own fallback.
    // Only navigations that actually want a document get the shell — an XHR for
    // a missing asset must still 404 so the client can see the real failure.
    const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
    if ((req.method === "GET" || req.method === "HEAD") && wantsHtml && !path.startsWith("/api")) {
      for (const root of roots) {
        const f = Bun.file(join(root, "index.html"));
        if (f.size > 0) return new Response(f);
      }
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
            // Hoisted out of the closures below: TypeScript cannot carry the
            // `msg.id` narrowing into a callback.
            const attachId = msg.id;
            const attachTerminal = msg.terminalId;
            // open/spawn before subscribe so the replay never misses the first bytes
            containFailure(
              ensurePtySession(attachId, attachTerminal)
                .then(() => {
                  // The session exists now: apply the size this client already
                  // asked for, which may have been sent before the PTY existed.
                  const sessId = sessionId(attachId, attachTerminal);
                  const dims = pendingResize.get(sessId);
                  if (!dims) return;
                  return ptySend({ type: "resize", id: sessId, cols: dims.cols, rows: dims.rows });
                })
                .then(() => attachPty(ws, attachId, attachTerminal)),
              `attach ${attachId}`,
            );
          } else if (msg.type === "resize" && msg.id && msg.cols && msg.rows) {
            const sessId = sessionId(msg.id, msg.terminalId);
            pendingResize.set(sessId, { cols: msg.cols, rows: msg.rows });
            containFailure(
              ptySend({
                type: "resize",
                id: sessId,
                cols: msg.cols,
                rows: msg.rows,
              }),
              `resize ${msg.id}`,
            );
          }
          return;
        } catch {
          // not JSON - fall through to terminal input
        }
      }
      const sessId = termClients.get(ws);
      if (sessId) {
        containFailure(
          ptySend({ type: "input", id: sessId, data: Buffer.from(str, "utf8").toString("base64") }),
          "terminal input",
        );
      }
    },
    close(ws) {
      pushClients.delete(ws);
      const sessId = termClients.get(ws);
      if (sessId) containFailure(ptySend({ type: "unsubscribe", id: sessId }), "terminal unsubscribe");
      termClients.delete(ws);
    },
    drain(_ws) {
      // no-op
    },
  },
});

console.log(`works server on http://${HOST}:${PORT}${authRequired() ? " (access key required)" : " (no key — loopback only)"}`);
