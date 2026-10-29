/**
 * The shared browser: one real Chrome per workspace, driven by the agent-browser
 * CLI. The person watches it through a frame stream (the server relays it) and
 * can click in it; Claude drives the same session through agent-browser's MCP
 * server. Both must run as the project's identity, or they would not share the
 * session's socket.
 */
import { chownSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Pick as Picked, Problem, Workspace } from "./types";
import { identityOf, listVersions, ownBase, previewWorkspace, wsDir } from "./lib";
import { SAFE_ENV_KEYS, clearDevServerProblem, devServerOrigin, devServerProblem, ensureDevServer, stopDevServer } from "./devserver";

/** At most this many Chrome instances run at once; the least recently used is closed for a new one. */
const MAX_BROWSERS = 3;
/** Shut the agent-browser daemon down after 15 min idle. The user's lifetime decision. */
const IDLE_MS = "900000";
const BIN = join(import.meta.dir, "node_modules", ".bin", "agent-browser");

/** A browser problem the person can read. The status is the HTTP code the route answers with. */
export class BrowserError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Running browsers this server started, by workspace id, with when they were last used. */
const running = new Map<string, { ws: Workspace; used: number }>();

/** Page errors the person has sent to the AI (or cleared). agent-browser keeps its error list after `errors --clear`, so they are filtered here. */
const clearedErrors = new Map<string, Set<string>>();
/** Page problems for a workspace, for a few seconds: the chat and the preview both poll them. */
const problemCache = new Map<string, { at: number; list: Problem[] }>();
// ponytail: a 3 s cache per workspace; a poll every 5 s already costs one CLI round, so this only absorbs two panels at once.
const PROBLEM_CACHE_MS = 3_000;
const MAX_PROBLEMS = 20;
/** Requests seen without a status, by workspace and "METHOD url", with when they were first seen. */
const pendingSeen = new Map<string, Map<string, number>>();
const PENDING_FAIL_MS = 5_000;

export function browserSession(ws: Pick<Workspace, "id">): string {
  return `kohlab-${ws.id}`;
}

export function browserProfileDir(ws: Workspace): string {
  return join(wsDir(ws), "browser-profile");
}

/** The Chrome to drive: KOHLAB_CHROME, else the newest Playwright build on this box, else agent-browser's own. */
function chromePath(): string | null {
  if (process.env.KOHLAB_CHROME) return process.env.KOHLAB_CHROME;
  const dir = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(dir)) return null;
  const builds = readdirSync(dir)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.slice("chromium-".length)) - Number(a.slice("chromium-".length)));
  for (const b of builds) {
    const p = join(dir, b, "chrome-linux64", "chrome");
    if (existsSync(p)) return p;
  }
  return null;
}

/** The environment that points agent-browser at this workspace's session. Used by the server's own calls and by Claude's MCP config alike. */
export function browserEnv(ws: Workspace): Record<string, string> {
  const env: Record<string, string> = {
    AGENT_BROWSER_SESSION: browserSession(ws),
    AGENT_BROWSER_PROFILE: browserProfileDir(ws),
    AGENT_BROWSER_IDLE_TIMEOUT_MS: IDLE_MS,
  };
  const chrome = chromePath();
  if (chrome) env.AGENT_BROWSER_EXECUTABLE_PATH = chrome;
  return env;
}

/** Where the browser's pages are served from: the dev server when the project has one, else the static preview. */
export async function startUrlFor(ws: Workspace): Promise<string> {
  const dev = await ensureDevServer(ws);
  if (dev) return dev;
  const { url } = await previewWorkspace(ws.id);
  return `${ownBase()}${url}`;
}

