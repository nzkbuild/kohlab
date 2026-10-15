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
import type { Workspace } from "./types";
import { identityOf, ownBase, previewWorkspace, wsDir } from "./lib";
import { SAFE_ENV_KEYS, ensureDevServer, stopDevServer } from "./devserver";

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
export async function browserAction(ws: Workspace, action: "open" | "home" | "back" | "forward" | "reload", url?: string): Promise<string | null> {
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

/** The page's current URL, or null when no browser runs. */
export async function browserUrl(ws: Workspace): Promise<string | null> {
  try {
    const url = jsonOut(await cli(ws, ["--json", "get", "url"], 10_000))?.data?.url;
    return typeof url === "string" && url ? url : null;
  } catch {
    return null;
  }
}

/** Close the workspace's browser and its dev server. Best-effort: a browser the idle timeout already closed is fine. */
export async function stopBrowser(ws: Workspace): Promise<void> {
  running.delete(ws.id);
  stopDevServer(ws);
  await cli(ws, ["close"], 10_000).catch(() => {});
}

/**
 * Claude's MCP config for this workspace: the same agent-browser session, so Claude
 * and the person share one browser. Written beside the worktree, not in it.
 * Null when it cannot be written: Claude then starts without browser tools.
 */
export function writeBrowserMcp(ws: Workspace, who: ReturnType<typeof identityOf>): string | null {
  try {
    const config = { mcpServers: { browser: { command: BIN, args: ["mcp"], env: browserEnv(ws) } } };
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
