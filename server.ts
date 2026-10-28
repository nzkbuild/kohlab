// works server: HTTP + WebSocket API over lib.ts

import { serve } from "bun";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Workspace } from "./types";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { brotliCompress, constants as zlibConstants, gzip as gzipCb } from "zlib";
import { chown, mkdir, open, readdir, readFile, realpath, stat, writeFile } from "fs/promises";
import { dirname } from "path";
import { basename, isAbsolute, join, relative, resolve } from "path";
import {
  createWorkspace,
  deleteWorkspace,
  getDiff,
  getWorkspace,
  listWorkspaces,
  restartWorkspace,
  continueWorkspace,
  cloneOrReuse,
  newProject,
  projectsDir,
  listBranches,
  validGitUrl,
  startWorkspace,
  stopWorkspace,
  commitWorkspace,
  mergeWorkspace,
  discardWorkspace,
  listVersions,
  restoreVersion,
  worktreePath,
  imagesDir,
  identityOf,
  spawnAgentSession,
  markStarted,
  WORKS_DIR,
  startWatcher,
  onWorkspaceDone,
  notifyWebhook,
  shareWorkspace,
  workspaceByShare,
  previewWorkspace,
  renameWorkspace,
  setModel,
  closeTerminal,
  workspaceByPreview,
  authRequired,
  authenticate,
  listUsers,
  addUser,
  removeUser,
  rotateOwnKey,
  ptyList,
  onDaemonState,
  SCHEMA_VERSION,
  extractKey,
  KEY_PROTOCOL,
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
  createPair,
  claimPair,
  PAIR_TTL_MS,
  setUserRole,
  canProvisionOsUsers,
  repoNameFromUrl,
  handleHook,
  setHookBase,
  getPrefs,
  setPrefs,
  mutateState,
  copyWorkspace,
  setShareLink,
  shareExpiry,
  turnOffShareLink,
  slugify,
} from "./lib";
import { findSub, notifyDone, notifyNeedsYou, sendPush, subscribe, unsubscribe, vapidKey } from "./push";
import { resolvePreviewFile, versionFile } from "./preview";
import { headPackage, treeIsEmpty } from "./versions";
import { BrowserError, browserAction, browserProblems, browserUrl, clearBrowserProblems, ensureBrowser, openVersion, pickElement, reopenHome, startUrlFor, touchBrowser } from "./browser";
import { appKind, detectDevCommand, devProxyPort, ensureDevServer, stopAllDevServers, stopDevServer } from "./devserver";
import { PICTURE_MAX_BYTES, mintPicture, pictureHtml } from "./picture";
import { codexLoginState, codexSignedIn, startCodexLogin, stopCodexLogin } from "./codex";
import { claudeSignedIn, getProviders, invalidateProvider, PROVIDER_IDS, redactCard, refreshProviders, testAccount } from "./providers";
import { ACP_AGENTS, isAcpAgent } from "./acp";
import { AccountError, accountView, addCustomModel, createLogin, createRouter, getAccount, listAccounts, remove as removeAccount, removeCustomModel, renameAccount, renameModel, setKey, signInState, startSignIn, stopSignIns, submitCode, testRouter } from "./accounts";
import { patchDefaults } from "./defaults";
import { cleanRules, describeRule } from "./policy";
import { ChatError, answer as answerChat, chatBranch, chatControl, chatGoBack, chatTurn, forgetAccount, forgetProbe, noteChat, restoreWaiting, send as sendChat, sessions as chatSessions, snapshot as chatSnapshot, switchSession, ownerPlanUsage, runInfo } from "./chat";

const PORT = Number(process.env.PORT ?? 7676);
/** Where to bind. `HOST=127.0.0.1` keeps it to this box; the default serves the
 *  tailnet or the LAN, which is why a keyless server there generates one. */
const HOST = process.env.HOST ?? "0.0.0.0";
const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
// Claude Code's hooks call back on the loopback address; a wildcard bind still answers there.
setHookBase(`http://${HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}`);

/** Reported by /api/health. Read once; the file does not change under a running server. */
const VERSION = (() => {
  try {
    return JSON.parse(require("fs").readFileSync(join(import.meta.dir, "package.json"), "utf8")).version as string;
  } catch {
    return "unknown";
  }
})();

// What `server.upgrade` binds to the socket (see the WebSocket branch of
// `handle` below) and what `socketHandlers.message` reads back from
// `ws.data`. A concrete type here (vs. `Server<any>`) is required for
// `data` to type-check on `upgrade()`: with `any`, bun-types' conditional
// overload resolves to the no-`data` branch instead of the `data`-required one.
// `browser` is set on a shared-browser stream socket: the workspace and the port of its Chrome.
type WSData = { auth: Awaited<ReturnType<typeof authenticate>>; canMutate: boolean; browser?: { id: string; port: number } };

/** Browser push subscribers (dashboard pages). */
const brotli = promisify(brotliCompress);
const gzip = promisify(gzipCb);
const pushClients = new Set<ServerWebSocket<WSData>>();

/**
 * Failed key attempts per address. A key is 24 random bytes, so guessing is
 * already hopeless: this is not the thing that saves you, it is what stops a
 * loop from filling the audit log and burning CPU. In memory on purpose: a
 * restart clears it, which is the right trade for a lock-out nobody can trip by
 * accident, and there is no shared store to keep it in.
 */
const authFailures = new Map<string, { count: number; until: number }>();
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_FAILURES = 20;

function authThrottle(address: string): number {
  const rec = authFailures.get(address);
  if (!rec) return 0;
  if (Date.now() > rec.until) {
    authFailures.delete(address);
    return 0;
  }
  return rec.count >= AUTH_MAX_FAILURES ? Math.ceil((rec.until - Date.now()) / 1000) : 0;
}

function recordAuthFailure(address: string): void {
  const now = Date.now();
  const rec = authFailures.get(address);
  if (!rec || now > rec.until) authFailures.set(address, { count: 1, until: now + AUTH_WINDOW_MS });
  else rec.count += 1;
  // Keep the map from growing without bound on a long-lived server.
  if (authFailures.size > 4096) {
    for (const [k, v] of authFailures) if (now > v.until) authFailures.delete(k);
  }
}

// completion → push to every open dashboard + fire webhook
onWorkspaceDone((ws) => {
  const msg = JSON.stringify({ type: "workspace.done", id: ws.id, task: ws.task, agent: ws.agent });
  for (const c of pushClients) {
    // `c.OPEN` does not exist on a Bun ServerWebSocket, so this comparison was
    // always false and the done-ping never reached a single client.
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  }
  containFailure(notifyWebhook(ws), "notify webhook");
  containFailure(notifyDone(ws), "web push");
});

/**
 * The daemon owns every PTY. When its socket closes, every live session is gone
 * (there is nothing to reconnect to) so the dashboard is told, loudly, instead
 * of continuing to show "running" for work that is no longer happening.
 */