/** Run agent-browser for this workspace as its identity, with a time limit. Throws BrowserError on failure. */
async function cli(ws: Workspace, args: string[], timeoutMs: number): Promise<string> {
  const who = identityOf(ws);
  const env: Record<string, string> = {};
  for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  Object.assign(env, browserEnv(ws));
  env.HOME = who?.home || homedir();
  const proc = Bun.spawn([BIN, "--session", browserSession(ws), ...args], {
    env,
    uid: who?.uid,
    gid: who?.gid,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    console.warn(`[browser] agent-browser ${args.join(" ")} failed (${code}): ${(err || out).trim().slice(0, 300)}`);
    throw new BrowserError(503, "The browser did not answer. Try again in a moment.");
  }
  return out;
}

/** The last JSON line of a CLI answer: a daemon may print a warning line before it. */
function jsonOut(out: string): any {
  const line = out.split("\n").reverse().find((l) => l.trim().startsWith("{"));
  return line ? JSON.parse(line) : null;
}

/** The stream port while the browser is up, or null. */
async function streamPort(ws: Workspace): Promise<number | null> {
  try {
    const d = jsonOut(await cli(ws, ["--json", "stream", "status"], 10_000));
    return d?.data?.connected && d.data.enabled && Number.isInteger(d.data.port) ? d.data.port : null;
  } catch {
    return null;
  }
}

function track(ws: Workspace) {
  running.set(ws.id, { ws, used: Date.now() });
}

/** Mark a browser as used now, so the least recently used one is the one closed at the cap. */
export function touchBrowser(ws: Pick<Workspace, "id">) {
  const r = running.get(ws.id);
  if (r) r.used = Date.now();
}

/**
 * Before this workspace's browser may start: close the least recently used one when
 * this would be a fourth, and make sure the profile is the project's own. Run before
 * any probe, because a probe on a new session can start Chrome by itself.
 */
async function prepare(ws: Workspace) {
  while (!running.has(ws.id) && running.size >= MAX_BROWSERS) {
    let lru: { ws: Workspace; used: number } | undefined;
    for (const r of running.values()) if (!lru || r.used < lru.used) lru = r;
    if (!lru) break;
    await stopBrowser(lru.ws); // always removes its entry, so the loop ends
  }
  // the profile is written by the project's identity, not by root
  const profile = browserProfileDir(ws);
  const who = identityOf(ws);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  if (who) chownSync(profile, who.uid, who.gid);
}

/** The stream port of a running browser, starting one on `startUrl` when none runs. */
export async function ensureBrowser(ws: Workspace, startUrl: string): Promise<{ port: number }> {
  await prepare(ws);
  let port = await streamPort(ws);
  // a blank Chrome (from a probe, or a deliberate about:blank) gets the start page too
  if (!port || (await browserUrl(ws)) === "about:blank") {
    await cli(ws, ["open", startUrl], 30_000);
    port = await streamPort(ws);
  }
  if (!port) throw new BrowserError(503, "The browser did not start. Try again in a moment.");
  track(ws);
  return { port };
}

/** Only web addresses. A bare host gets https://; anything else (file:, javascript:, chrome:, data:) is refused. Returns the normalised URL, or null. */
export function normalizeBrowserUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  // "scheme:" with no "//" is a javascript:, data: or mailto: link, unless it is host:port
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/:\/\//.test(s) && !/^[^/]+:\d+(\/|$)/.test(s)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

/** Navigate: open a URL (starting the browser when none runs), or go back, forward or reload. Returns the page's URL now. */
export async function browserAction(
  ws: Workspace,
  action: "open" | "home" | "back" | "forward" | "reload" | "viewport",
  url?: string,
  size?: { width: number; height: number },
): Promise<string | null> {
  if (action === "viewport") {
    const { width, height } = size ?? { width: NaN, height: NaN };
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new BrowserError(400, "Width and height must be numbers.");
    // Only a running browser has a page to size: a resize never starts one.
    if (!running.has(ws.id)) return null;
    const w = Math.min(2560, Math.max(320, Math.round(width)));
    const h = Math.min(1600, Math.max(240, Math.round(height)));
    await cli(ws, ["set", "viewport", String(w), String(h)], 10_000);
    touchBrowser(ws);
    return browserUrl(ws);
  }
  if (action === "open" || action === "home") {
    // home is the project's own start page, opened by the server: never the public address the person used
    const target = action === "home" ? await startUrlFor(ws) : normalizeBrowserUrl(url ?? "");
    if (!target) throw new BrowserError(400, "Only web addresses (http or https) can be opened here.");
    // open starts the browser when none runs, and navigates it when one does
    await prepare(ws);
    await cli(ws, ["open", target], 30_000);
    track(ws);
  } else {
    await cli(ws, [action], 30_000);
    touchBrowser(ws);
  }
  return browserUrl(ws);
}

/** The page's real URL (where the browser is), or null when no browser runs. Internal: it may carry the share token. */
async function currentUrl(ws: Workspace): Promise<string | null> {
  try {
    const url = jsonOut(await cli(ws, ["--json", "get", "url"], 10_000))?.data?.url;
    return typeof url === "string" && url ? url : null;
  } catch {
    return null;
  }
}

/** The page's URL as the owner may see it, or null when no browser runs. The share token never shows. */
export async function browserUrl(ws: Workspace): Promise<string | null> {
  const url = await currentUrl(ws);
  return url === null ? null : hideShare(ws, url);
}

/** The share link's token replaced in anything the owner sees: a page address, a problem, a point. */
export function hideShare(ws: Pick<Workspace, "shareLink">, text: string): string {
  const token = ws.shareLink?.token;
  return token ? text.split(token).join("share-link") : text;
}

/** Close the workspace's browser and its dev server. Best-effort: a browser the idle timeout already closed is fine. */
export async function stopBrowser(ws: Workspace): Promise<void> {
  running.delete(ws.id);
  clearedErrors.delete(ws.id);
  pendingSeen.delete(ws.id);
  problemCache.delete(ws.id);
  stopDevServer(ws);
  await cli(ws, ["close"], 10_000).catch(() => {});
}

/**
 * Claude's MCP config for this workspace: the same agent-browser session, so Claude
 * and the person share one browser. Written beside the worktree, not in it.
 * Null when it cannot be written: Claude then starts without browser tools.
 */
export function writeBrowserMcp(
  ws: Workspace,
  who: ReturnType<typeof identityOf>,
  extra: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {},
  opts: { browser?: boolean } = {},
): string | null {
  try {
    // extra: more MCP servers beside the browser (the project brain's, for chats). browser: false leaves the browser tools out (team agents other than the Tester).
    const browser = opts.browser === false ? {} : { browser: { command: BIN, args: ["mcp"], env: browserEnv(ws) } };
    const config = { mcpServers: { ...browser, ...extra } };
    const file = join(wsDir(ws), "kohlab-mcp.json");
    // wsDir can be writable by the agent's user: never write through a planted symlink.
    // unlink, then O_EXCL (which also refuses a symlink) with the final mode from the start.
    rmSync(file, { force: true });
    writeFileSync(file, JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600 });
    if (who) chownSync(file, who.uid, who.gid);
    return file;
  } catch (e) {
    console.warn(`browser tools not installed for Claude, starting without them: ${(e as Error).message}`);
    return null;
  }
}

const BROWSER_TOOL_PREFIX = "mcp__browser__agent_browser_";
/** Looking and moving on: read-only in agent-browser's own tools/list (core profile), plus the names the chat allows as read-only. */
const BROWSER_READ_ONLY = new Set(["read", "snapshot", "screenshot", "tab_list", "open", "back", "forward", "reload", "tools_profiles", "scroll", "hover", "console", "errors"]);
/** Acting on the page. Allowed only on the project's own page; anything else is asked. Unknown browser tools are asked too. */
const BROWSER_INTERACTION = new Set([
  "click", "dblclick", "fill", "type", "press", "check", "uncheck", "select", "drag", "upload", "download", "eval",
  "keydown", "keyup", "keyboard_type", "keyboard_insert_text", "focus", "mouse_move", "mouse_down", "mouse_up", "mouse_wheel",
  "scroll_into_view", "tap", "swipe", "tab_new", "tab_switch", "tab_close", "close",
]);

/** A workspace's own pages: its Kohlab preview as a full URL prefix (origin plus /p/<token>/), and its dev server's origin. Null when there is none. */
export type OwnPages = { previewPrefix: string | null; devOrigin: string | null };

const LOOPBACK_NAMES = ["127.0.0.1", "localhost"];

/** Whether a page is one of the workspace's own. Compares parsed origins and paths, never raw strings. */
function isOwnPage(url: string | null, own: OwnPages): boolean {
  try {
    const u = new URL(url ?? "");
    if (own.previewPrefix) {
      const p = new URL(own.previewPrefix);
      if (u.origin === p.origin && u.pathname.startsWith(p.pathname)) return true;
    }
    if (own.devOrigin) {
      const d = new URL(own.devOrigin);
      if (u.protocol === "http:" && LOOPBACK_NAMES.includes(u.hostname) && u.port === d.port) return true;
    }
  } catch {
    /* not an address: not ours */
  }
  return false;
}