// Kept as "the last time it went down", not cleared when it comes back: a
// health probe starts a fresh daemon, so a monitor would otherwise see nothing
// but green through an outage that killed every live session. The timestamp is
// what makes flapping visible.
let daemonDownAt: number | null = null;
onDaemonState((up) => {
  if (!up) daemonDownAt = Date.now();
  const msg = JSON.stringify({ type: "daemon", up });
  for (const c of pushClients) {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  }
  void audit("system", up ? "daemon.up" : "daemon.down", undefined, up ? undefined : "every live session ended with it");
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
restoreWaiting();



async function handleClone(req: Request, actorUserId?: string): Promise<Response> {
  try {
    const body = (await req.json()) as { url?: string; task?: string; agent?: string; branch?: string; payload?: string; chat?: boolean; limits?: { timeoutSec?: number; maxMemoryMb?: number; maxProcs?: number } };
    const chat = body.chat === true;
    const url = (body.url ?? "").trim();
    const typed = (body.task ?? "").trim();
    if (!url) return json({ error: "url is required" }, 400);
    if (!validGitUrl(url)) return json({ error: "use an https://, ssh:// or git@ URL" }, 400);
    // A chat project needs no typed task: the repo name stands in as its title.
    const task = chat && !typed ? repoNameFromUrl(url) : (body.task ?? "work on " + url).trim();
    if (chat && task.length > 20000) return json({ error: "task is over 20000 characters" }, 400);
    const branch = body.branch?.trim() || undefined;
    if (actorUserId) {
      // a named member clones into their own isolated workspace (server does
      // the git work as root, then hands the tree to the member's OS user)
      const ws = await createWorkspace({ repo: "", url, task, agent: body.agent ?? "sh", inherit: body.agent === undefined, branch, payload: body.payload, limits: body.limits, ownerId: actorUserId, chat });
      if (chat && typed) await sendChat(ws.id, typed);
      return json(ws);
    }
    // owner/legacy path: one clone per URL under WORKS_DIR/clones, reused
    const dest = await cloneOrReuse(url);
    const ws = await createWorkspace({ repo: dest, task, agent: body.agent ?? "sh", inherit: body.agent === undefined, branch, payload: body.payload, limits: body.limits, chat });
    if (chat && typed) await sendChat(ws.id, typed);
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

/**
 * The AI's web preview. Unauthenticated by design: the unguessable token in the
 * path is the credential, the same as a share link. The page gets an opaque origin
 * (sandbox without allow-same-origin), so its JavaScript cannot read Kohlab's
 * stored key or call the API as the user.
 */
async function handlePreview(token: string, rest: string, req: Request): Promise<Response> {
  const headers = {
    "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    // the sandboxed page has an opaque origin: its module scripts are fetched in CORS mode and need this. The token in the path is the credential; no cookies exist here.
    "access-control-allow-origin": "*",
  };
  const notFound = (html: string) => new Response(html, { status: 404, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  const hit = await workspaceByPreview(token);
  if (!hit) return notFound("<!doctype html><title>Not found</title><p>This preview link is not valid.</p>");
  const { ws, share } = hit;
  if (share) return sharedPreview(ws, token, rest, req, headers);
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
  // An earlier version: the owner's own address only, and only a commit in this project's history.
  const version = /^v\/([0-9a-f]{40})(?:\/(.*))?$/.exec(rest);
  if (version) {
    const known = (await listVersions(ws.id)).some((v) => v.id === version[1]);
    if (!known) return notFound("<!doctype html><title>Not found</title><p>This version is not in the history.</p>");
    const dirTo = new URL(req.url).pathname + "/";
    if (version[2] === undefined) return new Response(null, { status: 301, headers: { ...headers, location: dirTo } });
    const got = await versionFile(worktreePath(ws), version[1], version[2]);
    if (got === "redirect") return new Response(null, { status: 301, headers: { ...headers, location: dirTo } });
    if (!got) return new Response("Not found", { status: 404, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
    return new Response(req.method === "HEAD" ? null : got.bytes, { headers: { ...headers, "content-type": Bun.file(got.name).type } });
  }
  const file = await resolvePreviewFile(worktreePath(ws), rest);
  if (!file) {
    if (rest === "" || rest.endsWith("/")) {
      return notFound('<!doctype html><meta charset="utf-8"><title>Nothing to preview yet</title><p style="font-family:sans-serif;padding:2rem">Nothing to preview yet. Ask Claude to build a web page, then press Preview again.</p>');
    }
    return new Response("Not found", { status: 404, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response(req.method === "HEAD" ? null : Bun.file(file), { headers });
}

/**
 * A share link's page. A project with no dev command is served as its files, as the owner's preview is.
 * A Vite app runs its dev server under the link (see devserver.ts) and this proxies to that one port only.
 * Anything else says it is not ready yet: a link never runs a command the owner did not get to see work.
 */
async function sharedPreview(ws: Workspace, token: string, rest: string, req: Request, headers: Record<string, string>): Promise<Response> {
  const page = (msg: string, status: number) =>
    new Response(`<!doctype html><meta charset="utf-8"><title>${msg}</title><p style="font-family:sans-serif;padding:2rem">${msg}</p>`, {
      status,
      headers: { ...headers, "content-type": "text/html; charset=utf-8" },
    });
  const pkg = await readFile(join(worktreePath(ws), "package.json"), "utf8").then(JSON.parse, () => null);
  const kind = appKind(pkg);
  if (kind === "unsupported") return page("Links for this kind of app aren't ready yet.", 404);
  if (kind === "static") {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
    const file = await resolvePreviewFile(worktreePath(ws), rest);
    if (!file) return new Response("Not found", { status: 404, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
    return new Response(req.method === "HEAD" ? null : Bun.file(file), { headers });
  }
  let port = devProxyPort(ws);
  if (port === null) {
    await ensureDevServer(ws);
    port = devProxyPort(ws);
  }
  if (port === null) return page("This app isn't running right now.", 503);
  return proxyApp(port, token, rest, req, headers);
}

const PROXY_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
/** The only request headers the app gets: never a cookie, an authorization header, Kohlab's own headers or a websocket key. */
const PROXY_REQUEST_HEADERS = ["accept", "accept-language", "content-type", "if-none-match", "if-modified-since", "range"];
/** Response headers the app may not set on the link: cookies, its own policy, and framing that would fight ours. */
const PROXY_DROP_RESPONSE = ["set-cookie", "content-encoding", "content-length", "transfer-encoding", "connection", "content-security-policy", "location"];
const PROXY_MAX_REQUEST = 1024 * 1024;
const PROXY_MAX_RESPONSE = 20 * 1024 * 1024;

/** A segment that would climb out of the app's base path (".", ".." or their encodings). */
function dotSegment(s: string): boolean {
  try {
    const d = decodeURIComponent(s);
    return d === "." || d === "..";
  } catch {
    return true;
  }
}

/** The request body up to `max` bytes, or null when it is bigger. Counted as it arrives, so a chunked body cannot slip past. */
async function readBodyCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The body, ending with an error once it is more than `max` bytes (the app is cut off, not trusted). */
function capBody(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > max) controller.error(new Error("response too big"));
        else controller.enqueue(chunk);
      },
    }),
  );
}

/** Forward one request to the share link's dev server on 127.0.0.1:<port>, under its base path. No redirects followed, 30 s at most. */
async function proxyApp(port: number, token: string, rest: string, req: Request, headers: Record<string, string>): Promise<Response> {
  if (!PROXY_METHODS.includes(req.method)) return new Response("method not allowed", { status: 405, headers: { ...headers, allow: PROXY_METHODS.join(", ") } });
  if (rest.split("/").some(dotSegment)) return new Response("Not found", { status: 404, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
  let body: Uint8Array | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const got = await readBodyCapped(req, PROXY_MAX_REQUEST);
    if (got === null) return new Response("Too big", { status: 413, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
    body = got;
  }
  const up = new Headers();
  for (const h of PROXY_REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v !== null) up.set(h, v);
  }
  const origin = `http://127.0.0.1:${port}`;
  let res: Response;
  try {
    res = await fetch(`${origin}/p/${token}/${rest}${new URL(req.url).search}`, {
      method: req.method,
      headers: up,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return new Response("The app didn't answer.", { status: 502, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
  }
  const out = new Headers();
  res.headers.forEach((v, k) => {
    if (!PROXY_DROP_RESPONSE.includes(k.toLowerCase())) out.set(k, v);
  });
  // a redirect within the app stays on the link; one to anywhere else is not passed on
  const loc = res.headers.get("location");
  if (loc?.startsWith(origin)) out.set("location", loc.slice(origin.length));
  if (Number(res.headers.get("content-length") ?? 0) > PROXY_MAX_RESPONSE) return new Response("The app's answer is too big.", { status: 502, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
  for (const [k, v] of Object.entries(headers)) out.set(k, v);
  // module scripts are fetched in CORS mode, and the sandboxed page's origin is opaque: without this they never load
  out.set("access-control-allow-origin", "*");
  const noBody = req.method === "HEAD" || res.status === 204 || res.status === 205 || res.status === 304;
  return new Response(noBody || !res.body ? null : capBody(res.body, PROXY_MAX_RESPONSE), { status: res.status, statusText: res.statusText, headers: out });
}

/** A picture's page: its own sandbox CSP, so the page runs as an opaque origin and not under the app's policy. */
const PICTURE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'",
};

/** POST a picture's page. The caller has already passed the workspace checks; this only keeps the page and returns its URL. */
async function handlePicturePost(req: Request): Promise<Response> {
  // Counted as it arrives, so a body with no Content-Length cannot slip past the cap.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = req.body?.getReader();
  for (let r = await reader?.read(); r && !r.done; r = await reader?.read()) {
    total += r.value.byteLength;
    if (total > PICTURE_MAX_BYTES) {
      await reader?.cancel();
      return json({ error: "picture is too big" }, 413);
    }
    chunks.push(r.value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let body: { html?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  if (typeof body?.html !== "string") return json({ error: "html must be a string" }, 400);
  return json({ url: `/pic/${mintPicture(body.html)}` });
}

async function handleRename(id: string, req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { title?: unknown };
    return json(await renameWorkspace(id, body.title));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

async function handleModel(id: string, req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as { model?: unknown };
    return json(await setModel(id, body.model));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

async function handlePreviewCreate(id: string, fresh: boolean): Promise<Response> {
  try {
    return json(await previewWorkspace(id, fresh));
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

/** A Claude project's earlier conversations, for the Conversations menu. */
async function handleChatSessions(id: string): Promise<Response> {
  try {
    return json(await chatSessions(id));
  } catch (e) {
    return json({ error: (e as Error).message }, e instanceof ChatError ? e.status : 400);
  }
}

/** One message's changes, for "What this changed". */
async function handleChatTurn(id: string, req: Request): Promise<Response> {
  try {
    return json(await chatTurn(id, Number(new URL(req.url).searchParams.get("n"))));
  } catch (e) {
    return json({ error: (e as Error).message }, e instanceof ChatError ? e.status : 400);
  }
}

/** Chat workspaces: the task is the first chat message, sent once the workspace exists. */
async function handleChatGet(id: string, req: Request, see: { usage: boolean; owner: boolean }): Promise<Response> {
  try {
    const after = Math.max(0, Number(new URL(req.url).searchParams.get("after")) || 0);
    return json(await chatSnapshot(id, after, see));
  } catch (e) {
    return json({ error: (e as Error).message }, e instanceof ChatError ? e.status : 400);
  }
}

async function handleChatRun(id: string): Promise<Response> {
  try {
    return json(await runInfo(id));
  } catch (e) {
    return json({ error: (e as Error).message }, e instanceof ChatError ? e.status : 400);
  }
}

async function handleChatPost(id: string, req: Request, actor: string, sub: string | undefined, isOwner = false): Promise<Response> {
  try {
    const body = (await req.json()) as { text?: unknown; requestId?: unknown; allow?: unknown; action?: unknown; value?: unknown; sid?: unknown; answers?: unknown; message?: unknown; n?: unknown; always?: unknown; with?: unknown };
    // a control action may answer with data (the files, the undo list): it is sent back as it is
    let reply: Record<string, unknown> = { ok: true };
    if (sub === "/answer") {
      if (typeof body.requestId !== "string" || typeof body.allow !== "boolean") return json({ error: "requestId and allow are required" }, 400);
      const answers = body.answers as Record<string, string> | undefined;
      if (answers !== undefined && (typeof answers !== "object" || answers === null || Array.isArray(answers) || !Object.values(answers).every((v) => typeof v === "string")))
        return json({ error: "answers must be text for each question" }, 400);
      if (body.message !== undefined && typeof body.message !== "string") return json({ error: "message must be text" }, 400);
      if (body.always !== undefined && typeof body.always !== "boolean") return json({ error: "always must be true or false" }, 400);
      containFailure(audit(actor, "chat.answer", id), "audit");
      const saved = await answerChat(id, body.requestId, body.allow, { answers, message: body.message as string | undefined, always: body.always === true });
      if (saved.rule) containFailure(audit(actor, "ai.rule.add", id, saved.rule), "audit");
    } else if (sub === "/control") {
      containFailure(audit(actor, body.action === "fresh" ? "chat.fresh" : "chat.control", id), "audit");
      reply = await chatControl(id, body.action, body.value, { owner: isOwner, actor });
    } else if (sub === "/session") {
      containFailure(audit(actor, "chat.session", id), "audit");
      await switchSession(id, body.sid);
    } else if (sub === "/goback") {
      containFailure(audit(actor, "chat.goback", id), "audit");
      await chatGoBack(id, body.n);
    } else if (sub === "/branch") {
      containFailure(audit(actor, "chat.branch", id), "audit");
      await chatBranch(id, body.n);
    } else {
      // Send with…: one message goes to another model; nothing about the project changes
      const withModel = (body.with as { model?: unknown } | undefined)?.model;
      if (body.with !== undefined && (typeof body.with !== "object" || body.with === null || typeof withModel !== "string")) return json({ error: "with must name a model" }, 400);
      containFailure(audit(actor, "chat", id), "audit");
      await sendChat(id, typeof body.text === "string" ? body.text : "", typeof withModel === "string" ? { model: withModel } : {});
    }
    return json(reply);
  } catch (e) {
    return json({ error: (e as Error).message }, e instanceof ChatError ? e.status : 400);
  }
}

async function handleCreate(req: Request, actorUserId?: string): Promise<Response> {
  const body = (await req.json()) as {
    repo?: string;
    task?: string;
    agent?: string;
    branch?: string;
    payload?: string;
    /** Start a brand-new repository with this name instead of an existing one. */
    newProject?: string;
    /** Folder the new project is created in; defaults to kohlab's projects folder. */
    location?: string;
    limits?: { timeoutSec?: number; maxMemoryMb?: number; maxProcs?: number };
    /** Talk through the claude chat mode (chat.ts) instead of a terminal. */
    chat?: boolean;
  };
  const typed = (body.task ?? "").trim();
  const chat = body.chat === true;
  // A chat project needs no typed task: the project name stands in as its title.
  if (!typed && !chat) return json({ error: "task is required" }, 400);
  if (chat && typed.length > 20000) return json({ error: "task is over 20000 characters" }, 400);
  if (body.newProject !== undefined) {
    // A new project is a host path; members work from URLs only.
    if (actorUserId) return json({ error: "members start from a git URL" }, 403);
    try {
      const name = (body.newProject ?? "").trim();
      const repo = await newProject(body.newProject, body.location);
      const ws = await createWorkspace({ repo, task: typed || name, agent: body.agent ?? "sh", inherit: body.agent === undefined, payload: body.payload, limits: body.limits, chat });
      if (chat && typed) await sendChat(ws.id, typed);
      return json(ws);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }
  // `cwd()` was never imported here, so creating a workspace without an
  // explicit repo threw ReferenceError and killed the server.
  const repo = (body.repo ?? process.cwd()).trim();
  // handleClone rejects anything but https://, ssh:// and git@ via
  // validGitUrl; this matched any `scheme://` instead, so a member's
  // repo:"file:///..." passed as a "URL" and reached `git clone` as root
  // against any local path root's git can read.
  const url = /^[a-z]+:\/\//.test(repo) && validGitUrl(repo) ? repo : undefined;
  // A named member may only create from a git URL: a host repo path would run
  // the agent in the legacy root-owned flow (privilege escalation) or reach
  // outside the member's home. Owners/anonymous keep the host-path flow.
  if (actorUserId && !url) return json({ error: "members create workspaces from a git URL" }, 403);
  // Chat projects with no typed task are titled by their repo: the URL's name, or the folder's.
  const task = typed || (url ? repoNameFromUrl(url) : basename(repo));
  try {
    const ws = await createWorkspace({
      repo,
      url,
      task,
      agent: body.agent ?? "sh", inherit: body.agent === undefined,
      branch: body.branch?.trim() || undefined,
      payload: body.payload,
      limits: body.limits,
      ownerId: actorUserId,
      chat,
    });
    if (chat && typed) await sendChat(ws.id, typed);
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
    if ((await getWorkspace(id)).chat) noteChat(id, "Kept this version");
    return json(res);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

/** "Download project": the last kept version as a zip. git archive reads HEAD, so uncommitted changes are left out. */
async function handleDownload(id: string): Promise<Response> {
  try {
    const ws = await getWorkspace(id);
    const proc = Bun.spawn(["git", "-c", "safe.directory=*", "archive", "--format=zip", "HEAD"], { cwd: worktreePath(ws), stdout: "pipe", stderr: "ignore" });
    const zip = await new Response(proc.stdout).arrayBuffer();
    if ((await proc.exited) !== 0) throw new Error("no kept version");
    return new Response(zip, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${slugify(ws.task)}.zip"` } });
  } catch {
    return json({ error: "There is no kept version to download yet. Keep this version first." }, 409);
  }
}

/** The project's standing notes for the AI. Trimmed; empty clears them. A running chat picks them up at its next message. */
async function handleNotes(id: string, req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const body = (await req.json().catch(() => ({}))) as { notes?: unknown };
    if (typeof body.notes !== "string") return json({ error: "notes must be text" }, 400);
    const notes = body.notes.trim();
    if (notes.length > 4000) return json({ error: "notes are over 4000 characters" }, 400);
    await mutateState((s) => {
      const w = s.workspaces.find((x) => x.id === id);
      if (!w) throw new Error(`no workspace '${id}'`);
      if (notes) w.notes = notes;
      else delete w.notes;
    });
    return json({ ok: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

/** The last mile: merge the accepted branch into the workspace's own repo.
 *  `into` is deliberately NOT accepted from the web: mergeWorkspace runs as the
 *  server user (root on a normal install), so a member-supplied path would let
 *  one member merge into another member's checkout (the v1.8 threat). The merge
 *  target is always the workspace's own repo; CLI keeps --into (runs as you).
 *  URL-created (isolated member) workspaces have no local checkout (ws.repo is
 *  "") so the route refuses them with the CLI path, which runs as the member. */
async function handleMerge(id: string, req: Request, actor: string): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as { message?: string; into?: unknown };
    if (body.into !== undefined) {
      return json({ error: "into is not accepted here, the merge target is always the workspace's own checkout" }, 400);
    }
    const ws = await getWorkspace(id);
    if (!ws.repo) {
      return json({ error: `workspace '${id}' was created from a URL and has no local checkout here. Merge it yourself: kohlab merge ${id} --into <your checkout>` }, 400);
    }
    const res = await mergeWorkspace(id, { message: body.message, actor });
    return json(res);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}
async function handleDiscard(id: string): Promise<Response> {
  try {
    const res = await discardWorkspace(id);
    if ((await getWorkspace(id)).chat) noteChat(id, "Undid the changes since the last keep");
    return json(res);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

async function handleVersions(id: string): Promise<Response> {
  try {
    // look = the project has no dev command at HEAD: an earlier version can then be shown as its files
    const look = !detectDevCommand(await headPackage(worktreePath(await getWorkspace(id))));
    const list = await listVersions(id);
    // ponytail: only the oldest entry is checked (the empty first commit); any other empty version would still say Look.
    const tree = worktreePath(await getWorkspace(id));
    const firstEmpty = list.length > 0 && (await treeIsEmpty(tree, list[list.length - 1].id));
    return json(list.map((v, i) => ({ ...v, look: look && !(firstEmpty && i === list.length - 1) })));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

/** The problems the chat and preview ask the AI to fix. GET reads (with a key for "Not now"); POST clears. */
async function handleProblems(id: string, req: Request): Promise<Response> {
  try {
    const ws = await getWorkspace(id);
    if (req.method === "GET") {
      const problems = await browserProblems(ws);
      return json({ problems, key: new Bun.CryptoHasher("sha256").update(JSON.stringify(problems)).digest("hex") });
    }
    const body = (await req.json().catch(() => ({}))) as { action?: unknown };
    if (body.action !== "clear") return json({ error: "action must be clear" }, 400);
    await clearBrowserProblems(ws);
    return json({ ok: true });
  } catch (e) {
    return json({ error: (e as Error).message }, e instanceof BrowserError ? e.status : 503);
  }
}

/** A copy of the project: its committed history, settings and notes. Answers like a new workspace. */
async function handleCopy(id: string, req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as { name?: unknown };
    const ws = await copyWorkspace(id, body.name);
    return json({ ...ws, running: false, path: worktreePath(ws) });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

/** The share link as the owner sees it: its address while it works, and what kind of app it serves. */
async function linkInfo(ws: Workspace) {
  const live = ws.shareLink && (ws.shareLink.expires === null || ws.shareLink.expires > Date.now()) ? ws.shareLink : null;
  const kind = appKind(await readFile(join(worktreePath(ws), "package.json"), "utf8").then(JSON.parse, () => null));
  // a relative address: the page that shows it knows its own origin
  return { url: live ? `/p/${live.token}/` : null, expires: live ? live.expires : null, kind };
}

/** GET, POST (make or change the link) and DELETE (turn it off). A dev server is restarted when the link's token changes. */
async function handleLink(id: string, req: Request, actor: string): Promise<Response> {
  try {
    if (req.method === "GET") return json(await linkInfo(await getWorkspace(id)));
    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { expires?: unknown; fresh?: unknown };
      const expires = shareExpiry(body.expires);
      if (expires === undefined) return json({ error: "expires must be 1d, 7d or never" }, 400);
      containFailure(audit(actor, "link", id), "audit");
      const { ws, rotated } = await setShareLink(id, expires, body.fresh === true);
      if (rotated) {
        stopDevServer(ws);
        await reopenHome(ws);
      }
      return json(await linkInfo(ws));
    }
    if (req.method === "DELETE") {
      containFailure(audit(actor, "link.off", id), "audit");
      const ws = await turnOffShareLink(id);
      stopDevServer(ws);
      await reopenHome(ws);
      return json({ ok: true, previewUrl: `/p/${ws.previewToken}/` });
    }
    return json({ error: "method not allowed" }, 405);
  } catch (e) {
    return json({ error: (e as Error).message }, e instanceof BrowserError ? e.status : 400);
  }
}

async function handleRestore(id: string, req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as { version?: unknown };
    if (typeof body.version !== "string" || !body.version) return json({ error: "version is required" }, 400);
    return json(await restoreVersion(id, body.version));
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

type Auth = Awaited<ReturnType<typeof authenticate>>;

/** The account whose preferences a caller reads and writes. */
function accountIdOf(auth: NonNullable<Auth>): string {
  if (auth.kind === "anonymous") return "anonymous";
  if (auth.kind === "legacy") return "owner";
  return auth.kind === "share" ? "shared link" : auth.id;
}

/** Mint a pairing code. Owner action: it can hand out the real key. */
async function handlePairCreate(): Promise<Response> {
  return json({ code: await createPair(), ttlMs: PAIR_TTL_MS });
}

/**
 * Trade a typed code for the key. Unauthenticated by definition — the code IS
 * the credential, like /api/join's token. Same silence as the gate's key error:
 * wrong, expired, spent, and throttled all read as one failure, so nothing
 * helps a guesser narrow the search.
 */
async function handlePairClaim(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { code?: string };
  const code = typeof body.code === "string" ? body.code : "";
  if (!code) return json({ error: "that code was not accepted" }, 400);
  const key = await claimPair(code);
  if (!key) return json({ error: "that code was not accepted" }, 400);
  return json({ key });
}

/** Rotate the caller's own key. Owner, member and viewer alike. */
async function handleAccountKey(auth: Auth): Promise<Response> {
  if (!auth || auth.kind !== "user") {
    return json(
      {
        error:
          "this server authenticates with a single KOHLAB_KEY, which lives on the box - rotate it there: kohlab key rotate",
      },
      400,
    );
  }
  try {
    const { key } = await rotateOwnKey(auth.id);
    return json({ key });
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
  const names = ["omp", "hermes", "claude", "codex", "codex-acp", "opencode", "pi", "gemini"];
  const { execFile } = await import("child_process");
  const status: Record<string, boolean | null> = {};
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
  status.claudeSignedIn = status.claude ? await claudeSignedIn() : null;
  // Codex chats need the CLI (to sign in) and codex-acp (the server they talk to).
  status.codex = status.codex === true && status["codex-acp"] === true;
  status.codexSignedIn = status.codex ? await codexSignedIn() : null;
  return json(status);
}

/** Owner only: starts Codex's device-code sign-in and answers with the link and code to show. */
// ---- AI control: defaults, accounts, always-allowed actions (accounts.ts, defaults.ts) ----

/** Whether an AI can be started here. */
function agentInstalled(agent: string): boolean {
  return (agent === "claude" || isAcpAgent(agent)) && !!Bun.which(agent === "claude" ? "claude" : ACP_AGENTS[agent][0]);
}

/** An answer for something an AI-control route refused: the plain sentence, never more. */
function aiFailure(e: unknown): Response {
  if (e instanceof AccountError || e instanceof ChatError) return json({ error: e.message }, e.status);
  console.error("[ai]", (e as Error).message);
  return json({ error: "Something went wrong. Try again." }, 500);
}

async function handleAi(req: Request, path: string, c: { isOwner: boolean; actor: string; auth: Awaited<ReturnType<typeof authenticate>> }): Promise<Response> {
  const owner = (why: string): Response | null => (c.isOwner ? null : json({ error: `forbidden, only an owner can ${why}` }, 403));
  const read = async (): Promise<Record<string, unknown>> => {
    const b = await req.json().catch(() => ({}));
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  };
  try {
    if (path === "/api/ai/defaults") {
      if (req.method === "GET") return json({ defaults: (await loadState()).defaults ?? {} });
      if (req.method !== "PUT") return json({ error: "method not allowed" }, 405);
      const refused = owner("change the defaults");
      if (refused) return refused;
      const body = await req.json().catch(() => null);
      const done = await mutateState((s) => {
        const got = patchDefaults(s.defaults, body, { installed: agentInstalled, accountOk: (id, agent) => !!getAccount(id) && (!agent || getAccount(id)!.provider === agent), owner: c.isOwner });
        if ("defaults" in got) s.defaults = got.defaults;
        return got;
      });
      if ("error" in done) return json({ error: done.error }, done.status);
      containFailure(audit(c.actor, "ai.defaults", undefined, Object.keys(body as object).join(",")), "audit");
      return json({ defaults: done.defaults });
    }

    if (path === "/api/ai/rules") {
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
      const projects: { id: string; name: string; rules: { rule: string; label: string; source: "kohlab"; removable: true }[] }[] = [];
      for (const w of await listWorkspaces()) {
        const rules = cleanRules(w.allowRules);
        if (!rules.length || !(await mayAccessWorkspace(c.auth, w.id))) continue;
        projects.push({ id: w.id, name: w.task, rules: rules.map((rule) => ({ rule, label: describeRule(rule), source: "kohlab" as const, removable: true as const })) });
      }
      return json({ projects });
    }

    if (path === "/api/ai/accounts") {
      if (req.method === "GET") return json({ accounts: listAccounts().map((a) => accountView(a, c.isOwner)) });
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      const refused = owner("add accounts");
      if (refused) return refused;
      const b = await read();
      if (b.kind === "router") {
        if (b.provider !== "claude") return json({ error: "Only Claude can use a router." }, 400);
        const a = createRouter(b.label, b.baseUrl, b.key);
        containFailure(audit(c.actor, "ai.account.add", a.id, a.label), "audit");
        const got = await testRouter(a.id);
        invalidateProvider("claude");
        return json({ account: accountView(getAccount(a.id)!, true), check: got.check, models: got.models.length });
      }
      if (b.kind !== "login") return json({ error: "Choose a sign-in or a router." }, 400);
      const a = createLogin(b.provider, b.label);
      containFailure(audit(c.actor, "ai.account.add", a.id, a.label), "audit");
      invalidateProvider(a.provider);
      return json({ account: accountView(a, true) });
    }

    const m = path.match(/^\/api\/ai\/accounts\/([a-z0-9-]+|default)(\/key|\/test|\/signin|\/signin\/code|\/models)?$/);
    if (!m) return json({ error: "not found" }, 404);
    const [, id, sub] = m;
    const acct = id === "default" ? undefined : getAccount(id);
    if (sub === "/models") {
      const refused = owner("change models");
      if (refused) return refused;
      const b = await read();
      const provider = acct ? acct.provider : b.provider === "codex" ? "codex" : "claude";
      if (id !== "default" && !acct) return json({ error: "That account does not exist." }, 404);
      if (req.method === "POST") addCustomModel(provider, id, b.value, b.label);
      else if (req.method === "PATCH") renameModel(provider, id, b.value, b.label);
      else if (req.method === "DELETE") removeCustomModel(provider, id, b.value);
      else return json({ error: "method not allowed" }, 405);
      containFailure(audit(c.actor, "ai.account.models", id, acct?.label), "audit");
      invalidateProvider(provider);
      return json({ ok: true });
    }
    if (!acct) return json({ error: "That account does not exist." }, 404);
    if (!sub && req.method === "PATCH") {
      const refused = owner("rename accounts");
      if (refused) return refused;
      const renamed = renameAccount(id, (await read()).label);
      containFailure(audit(c.actor, "ai.account.rename", id, renamed.label), "audit");
      invalidateProvider(acct.provider);
      return json({ account: accountView(renamed, true) });
    }
    if (!sub && req.method === "DELETE") {
      const refused = owner("remove accounts");
      if (refused) return refused;
      removeAccount(id);
      forgetProbe(id);
      await forgetAccount(id, acct.label);
      containFailure(audit(c.actor, "ai.account.remove", id, acct.label), "audit");
      invalidateProvider(acct.provider);
      return json({ ok: true });
    }
    if (sub === "/key" && req.method === "POST") {
      const refused = owner("replace keys");
      if (refused) return refused;
      setKey(id, (await read()).key);
      containFailure(audit(c.actor, "ai.account.key", id, acct.label), "audit");
      invalidateProvider(acct.provider);
      return json({ ok: true });
    }
    if (sub === "/test" && req.method === "POST") {
      const refused = owner("test accounts");
      if (refused) return refused;
      return json(await testAccount(id));
    }
    if (sub === "/signin" || sub === "/signin/code") {
      const refused = owner("sign accounts in");
      if (refused) return refused;
      if (acct.kind !== "login") return json({ error: "That account has no sign-in." }, 400);
      if (sub === "/signin/code") {
        if (req.method !== "POST" || acct.provider !== "claude") return json({ error: "method not allowed" }, 405);
        return json(submitCode(id, (await read()).code));
      }
      if (req.method === "GET") {
        if (acct.provider === "codex") {
          const st = codexLoginState(id);
          if (st.state === "done") invalidateProvider("codex");
          return json(st);
        }
        const st = signInState(id);
        if (st.state === "done") invalidateProvider("claude");
        return json(st);
      }
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      containFailure(audit(c.actor, "ai.account.signin", id, acct.label), "audit");
      if (acct.provider === "codex") {
        const got = await startCodexLogin(id);
        return json({ state: "waiting", url: got.url, code: got.code });
      }
      return json(await startSignIn(id));
    }
    return json({ error: "method not allowed" }, 405);
  } catch (e) {
    return aiFailure(e);
  }
}

async function handleCodexLoginStart(): Promise<Response> {
  return startCodexLogin().then(json, (e: Error) => json({ error: e.message }, 500));
}

/** A package name: `thing` or `@scope/thing`. Nothing else, no flags, no
 *  paths, no shell metacharacters, no URLs. */
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@latest)?$/i; // @latest is how an update is asked for

/**
 * Install an agent globally.
 *
 * The input is user-supplied text that becomes a process, so both halves are
 * load-bearing:
 *
 *  - **No shell.** This used to be `exec(cmd)`, i.e. `/bin/sh -c`, behind a
 *    `cmd.startsWith("npm i -g")` "whitelist". `npm i -g x; cp -r
 *    /home/koh-alice /tmp/loot` passed that check and ran as the server user,
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
    const abs = await insideTree(tree, rel, false);
    const buf = await readFile(abs, "utf8");
    return json({ path: rel, content: buf });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

/**
 * Resolve a path the browser sent against a workspace's tree, and refuse
 * anything that lands outside it. Symlinks are followed (realpath) so a link
 * inside the tree cannot point the server at /etc; for a path that does not
 * exist yet, its nearest existing parent is what gets checked. `.git` is never
 * writable from the browser.
 */
async function insideTree(tree: string, rel: string, forWrite: boolean): Promise<string> {
  const root = await realpath(tree);
  const abs = resolve(root, rel.replace(/^\/+/, ""));
  let probe = abs;
  for (;;) {
    try {
      probe = await realpath(probe);
      break;
    } catch {
      const up = dirname(probe);
      if (up === probe) throw new Error("invalid path");
      probe = up;
    }
  }
  const within = (p: string) => {
    const r = relative(root, p);
    return !r.startsWith("..") && !isAbsolute(r);
  };
  if (!within(probe) || !within(abs)) throw new Error("path is outside the workspace");
  if (forWrite && relative(root, abs).split(/[\\/]/)[0] === ".git") throw new Error("the .git folder is not editable here");
  return abs;
}

const MAX_FILE_UPLOAD_BYTES = 100 * 1024 * 1024;

/** A member's agent runs as their own OS user, so what the server writes is theirs. */
async function giveToOwner(ws: Workspace, ...paths: string[]) {
  const who = identityOf(ws);
  if (!who) return;
  for (const p of paths) await chown(p, who.uid, who.gid);
}

/** Download a file as bytes, or a folder as .tar.gz. */
async function handleRaw(id: string, req: Request): Promise<Response> {
  try {
    const ws = await getWorkspace(id);
    const rel = new URL(req.url).searchParams.get("path") ?? "";
    const abs = await insideTree(worktreePath(ws), rel, false);
    const info = await stat(abs);
    const name = (rel.split("/").filter(Boolean).pop() ?? ws.id).replace(/"/g, "");
    if (info.isDirectory()) {
      const proc = Bun.spawn(["tar", "-czf", "-", "--exclude=.git", "-C", abs, "."], {
        stdout: "pipe",
        stderr: "ignore",
      });
      return new Response(proc.stdout, {
        headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${name}.tar.gz"` },
      });
    }
    return new Response(Bun.file(abs), {
      headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"` },
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

/** Create a file or folder, or upload bytes into the tree (POST ?op=&path=). */
async function handleFs(id: string, req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const ws = await getWorkspace(id);
    const url = new URL(req.url);
    const op = url.searchParams.get("op");
    const rel = (url.searchParams.get("path") ?? "").trim();
    if (!rel) return json({ error: "path is required" }, 400);
    const abs = await insideTree(worktreePath(ws), rel, true);
    const parent = dirname(abs);
    if (op === "mkdir") {
      await mkdir(abs, { recursive: true });
      await giveToOwner(ws, abs);
      return json({ ok: true, path: rel });
    }
    if (op === "touch" || op === "upload") {
      const exists = await stat(abs).then(() => true, () => false);
      if (exists && url.searchParams.get("overwrite") !== "1") return json({ error: `${rel} already exists` }, 409);
      if (Number(req.headers.get("content-length") ?? 0) > MAX_FILE_UPLOAD_BYTES) return json({ error: "file exceeds 100 MiB" }, 413);
      const bytes = op === "upload" ? new Uint8Array(await req.arrayBuffer()) : new Uint8Array();
      if (bytes.length > MAX_FILE_UPLOAD_BYTES) return json({ error: "file exceeds 100 MiB" }, 413);
      await mkdir(parent, { recursive: true });
      await writeFile(abs, bytes);
      await giveToOwner(ws, abs);
      return json({ ok: true, path: rel, bytes: bytes.length });
    }
    return json({ error: "op must be mkdir, touch or upload" }, 400);
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

    // Images are named by their sniffed type. Any other file (a PDF, a log, a
    // CSV the agent should read) keeps a sanitised version of its own name, so
    // the path the agent sees still says what it is.
    const mimeType = sniffImageMime(bytes);
    const rawName = decodeURIComponent(req.headers.get("x-file-name") ?? "");
    const safeName = rawName.replace(/^.*[\\/]/, "").replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 80);
    if (!mimeType && !safeName) return json({ error: "unsupported image; use PNG, JPEG, GIF, or WebP" }, 415);

    const imageDir = imagesDir(workspace);
    await mkdir(imageDir, { recursive: true, mode: 0o700 });
    const stem = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const fileName = mimeType
      ? `${stem}.${mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length)}`
      : `${stem}-${safeName}`;
    const imagePath = join(imageDir, fileName);
    await Bun.write(imagePath, bytes);
    // A member's agent runs as their own OS user; a root-owned file in a 0700
    // root-owned folder would be unreadable to it.
    await giveToOwner(workspace, imageDir, imagePath);
    return json({ path: imagePath, mimeType: mimeType ?? "application/octet-stream", bytes: bytes.length });
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

/** The owner's plan usage (the Usage dialog). A failed read is a 503 with a plain sentence. */
async function handleUsage(): Promise<Response> {
  try {
    return json(await ownerPlanUsage());
  } catch (e) {
    console.warn("[usage]", (e as Error).message);
    return json({ error: "Couldn't read your plan usage right now." }, 503);
  }
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
 * restarts this server before the script is finished, so that file: and the
 * marker lines the script writes into it: is the only surviving record of how
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
const termClients = new Map<ServerWebSocket<WSData>, string>();

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
    // The daemon answers { type:"error", message }: e.g. "unknown session"
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
 * created asynchronously: so the first resize routinely arrives before the
 * session exists and would be dropped. The latest size is remembered here and
 * re-applied as soon as the attach finishes. Bounded by the number of open
 * terminals, which is bounded by the number of workspaces.
 */
const pendingResize = new Map<string, { cols: number; rows: number }>();

/** Attach a ws client to a workspace's named PTY session. */
function attachPty(ws: ServerWebSocket<WSData>, id: string, terminalId = "main") {
  const sessId = sessionId(id, terminalId);
  termClients.set(ws, sessId);
  containFailure(ptySend({ type: "subscribe", id: sessId, replay: true }), `subscribe ${id}`);
  ws.send("\x1b[2J\x1b[H");
}

/**
 * Run a fire-and-forget promise with its rejection contained.
 *
 * Every terminal/push operation below is fire-and-forget by design, but an
 * unhandled rejection on a socket callback exits the Bun process: one client
 * attaching twice would take the server down for everyone. Rejections here are
 * logged and dropped, never fatal.
 */
function containFailure(promise: Promise<unknown>, what: string): void {
  void promise.catch((error: unknown) => {
    console.error(`[kohlab] ${what} failed:`, error instanceof Error ? error.message : error);
  });
}

const MAX_HOOK_BYTES = 64 * 1024;

/** Read a request body up to `max` bytes, or null when it is bigger (chunked bodies have no length to check). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A Claude Code hook event (POST /api/hook/:id), from the hook settings
 * spawnAgentSession writes. Sits before the auth gate: the workspace's hook token
 * in x-kohlab-hook is the credential, and a bad id or token gets the same 404.
 */
async function handleHookPost(id: string, req: Request): Promise<Response> {
  const text = await readCapped(req, MAX_HOOK_BYTES);
  if (text === null) return json({ error: "hook body exceeds 64 KiB" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "hook body must be JSON" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "hook body must be a JSON object" }, 400);
  const result = await handleHook(id, req.headers.get("x-kohlab-hook") ?? "", body as Parameters<typeof handleHook>[2]);
  if (!result) return json({ error: "not found" }, 404);
  if (result.needsYou !== undefined) containFailure(notifyNeedsYou(result.ws, result.needsYou), `needs-you push ${id}`);
  return new Response(null, { status: 204 });
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
   * A workspace that has never run is still spawned here on purpose: creating a
   * workspace does not start it, and both the onboarding copy and the README
   * promise that opening it does. Only the ended case is blocked.
   */
  if (ws.stopped !== null && terminalId === "main") return;

  try {
    await spawnAgentSession(ws, terminalId);
    // First ever spawn is a real start: record it so the exit watcher can finish the run
    // (agents without hooks). Re-attaching to a live session must not touch `started`
    // (it moved the project to the top of the sidebar).
    if (terminalId === "main" && !ws.started) await markStarted(id);
  } catch (error) {
    // Re-attaching to a session that is already live is the normal case for a
    // browser reload or a second tab, not a failure. The daemon reports it as
    // an error ("session already exists: <id>", pty-daemon.cjs), and this is
    // our own daemon's message, so matching it here is an internal contract.
    if (!/session already exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
}

// --- server --------------------------------------------------------------
async function handle(req: Request, server: Server<WSData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = url.pathname;
    // Web preview: before the auth gate and the SPA fallback. Read-only.
    const previewM = path.match(/^\/p\/([A-Za-z0-9_-]+)\/(.*)$/);
    if (previewM) {
      return handlePreview(previewM[1], previewM[2], req);
    }
    // A picture drawn in chat: the random token is the credential, as with /p/. Before the auth gate.
    const picM = path.match(/^\/pic\/([A-Za-z0-9_-]+)$/);
    if (picM) {
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      const html = pictureHtml(picM[1]);
      if (html === null) return new Response("<!doctype html><title>Not found</title><p>This picture is no longer here. Ask Claude to draw it again.</p>", { status: 404, headers: PICTURE_HEADERS });
      return new Response(req.method === "HEAD" ? null : html, { headers: PICTURE_HEADERS });
    }
    // Claude Code hook callbacks: before the auth gate, the hook token is the credential.
    const hookM = path.match(/^\/api\/hook\/([^/]+)$/);
    if (hookM) {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
      return handleHookPost(hookM[1], req);
    }
    const m = path.match(/^\/api\/workspaces\/([^/]+)\/(start|stop|restart|continue|delete|diff|commit|merge|discard|files|file|raw|download|notes|fs|image|share|preview|rename|log|versions|restore|model|terminal|problems|copy|link)$/);
    const shareIdRes = m || url.searchParams.has("share") ? await shareId(req) : null;

    // resolve the actor once: named user / legacy key / share / anonymous / null(denied)
    // The terminal and done-ping sockets connect to `/`, not `/api`, so the
    // upgrade request must be authenticated too: otherwise `auth` is null,
    // `denied` is true, and every socket is rejected 401 the moment an access
    // key is configured.
    const isWebSocket = req.headers.get("upgrade")?.toLowerCase() === "websocket";
    const apiish = path.startsWith("/api") || isWebSocket;

    // Throttle the guessing, never the guessing's victim: the key is checked
    // first, and only a request that *presented* a key and was refused counts. A
    // browser with no key at all is the normal state before the gate screen, not
    // a guess. Checking first costs one HMAC per attempt, and it means a correct
    // key still works after twenty wrong ones from the same address: otherwise
    // anyone behind the same NAT could lock everyone else out.
    const address = server?.requestIP?.(req)?.address ?? "unknown";
    const presentedKey = !!extractKey({ headers: req.headers, url: req.url });
    const auth = apiish ? await authenticate(req) : null;
    if (apiish && presentedKey && !auth) {
      recordAuthFailure(address);
      const wait = authThrottle(address);
      if (wait > 0) {
        return json({ error: `too many failed key attempts, try again in ${wait}s` }, 429);
      }
    }

    const denied = !auth && authRequired();
    const actor = auth ? (auth.kind === "user" ? auth.id : auth.kind === "legacy" ? "legacy" : auth.kind === "share" ? "share" : "anonymous") : "anonymous";
    const role: string | null = auth && (auth.kind === "user" || auth.kind === "legacy") ? auth.role : null;
    const actorUserId = auth?.kind === "user" ? auth.id : undefined;
    const canMutate = !denied && ((role === "owner" || role === "member") || auth?.kind === "anonymous");
    const isOwner = !denied && (role === "owner" || auth?.kind === "anonymous");

    /**
     * One gate, so "refused" is structural instead of remembered.
     *
     * Ten routes used to answer 403 to a caller with no credentials at all,
     * because they tested the role before testing whether there was anyone to
     * have a role. Both refuse, so neither was a hole: but a client cannot tell
     * "you sent no key" from "your key is not enough", and that difference is the
     * whole reason 401 and 403 are separate. Adding a route now means wrapping it
     * in this, not remembering which check goes first.
     */
    const gate = (allowed: boolean, why = "forbidden"): Response | null =>
      denied ? json({ error: "unauthorized" }, 401) : allowed ? null : json({ error: why }, 403);

    // WebSocket upgrade: terminal proxy + push: require auth.
    if (isWebSocket) {
      if (denied) return json({ error: "unauthorized" }, 401);
      // Echo the protocol the client offered, or the browser fails the
      // handshake ("no response was received").
      const offered = (req.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((p) => p.trim())
        .find((p) => p === "kohlab" || p.startsWith(KEY_PROTOCOL));
      // Bind the identity resolved above to the socket: attach/resize/input
      // used to trust any id a frame named, with no link back to who
      // authenticated at the handshake. `auth`/`canMutate` travel in
      // `ws.data` so every later frame can be checked against the caller
      // that opened the connection, not just "some caller passed `denied`".
      // The shared browser's live stream. The port is bound to this socket here, so it can only reach its own workspace's browser.
      const streamM = path.match(/^\/browser\/([^/]+)$/);
      let browser: { id: string; port: number } | undefined;
      if (streamM) {
        const sid = streamM[1];
        if (auth?.kind === "share" || !(await mayAccessWorkspace(auth, sid))) return json({ error: "forbidden, not your workspace" }, 403);
        try {
          const sws = await getWorkspace(sid);
          browser = { id: sid, port: (await ensureBrowser(sws, await startUrlFor(sws))).port };
        } catch (e) {
          return json({ error: (e as Error).message }, e instanceof BrowserError ? e.status : 503);
        }
      }
      const upgradeOpts = { data: { auth, canMutate, browser }, ...(offered ? { headers: { "sec-websocket-protocol": offered } } : {}) };
      if (server.upgrade(req, upgradeOpts)) return undefined;
    }

    const chatM = path.match(/^\/api\/workspaces\/([^/]+)\/chat(\/answer|\/control|\/sessions|\/session|\/turn|\/goback|\/branch|\/run)?$/);
    if (chatM) {
      const [, chatId, sub] = chatM;
      if (auth?.kind === "share" || !(await mayAccessWorkspace(auth, chatId))) return json({ error: "forbidden, not your workspace" }, 403);
      if (req.method === "GET" && !sub) {
        if (denied) return json({ error: "unauthorized" }, 401);
        return handleChatGet(chatId, req, { usage: canMutate, owner: isOwner });
      }
      if (req.method === "GET" && sub === "/sessions") return handleChatSessions(chatId);
      if (req.method === "GET" && sub === "/turn") {
        if (denied) return json({ error: "unauthorized" }, 401);
        return handleChatTurn(chatId, req);
      }
      // What the AI was told and what it can use: names only. Read access, like viewing the chat.
      if (req.method === "GET" && sub === "/run") {
        if (shareIdRes) return json({ error: "forbidden, share links cannot see this" }, 403);
        if (denied) return json({ error: "unauthorized" }, 401);
        return handleChatRun(chatId);
      }
      if (req.method !== "POST" || sub === "/sessions" || sub === "/turn" || sub === "/run") return json({ error: "method not allowed" }, 405);
      const refused = gate(canMutate, "forbidden, viewer cannot chat");
      if (refused) return refused;
      return handleChatPost(chatId, req, actor, sub, isOwner);
    }

    // A picture for a chat frame (see picture.ts). Read access, like viewing the chat: no share links, no credentials, no entry.
    const picsM = path.match(/^\/api\/workspaces\/([^/]+)\/picture$/);
    if (picsM) {
      if (denied) return json({ error: "unauthorized" }, 401);
      if (auth?.kind === "share" || !(await mayAccessWorkspace(auth, picsM[1]))) return json({ error: "forbidden, not your workspace" }, 403);
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      return handlePicturePost(req);
    }

    // The shared browser (browser.ts): read its page URL, or navigate it. Share links never reach it.
    const browserM = path.match(/^\/api\/workspaces\/([^/]+)\/browser$/);
    if (browserM) {
      const bid = browserM[1];
      if (auth?.kind === "share" || !(await mayAccessWorkspace(auth, bid))) return json({ error: "forbidden, not your workspace" }, 403);
      if (req.method === "GET") {
        if (denied) return json({ error: "unauthorized" }, 401);
        try {
          const bws = await getWorkspace(bid);
          await ensureBrowser(bws, await startUrlFor(bws));
          return json({ url: await browserUrl(bws) });
        } catch (e) {
          return json({ error: (e as Error).message }, e instanceof BrowserError ? e.status : 503);
        }
      }
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      const refused = gate(canMutate, "forbidden, viewer cannot use the browser");
      if (refused) return refused;
      const body = (await req.json().catch(() => ({}))) as { action?: string; url?: string; width?: number; height?: number; x?: unknown; y?: unknown; version?: unknown };
      if (body.action !== "open" && body.action !== "home" && body.action !== "back" && body.action !== "forward" && body.action !== "reload" && body.action !== "viewport" && body.action !== "pick" && body.action !== "version") {
        return json({ error: "action must be open, home, back, forward, reload, viewport, pick or version" }, 400);
      }
      // A viewport resize fires on every drag, so it is not audited.
      if (body.action !== "viewport") containFailure(audit(actor, "browser." + body.action, bid), "audit");
      try {
        if (body.action === "pick") return json({ pick: await pickElement(await getWorkspace(bid), body.x, body.y) });
        if (body.action === "version") {
          if (typeof body.version !== "string" || !/^[0-9a-f]{40}$/.test(body.version)) return json({ error: "version must be a commit id" }, 400);
          return json({ url: await openVersion(await getWorkspace(bid), body.version) });
        }
        return json({ url: await browserAction(await getWorkspace(bid), body.action, body.url, { width: body.width as number, height: body.height as number }) });
      } catch (e) {
        return json({ error: (e as Error).message }, e instanceof BrowserError ? e.status : 503);
      }
    }

    if (m) {
      const [, id, action] = m;
      // a share link never reaches the owner's problems, copies or link settings
      if (auth?.kind === "share" && (action === "problems" || action === "copy" || action === "link")) return json({ error: "forbidden, a shared link cannot do this" }, 403);
      const shareReadOnly = action === "diff" || action === "files" || action === "file" || action === "raw" || action === "download" || action === "log";
      // share-token access to this workspace is read-only
      if (shareIdRes === id && shareReadOnly) {
        switch (action) {
          case "diff": return handleDiff(id);
          case "files": return handleFiles(id);
          case "file": return handleFile(id, req);
          case "raw": return handleRaw(id, req);
          case "download": return handleDownload(id);
          case "log": return handleLog(id);
        }
      }
      // v1.8 ownership: a named member/viewer may only touch their own
      // workspaces (share-token reads already returned above). Owners and
      // the legacy/anonymous single-user flows pass through.
      const readOnly = action === "diff" || action === "files" || action === "file" || action === "raw" || action === "download" || action === "log" || action === "versions" || (action === "problems" && req.method === "GET");
      if (!(await mayAccessWorkspace(auth, id))) {
        return json({ error: "forbidden, not your workspace" }, 403);
      }
      if (readOnly) {
        if (denied) return json({ error: "unauthorized" }, 401);
      } else {
        const refused = gate(canMutate, "forbidden, viewer cannot " + action);
        if (refused) return refused;
      }
      switch (action) {
        case "start": containFailure(audit(actor, "start", id), "audit"); return handleStart(id);
        case "stop": containFailure(audit(actor, "stop", id), "audit"); return handleStop(id);
        case "restart": containFailure(audit(actor, "restart", id), "audit"); return handleRestart(id);
        case "continue": {
          if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
          containFailure(audit(actor, "continue", id), "audit");
          try {
            const body = (await req.json()) as { task?: string; payload?: string };
            return json(await continueWorkspace(id, body.task ?? "", body.payload));
          } catch (e) {
            return json({ error: (e as Error).message }, 400);
          }
        }
        case "delete": containFailure(audit(actor, "delete", id), "audit"); return handleDelete(id);
        case "commit": containFailure(audit(actor, "commit", id), "audit"); return handleCommit(id, req);
        case "merge": return handleMerge(id, req, actor);
        case "discard": containFailure(audit(actor, "discard", id), "audit"); return handleDiscard(id);
        case "diff": return handleDiff(id);
        case "files": return handleFiles(id);
        case "file": return handleFile(id, req);
        case "raw": return handleRaw(id, req);
        case "download": return handleDownload(id);
        case "notes": containFailure(audit(actor, "notes", id), "audit"); return handleNotes(id, req);
        case "fs": containFailure(audit(actor, "fs", id, new URL(req.url).searchParams.get("op") ?? undefined), "audit"); return handleFs(id, req);
        case "log": return handleLog(id);
        case "image":
          if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
          containFailure(audit(actor, "image", id), "audit");
          return handleImageUpload(id, req);
        case "share": containFailure(audit(actor, "share", id), "audit"); return handleShare(id);
        case "preview": {
          const fresh = url.searchParams.get("new") === "1";
          containFailure(audit(actor, fresh ? "preview.new" : "preview", id), "audit");
          return handlePreviewCreate(id, fresh);
        }
        case "versions": return handleVersions(id);
        case "problems":
          if (req.method !== "GET") containFailure(audit(actor, "problems.clear", id), "audit");
          return handleProblems(id, req);
        case "copy": containFailure(audit(actor, "copy", id), "audit"); return handleCopy(id, req);
        case "link": return handleLink(id, req, actor);
        case "restore":
          if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
          containFailure(audit(actor, "restore", id), "audit");
          return handleRestore(id, req);
        case "rename": containFailure(audit(actor, "rename", id), "audit"); return handleRename(id, req);
        case "terminal": {
          if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
          try {
            const body = (await req.json().catch(() => ({}))) as { terminalId?: unknown };
            return json(await closeTerminal(id, body.terminalId));
          } catch (e) {
            return json({ error: (e as Error).message }, 400);
          }
        }
        case "model": containFailure(audit(actor, "model", id), "audit"); return handleModel(id, req);
      }
    }

    if (path === "/api/auth/required") {
      return json({ required: authRequired() });
    }
    /**
     * Health, for a monitor and for `kohlab doctor`.
     *
     * Unauthenticated callers get liveness only ("the process answers") with no
     * counts and no paths, because a probe usually runs without a key and a
     * health endpoint should not be a reconnaissance surface. With credentials it
     * reports the detail an operator wants at 3am.
     */
    // Web Push: this device asks to hear when an agent finishes. A share link is
    // read-only access to one workspace and never subscribes.
    if (path.startsWith("/api/push/")) {
      const refused = gate(auth?.kind !== "share");
      if (refused) return refused;
      if (path === "/api/push/key" && req.method === "GET") return json({ key: vapidKey().publicKey });
      if (req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
        if (typeof b.endpoint !== "string" || !/^https:\/\//.test(b.endpoint)) return json({ error: "endpoint must be an https URL" }, 400);
        if (path === "/api/push/subscribe") {
          if (!b.keys?.p256dh || !b.keys?.auth) return json({ error: "keys.p256dh and keys.auth are required" }, 400);
          subscribe({ endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth, userId: actorUserId ?? "", role });
          return json({ ok: true });
        }
        if (path === "/api/push/unsubscribe") {
          unsubscribe(b.endpoint);
          return json({ ok: true });
        }
        if (path === "/api/push/test") {
          const sub = findSub(b.endpoint);
          if (!sub) return json({ error: "this device is not subscribed" }, 404);
          try {
            await sendPush(sub, { title: "kohlab", body: "Push works on this device.", tag: "kohlab-test", url: "/" });
            return json({ ok: true });
          } catch (e) {
            return json({ error: (e as Error).message }, 502);
          }
        }
      }
    }
    if (path === "/api/health" && req.method === "GET") {
      const state = await loadState();
      // Without credentials, answer "the process is alive" and nothing else. No
      // probe, because probing here would start a daemon on behalf of a stranger,
      // and no counts, because that is reconnaissance.
      if (denied) return json({ ok: true });

      // With credentials, ask the daemon: the only thing that actually knows what
      // is running. `daemonAlive()` alone is not enough: it reports whether *this
      // process* has an open socket, which on a fresh server is false until
      // something touches a PTY. The probe establishes that, adopting a live
      // daemon or starting one, exactly as `kohlab health` does.
      const sessions = await ptyList();
      const up = sessions !== null;
      const ids = new Set(state.workspaces.map((w) => sessionId(w.id)));
      const running = (sessions ?? []).filter((s) => !s.exited && ids.has(s.id)).length;
      return json({
        ok: true,
        version: VERSION,
        schemaVersion: SCHEMA_VERSION,
        uptimeSec: Math.round(process.uptime()),
        daemon: up,
        daemonDownSince: up ? null : daemonDownAt,
        lastDaemonDeath: daemonDownAt,
        workspaces: { total: state.workspaces.length, running },
        dir: WORKS_DIR,
        keyRequired: authRequired(),
      });
    }
    if (path === "/api/account" && req.method === "GET") {
      if (!auth) return json({ error: "unauthorized" }, 401);
      if (auth.kind === "share") return json({ id: "shared link", role: "viewer", kind: "share" });
      if (auth.kind === "anonymous") return json({ id: "anonymous", role: "owner", kind: "anonymous", prefs: await getPrefs("anonymous") });
      if (auth.kind === "legacy") return json({ id: "owner", role: auth.role, kind: "legacy", prefs: await getPrefs("owner") });
      return json({ id: auth.id, role: auth.role, kind: "user", prefs: await getPrefs(auth.id) });
    }
    // Viewers may set their own preferences: it only changes their own view.
    if (path === "/api/account/prefs" && req.method === "POST") {
      if (!auth) return json({ error: "unauthorized" }, 401);
      if (auth.kind === "share") return json({ error: "a shared link cannot save preferences" }, 403);
      const body = (await req.json().catch(() => ({}))) as { powerTools?: unknown };
      if (typeof body.powerTools !== "boolean") return json({ error: "powerTools must be true or false" }, 400);
      return json(await setPrefs(accountIdOf(auth), { powerTools: body.powerTools }));
    }
    if (path === "/api/account/key" && req.method === "POST") {
      return handleAccountKey(auth);
    }
    if (path === "/api/users" && req.method === "GET") {
      const refused = gate(isOwner, "forbidden, only an owner can list members");
      if (refused) return refused;
      return handleUsersList();
    }
    if (path === "/api/users" && req.method === "POST") {
      // GET and DELETE next to this both require isOwner. This had no check at
      // all (not even `denied`) so any authenticated caller could POST
      // {role: "owner"} and mint themselves an owner key. A viewer escalating to
      // owner is the whole box, and it provisions an OS account while it does it.
      const refused = gate(isOwner, "forbidden, only an owner can add members");
      if (refused) return refused;
      return handleUserAdd(req);
    }
    // Inviting, and redeeming an invitation. `/api/join` is the one route that
    // must work without credentials: the token *is* the credential, it is
    // single-use and it expires. Inviting is an owner action.
    if (path === "/api/invites" && req.method === "POST") {
      const refused = gate(isOwner, "forbidden, only an owner can invite");
      if (refused) return refused;
      return handleInviteCreate(req, actor);
    }
    if (path === "/api/join" && req.method === "POST") {
      return handleJoin(req);
    }
    // Pairing: mint a short device-grant code (owner action), or trade one for
    // the key (no auth — the code is the credential, same as /api/join's token).
    if (path === "/api/pair" && req.method === "POST") {
      const refused = gate(isOwner, "forbidden, only an owner can create a pairing code");
      if (refused) return refused;
      containFailure(audit(actor, "pair.create"), "audit");
      return handlePairCreate();
    }
    if (path === "/api/pair/claim" && req.method === "POST") {
      return handlePairClaim(req);
    }
    if (path.match(/^\/api\/users\/[^/]+$/) && req.method === "PATCH") {
      const refused = gate(isOwner, "forbidden, only an owner can change roles");
      if (refused) return refused;
      const uid = decodeURIComponent(path.split("/").pop() ?? "");
      return handleUserRole(uid, req);
    }
    if (path.match(/^\/api\/users\/[^/]+$/) && req.method === "DELETE") {
      const refused = gate(isOwner, "forbidden, only an owner can remove members");
      if (refused) return refused;
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
      // the registry is global: a member who could add one could redefine
      // `claude` or `sh` and have it run under every other member's PTY, or
      // under root for owner/legacy workspaces. This is owner-only, not
      // merely mutate-only.
      if (req.method === "POST") {
        const refused = gate(isOwner, "forbidden, only an owner can add agents");
        if (refused) return refused;
        containFailure(audit(actor, "agent.add"), "audit");
      }
      return handleAgents(req);
    }
    if (path === "/api/agents/install" && req.method === "POST") {
      const refused = gate(canMutate, "forbidden, viewer cannot install agents");
      if (refused) return refused;
      containFailure(audit(actor, "agent.install"), "audit");
      return handleAgentInstall(req);
    }
    if (path === "/api/agents/codex/login" && (req.method === "POST" || req.method === "GET")) {
      // Signing in makes the server's Codex work for every chat, so it is an owner action.
      const refused = gate(isOwner, "forbidden, only an owner can sign in to Codex");
      if (refused) return refused;
      if (req.method === "GET") return json(codexLoginState());
      containFailure(audit(actor, "codex.login"), "audit");
      return handleCodexLoginStart();
    }
    if (path === "/api/agents-status") {
      if (denied) return json({ error: "unauthorized" }, 401);
      return handleAgentsStatus();
    }
    // AI control: the defaults for new projects, other accounts, always-allowed actions.
    if (path.startsWith("/api/ai/")) {
      if (auth?.kind === "share" || shareIdRes) return json({ error: "forbidden, share links cannot see this" }, 403);
      const refused = gate(true);
      if (refused) return refused;
      return handleAi(req, path, { isOwner, actor, auth });
    }
    // The AI hub: which AIs are ready, their models, and (owner only) account, plan and usage. Share links never see it.
    if (path === "/api/providers" && req.method === "GET") {
      if (auth?.kind === "share" || shareIdRes) return json({ error: "forbidden, share links cannot see this" }, 403);
      const refused = gate(true);
      if (refused) return refused;
      const got = await getProviders();
      return json(isOwner ? got : { ...got, providers: got.providers.map(redactCard) });
    }
    if (path === "/api/providers/refresh" && req.method === "POST") {
      const refused = gate(isOwner, "forbidden, only an owner can refresh providers");
      if (refused) return refused;
      const body = (await req.json().catch(() => ({}))) as { id?: unknown } | null;
      const pid = body?.id;
      if (pid !== undefined && (typeof pid !== "string" || !PROVIDER_IDS.includes(pid))) return json({ error: "unknown AI" }, 400);
      containFailure(audit(actor, "providers.refresh", undefined, pid as string | undefined), "audit");
      return json(await refreshProviders(pid as string | undefined));
    }
    // Plan usage is the owner's account data: no credentials is 401, a member or viewer is 403.
    if (path === "/api/usage" && req.method === "GET") {
      const refused = gate(isOwner, "forbidden, only an owner can see plan usage");
      if (refused) return refused;
      return handleUsage();
    }
    if (path === "/api/gh/repos") {
      if (denied) return json({ error: "unauthorized" }, 401);
      return handleGhRepos();
    }
    // OTA: what the pushed upstream publishes, and (owner only) apply it.
    if (path === "/api/release") {
      if (denied) return json({ error: "unauthorized" }, 401);
      const force = url.searchParams.get("force") === "1";
      return json({ ...(await checkRelease(undefined, { force })), ...(await updateRunState()) });
    }
    if (path === "/api/release/update" && req.method === "POST") {
      // Updating rewrites the checkout and restarts the service, so it is an
      // owner action, never a member/viewer one, and never a share token.
      // No credentials is 401; credentials without the role is 403.
      const refused = gate(isOwner, "forbidden, only an owner can update the server");
      if (refused) return refused;
      if ((await updateRunState()).running) return json({ error: "an update is already running" }, 409);
      containFailure(audit(actor, "update", undefined, "OTA"), "audit");
      return handleReleaseUpdate();
    }
    if (path === "/api/clone" && req.method === "POST") {
      const refused = gate(canMutate, "forbidden, viewer cannot clone");
      if (refused) return refused;
      containFailure(audit(actor, "clone", undefined), "audit");
      return handleClone(req, actorUserId);
    }
    if (path === "/api/paths" && req.method === "GET") {
      if (denied) return json({ error: "unauthorized" }, 401);
      // Host paths are owner knowledge; members work from URLs.
      if (actorUserId) return json({ error: "forbidden" }, 403);
      return json({ projects: projectsDir() });
    }
    if (path === "/api/branches" && req.method === "GET") {
      if (denied) return json({ error: "unauthorized" }, 401);
      const source = (url.searchParams.get("source") ?? "").trim();
      // Members never see host paths, only remote URLs.
      if (actorUserId && !validGitUrl(source)) return json({ error: "members list branches of a git URL" }, 403);
      try {
        return json({ branches: await listBranches(source) });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (path === "/api/workspaces" && req.method === "GET") {
      const wantsShare = url.searchParams.has("share");
      if (wantsShare && !shareIdRes) return json([]);
      if (shareIdRes) {
        const list = await listWorkspaces();
        const w = list.find((x) => x.id === shareIdRes);
        if (w && !(await mayAccessWorkspace(auth, w.id))) return json({ error: "forbidden, not your workspace" }, 403);
        // a share link shows the project, not the owner's private notes, hook secret, or conversation bookkeeping
        if (!w) return json([]);
        const { notes: _n, hookToken: _h, payload: _p, agentSessions: _a, agentSeen: _s, handoffAfter: _o, branchContext: _b, restoredFrom: _r, shareLink: _l, previewToken: _t, ...pub } = w;
        return json([pub]);
      }
      if (denied) return json({ error: "unauthorized" }, 401);
      // a named member only ever sees their own workspaces
      const list = await listWorkspaces();
      const scoped = auth?.kind === "user" && auth.role !== "owner" ? list.filter((w) => w.ownerId === auth.id) : list;
      return json(scoped);
    }
    if (path === "/api/workspaces" && req.method === "POST") {
      const refused = gate(canMutate, "forbidden, viewer cannot create workspaces");
      if (refused) return refused;
      return handleCreate(req, actorUserId);
    }

    // Static files - serve the React app from web/dist, fall back to legacy public/
    const webDist = join(process.cwd(), "web", "dist");
    const legacy = join(import.meta.dir, "public");
    const roots = [webDist, legacy];
    if (path === "/" || path === "/index.html") {
      for (const root of roots) {
        const file = join(root, "index.html");
        const f = Bun.file(file);
        if (f.size > 0) return staticResponse(f, file, req);
      }
    }
    for (const root of roots) {
      // resolve + containment: a raw path can never escape its root
      const staticPath = resolve(root, "." + path);
      if (!staticPath.startsWith(resolve(root) + "/")) continue;
      const f = Bun.file(staticPath);
      if (f.size > 0) return staticResponse(f, staticPath, req);
    }

    // SPA history fallback. Client routes (/w/:id, /workspaces, /settings) have
    // no file behind them, so without this a refresh or a shared deep link
    // 404s in production while `vite dev` hides it behind its own fallback.
    // Only navigations that actually want a document get the shell: an XHR for
    // a missing asset must still 404 so the client can see the real failure.
    const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
    if ((req.method === "GET" || req.method === "HEAD") && wantsHtml && !path.startsWith("/api")) {
      for (const root of roots) {
        const f = Bun.file(join(root, "index.html"));
        if (f.size > 0) return new Response(f);
      }
    }
    return new Response("not found", { status: 404 });
}
/**
 * The dashboard's files, compressed and cached the way a phone needs.
 *
 * Monaco is 2.7 MB of JavaScript and was sent raw, uncached, to open a diff on
 * cellular. Text assets go out brotli or gzip (compressed once, kept in memory
 * until the file changes); names under /assets/ carry a content hash, so they
 * are cached for a year, and the entry points (index.html, sw.js) are always
 * revalidated so a new release is seen at once.
 */
const COMPRESSIBLE = /\.(js|css|html|svg|json|webmanifest|map|txt)$/;
const packed = new Map<string, { mtime: number; enc: string; bytes: Uint8Array }>();
async function staticResponse(f: ReturnType<typeof Bun.file>, file: string, req: Request): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": f.type,
    "cache-control": /\/assets\/[^/]+-[\w-]{8}\./.test(file) ? "public, max-age=31536000, immutable" : "no-cache",
    vary: "Accept-Encoding",
  };
  const accepts = req.headers.get("accept-encoding") ?? "";
  const enc = !COMPRESSIBLE.test(file) ? "" : /\bbr\b/.test(accepts) ? "br" : /\bgzip\b/.test(accepts) ? "gzip" : "";
  if (!enc) return new Response(f, { headers });
  const key = `${enc}:${file}`;
  let hit = packed.get(key);
  if (!hit || hit.mtime !== f.lastModified) {
    const raw = Buffer.from(await f.arrayBuffer());
    const bytes = enc === "br" ? await brotli(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } }) : await gzip(raw);
    packed.set(key, (hit = { mtime: f.lastModified, enc, bytes }));
  }
  return new Response(hit.bytes, { headers: { ...headers, "content-encoding": hit.enc } });
}

/**
 * A shared-browser socket relays to agent-browser's stream server on loopback. It is
 * never a push subscriber or a terminal, so none of that logic sees its frames.
 */
const browserPipes = new Map<ServerWebSocket<WSData>, { up: WebSocket; pending: string[]; open: boolean }>();

function openBrowserPipe(ws: ServerWebSocket<WSData>) {
  const up = new WebSocket(`ws://127.0.0.1:${ws.data.browser!.port}/?pacing=ack`);
  const pipe = { up, pending: [] as string[], open: false };
  browserPipes.set(ws, pipe);
  up.onopen = () => {
    pipe.open = true;
    for (const m of pipe.pending) up.send(m);
    pipe.pending = [];
  };
  up.onmessage = (ev) => {
    ws.send(ev.data as string);
  };
  up.onclose = () => {
    if (browserPipes.get(ws) === pipe) browserPipes.delete(ws);
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  };
  up.onerror = () => up.close();
}

function browserClientMessage(ws: ServerWebSocket<WSData>, str: string) {
  const pipe = browserPipes.get(ws);
  if (!pipe) return;
  touchBrowser({ id: ws.data.browser!.id });
  let type = "";
  try {
    type = String(JSON.parse(str).type ?? "");
  } catch {
    /* not JSON: passed on as it is */
  }
  // a viewer watches: only frame pacing (ack, config) goes through. Anything else could move or reconfigure the browser, which only a member may do.
  if (!ws.data.canMutate && type !== "ack" && type !== "config") return;
  if (pipe.open) pipe.up.send(str);
  else pipe.pending.push(str);
}

function closeBrowserPipe(ws: ServerWebSocket<WSData>) {
  const pipe = browserPipes.get(ws);
  if (!pipe) return;
  browserPipes.delete(ws);
  pipe.up.close();
}

const socketHandlers: WebSocketHandler<WSData> = {
    open(ws) {
      if (ws.data.browser) {
        openBrowserPipe(ws);
        return;
      }
      // every dashboard page is a push subscriber
      pushClients.add(ws);
    },
    message(ws, raw) {
      if (ws.data.browser) {
        browserClientMessage(ws, String(raw));
        return;
      }
      const str = String(raw);
      // Bound to the socket at upgrade (see `server.upgrade` above). Absent
      // only for a connection made before this check existed and surviving a
      // hot reload; treat that as no access rather than trusting it.
      const wsAuth = ws.data;

      // JSON control frames (attach/resize) vs raw terminal input
      if (str.startsWith("{")) {
        try {
          const msg = JSON.parse(str) as { type?: string; id?: string; terminalId?: string; cols?: number; rows?: number };
          if (msg.type === "attach" && msg.id) {
            // Hoisted out of the closures below: TypeScript cannot carry the
            // `msg.id` narrowing into a callback.
            const attachId = msg.id;
            const attachTerminal = msg.terminalId;
            containFailure(
              mayAccessWorkspace(wsAuth?.auth ?? null, attachId).then((ok) => {
                if (!ok) {
                  ws.send(JSON.stringify({ type: "error", error: "forbidden, not your workspace" }));
                  return;
                }
                // A terminal socket carries raw bytes. Left in the push set it
                // was sent {"type":"workspace.done"}, which the terminal printed.
                pushClients.delete(ws);
                // open/spawn before subscribe so the replay never misses the first bytes
                return ensurePtySession(attachId, attachTerminal)
                  .then(() => {
                    // The session exists now: apply the size this client already
                    // asked for, which may have been sent before the PTY existed.
                    const sessId = sessionId(attachId, attachTerminal);
                    const dims = pendingResize.get(sessId);
                    if (!dims) return;
                    return ptySend({ type: "resize", id: sessId, cols: dims.cols, rows: dims.rows });
                  })
                  .then(() => attachPty(ws, attachId, attachTerminal))
                  .catch((e) => {
                    ws.send(JSON.stringify({ type: "error", error: (e as Error).message }));
                  });
              }),
              `attach ${attachId}`,
            );
          } else if (msg.type === "resize" && msg.id && msg.cols && msg.rows) {
            const resizeId = msg.id;
            const resizeTerminal = msg.terminalId;
            const cols = msg.cols, rows = msg.rows;
            containFailure(
              mayAccessWorkspace(wsAuth?.auth ?? null, resizeId).then((ok) => {
                if (!ok) return;
                const sessId = sessionId(resizeId, resizeTerminal);
                pendingResize.set(sessId, { cols, rows });
                return ptySend({ type: "resize", id: sessId, cols, rows });
              }),
              `resize ${resizeId}`,
            );
          }
          return;
        } catch {
          // not JSON - fall through to terminal input
        }
      }
      // Raw bytes are keystrokes: the same mutate/read split HTTP enforces
      // (viewer reads a workspace but cannot act on it) applies here, or a
      // viewer's "read-only" session is actually a shell as whoever attached.
      if (wsAuth && !wsAuth.canMutate) return;
      const sessId = termClients.get(ws);
      if (sessId) {
        containFailure(
          ptySend({ type: "input", id: sessId, data: Buffer.from(str, "utf8").toString("base64") }),
          "terminal input",
        );
      }
    },
    close(ws) {
      if (ws.data.browser) {
        closeBrowserPipe(ws);
        return;
      }
      pushClients.delete(ws);
      const sessId = termClients.get(ws);
      if (sessId) containFailure(ptySend({ type: "unsubscribe", id: sessId }), "terminal unsubscribe");
      termClients.delete(ws);
    },
    drain(_ws) {
      // no-op
    },
};

/**
 * Browser hardening on every response (docs/access-ux-v1.17.0.md §2.5). The CSP
 * was measured against the built app: one external module script, no inline
 * script; the terminal's image addon compiles WebAssembly, hence 'wasm-unsafe-eval'
 * (not 'unsafe-eval': JS eval stays blocked). Styles need 'unsafe-inline' (Monaco, sonner and React style attributes
 * inject them). HSTS belongs to the TLS proxy, which this app cannot see.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function secured(res: Response | undefined): Response | undefined {
  if (!res || res.status === 101) return res; // socket upgrade: nothing to decorate
  try {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  } catch {
    // immutable headers (a proxied/fetched response): copy once
    const copy = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) copy.headers.set(k, v);
    return copy;
  }
}

serve({
  port: PORT,
  // Every interface by default, as before: but now a choice with a consequence:
  // bound anywhere but loopback with no key and no users, the server generates
  // itself one (see resolveAccessKey in lib.ts).
  hostname: HOST,
  // A preview page and a chat picture carry their own sandbox CSP. secured() would overwrite it with
  // the app's policy, which blocks the page's inline scripts.
  fetch: async (req, server) => {
    const res = await handle(req, server);
    const own = new URL(req.url).pathname;
    return own.startsWith("/p/") || own.startsWith("/pic/") ? res : secured(res);
  },
  websocket: socketHandlers,
});


// The dev servers are detached, so they would outlive this process. Stop them on the way out; a signal is sent again once they are stopped, so the exit is the same as before.
process.once("exit", stopAllDevServers);
process.once("exit", stopCodexLogin);
process.once("exit", stopSignIns);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    stopAllDevServers();
    process.kill(process.pid, sig);
  });
}

console.log(`works server on http://${HOST}:${PORT}${authRequired() ? " (access key required)" : " (no key, loopback only)"}`);