/**
 * The answer to a permission question from one of Claude's tools: "allow" now, "ask" the person,
 * or null when the tool is not a browser tool (the chat's usual flow). Fails closed: no URL means ask.
 * Interaction is allowed only on the workspace's own pages, never on other localhost ports or other /p/ tokens.
 */
export function browserToolPolicy(toolName: string, currentUrl: string | null, ownPages: OwnPages): "allow" | "ask" | null {
  if (!toolName.startsWith("mcp__browser__")) return null;
  const short = toolName.startsWith(BROWSER_TOOL_PREFIX) ? toolName.slice(BROWSER_TOOL_PREFIX.length) : "";
  if (BROWSER_READ_ONLY.has(short) || short.startsWith("get_") || short.startsWith("wait")) return "allow";
  if (BROWSER_INTERACTION.has(short) && isOwnPage(currentUrl, ownPages)) return "allow";
  return "ask";
}

// --- problems, points and earlier versions ----------------------------------

/** The workspace's own pages: its Kohlab preview (versions included, they sit under it) and its dev server's origin. */
function ownPagesFor(ws: Workspace): OwnPages {
  return { previewPrefix: ws.previewToken ? `${ownBase()}/p/${ws.previewToken}/` : null, devOrigin: devServerOrigin(ws) };
}

const clip = (s: string, n: number) => Array.from(s).slice(0, n).join("");
const errorKey = (e: { text?: unknown; line?: unknown; column?: unknown }) => `${e.text}|${e.line}|${e.column}`;

/** The /p/<token>/ a page sits under is a credential: what the chat is told keeps only the path inside it. */
const noToken = (s: string) => s.replace(/\/p\/[A-Za-z0-9_-]{16,}\//g, "/");

/** One problem, with the share token hidden and the sizes kept to what the chat can take. */
function problemOf(ws: Workspace, kind: Problem["kind"], text: string, detail: string | undefined, at: number): Problem {
  const p: Problem = { kind, text: clip(noToken(hideShare(ws, text)).replace(/\s+/g, " ").trim() || "(no message)", 300), at };
  if (detail !== undefined) p.detail = clip(noToken(hideShare(ws, detail)), 4000);
  return p;
}

/** Errors, failed requests and console errors of the page as it is now. Only while the browser shows an own page. */
async function pageProblems(ws: Workspace): Promise<Problem[]> {
  const here = await currentUrl(ws);
  // An earlier version is only being looked at: its errors are not the project's to fix.
  if (!isOwnPage(here, ownPagesFor(ws)) || /\/p\/[^/]+\/v\/[0-9a-f]{40}\//.test(here ?? "")) return [];
  const messages = jsonOut(await cli(ws, ["--json", "console"], 10_000))?.data?.messages ?? [];
  const errors = jsonOut(await cli(ws, ["--json", "errors"], 10_000))?.data?.errors ?? [];
  const requests = jsonOut(await cli(ws, ["--json", "network", "requests"], 10_000))?.data?.requests ?? [];
  const cleared = clearedErrors.get(ws.id) ?? new Set<string>();
  const at = Date.now();
  const list: Problem[] = [];
  const seen = pendingSeen.get(ws.id) ?? new Map<string, number>();
  const stillOpen = new Set<string>();
  for (const m of messages) {
    if (m?.type === "error" && typeof m.text === "string") list.push(problemOf(ws, "console", m.text, undefined, at));
  }
  for (const e of errors) {
    if (typeof e?.text !== "string" || cleared.has(errorKey(e))) continue;
    list.push(problemOf(ws, "page", e.text.split("\n")[0], e.text, at));
  }
  for (const r of requests) {
    if (typeof r?.url !== "string") continue;
    let path = "";
    try {
      path = new URL(r.url).pathname;
    } catch {
      /* not an address: keep it */
    }
    if (path === "/favicon.ico") continue;
    if (typeof r.status === "number" && r.status < 400) continue;
    // No status yet may only mean the request is still going: it counts as failed once it has been seen without one for 5 s.
    if (typeof r.status !== "number") {
      const key = `${r.method} ${r.url}`;
      const first = seen.get(key) ?? at;
      seen.set(key, first);
      stillOpen.add(key);
      if (at - first < PENDING_FAIL_MS) continue;
    }
    const what = typeof r.status === "number" ? `returned ${r.status}` : "got no answer";
    list.push(problemOf(ws, "request", `${typeof r.method === "string" ? r.method : "GET"} ${r.url} ${what}`, undefined, at));
  }
  for (const key of seen.keys()) if (!stillOpen.has(key)) seen.delete(key);
  pendingSeen.set(ws.id, seen);
  return list;
}

/**
 * What the page and the dev server got wrong, for "ask the AI to fix it". Never starts
 * a browser: with none running only a dev server problem can come back. Page problems
 * are cached for 3 s per workspace; a poll every 5 s already costs one CLI round.
 * ponytail: three CLI calls per uncached poll; agent-browser's `batch` can do them in one.
 */
export async function browserProblems(ws: Workspace): Promise<Problem[]> {
  const dev = devServerProblem(ws);
  const base = dev ? [dev] : [];
  if (!running.has(ws.id)) return base;
  const hit = problemCache.get(ws.id);
  let list: Problem[];
  if (hit && Date.now() - hit.at < PROBLEM_CACHE_MS) {
    list = hit.list;
  } else {
    // a browser that does not answer is not a problem with the app
    list = await pageProblems(ws).catch(() => []);
    problemCache.set(ws.id, { at: Date.now(), list });
  }
  return [...base, ...list].sort((a, b) => a.at - b.at).slice(-MAX_PROBLEMS);
}

/** Clear what was reported: the browser's buffers and the dev server's failure. */
export async function clearBrowserProblems(ws: Workspace): Promise<void> {
  clearDevServerProblem(ws);
  problemCache.delete(ws.id);
  if (!running.has(ws.id)) return;
  await cli(ws, ["--json", "console", "--clear"], 10_000);
  // `errors --clear` answers with the list but keeps it (agent-browser 0.39.1), so the ones seen are remembered here
  const seen = jsonOut(await cli(ws, ["--json", "errors", "--clear"], 10_000))?.data?.errors ?? [];
  const set = clearedErrors.get(ws.id) ?? new Set<string>();
  for (const e of seen) set.add(errorKey(e));
  clearedErrors.set(ws.id, set);
  await cli(ws, ["--json", "network", "requests", "--clear"], 10_000);
}

/** The JS that names the element at a point. Only two integers are added to it, by pickElement. */
const PICK_JS = `function (x, y) {
  var el = document.elementFromPoint(x, y);
  if (!el || el === document.documentElement || el === document.body) return "null";
  var selector = "";
  var node = el;
  for (var depth = 0; node && node.nodeType === 1 && depth < 6; depth++) {
    if (node.id) { selector = "#" + CSS.escape(node.id) + (selector ? " > " + selector : ""); break; }
    var part = node.tagName.toLowerCase();
    var parent = node.parentElement;
    if (parent) {
      var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
      if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
    }
    selector = part + (selector ? " > " + selector : "");
    node = parent;
  }
  var r = el.getBoundingClientRect();
  return JSON.stringify({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 80),
    id: el.id || undefined,
    classes: Array.prototype.slice.call(el.classList, 0, 5).map(function (c) { return c.slice(0, 40); }),
    selector: selector.slice(0, 300),
    box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    page: location.pathname,
    viewport: { width: innerWidth, height: innerHeight }
  });
}`;

function clampCoord(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(4000, Math.max(0, Math.round(v))) : null;
}

/** The numeric fields of `keys` in `o`, rounded and clamped; null when any is missing or not a number. */
function numbersOf(o: any, keys: string[], hi: number): Record<string, number> | null {
  if (!o || typeof o !== "object") return null;
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out[k] = Math.min(hi, Math.max(0, Math.round(v)));
  }
  return out;
}

/** A pick the page sent, re-checked here: lengths, shapes and the path form. Null when it does not fit. */
export function checkPick(ws: Workspace, raw: string): Picked | null {
  let o: any;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const tag = typeof o.tag === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(o.tag) ? o.tag : null;
  const selector = typeof o.selector === "string" && o.selector ? clip(hideShare(ws, o.selector), 300) : null;
  // the /p/<token> the page sits under is a credential: the chat only needs the path inside it
  const page = typeof o.page === "string" && o.page.startsWith("/") ? clip(hideShare(ws, o.page.replace(/^\/p\/[A-Za-z0-9_-]+(?=\/)/, "")), 200) : null;
  const box = numbersOf(o.box, ["x", "y", "width", "height"], 10_000);
  const viewport = numbersOf(o.viewport, ["width", "height"], 10_000);
  if (!tag || !selector || !page || !box || !viewport) return null;
  const classes = Array.isArray(o.classes)
    ? o.classes.filter((c: unknown): c is string => typeof c === "string").slice(0, 5).map((c: string) => clip(c, 40))
    : [];
  const text = clip(typeof o.text === "string" ? o.text.replace(/\s+/g, " ").trim() : "", 80);
  const pick: Picked = { tag, text, classes, selector, box: box as Picked["box"], page, viewport: viewport as Picked["viewport"] };
  if (typeof o.id === "string" && o.id) pick.id = clip(o.id, 80);
  return pick;
}

/** The element at a page point (CSS pixels of the browser's viewport). Needs a running browser on an own page. */
export async function pickElement(ws: Workspace, x: unknown, y: unknown): Promise<Picked> {
  if (!running.has(ws.id) || !isOwnPage(await currentUrl(ws), ownPagesFor(ws))) throw new BrowserError(400, "Point works on your own page.");
  const px = clampCoord(x);
  const py = clampCoord(y);
  if (px === null || py === null) throw new BrowserError(400, "Point at a place on the page.");
  const js = `(${PICK_JS})(${JSON.stringify(px)}, ${JSON.stringify(py)})`;
  const raw = jsonOut(await cli(ws, ["--json", "eval", "-b", Buffer.from(js).toString("base64")], 10_000))?.data?.result;
  const pick = typeof raw === "string" ? checkPick(ws, raw) : null;
  if (!pick) throw new BrowserError(404, "Nothing to point at there.");
  touchBrowser(ws);
  return pick;
}

/** Open an earlier version in the shared browser, at its own address under the preview (the version is in the path). */
export async function openVersion(ws: Workspace, sha: string): Promise<string | null> {
  if (!(await listVersions(ws.id)).some((v) => v.id === sha)) throw new BrowserError(404, "That version isn't in this project's history.");
  const { url } = await previewWorkspace(ws.id);
  await prepare(ws);
  await cli(ws, ["open", `${ownBase()}${url}v/${sha}/`], 30_000);
  track(ws);
  return browserUrl(ws);
}

/** After the share link changes: a running browser goes back to the start page, which now uses the new link. */
export async function reopenHome(ws: Workspace): Promise<void> {
  if (running.has(ws.id)) await browserAction(ws, "home");
}
