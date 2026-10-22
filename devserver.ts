/**
 * Lazy dev server per workspace: when a web project has a dev script, the shared
 * browser opens its live server instead of the static preview, so hot reload works.
 * Kohlab never installs packages: no node_modules means no dev server.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import type { Problem, Workspace } from "./types";
import { identityOf, worktreePath } from "./lib";

/** The only keys copied into the dev server, never the server's secrets. Same allowlist as chat.ts. */
export const SAFE_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SHELL", "USER", "LOGNAME"];
const DEV_WAIT_MS = 30_000;

/** The command that starts a project's dev server, or null when it has none. */
export function detectDevCommand(pkg: any): string[] | null {
  const scripts = pkg?.scripts ?? {};
  if (typeof scripts.dev === "string" && scripts.dev.trim()) return ["npm", "run", "dev"];
  if (typeof scripts.start === "string" && scripts.start.trim()) return ["npm", "start"];
  return null;
}

/**
 * What a share link can serve: the files as they are (no dev command), a Vite dev
 * server under /p/<token>/ (the only app kind with a base path we know to work), or
 * a dev command we cannot share yet.
 */
export function appKind(pkg: any): "static" | "app" | "unsupported" {
  const cmd = detectDevCommand(pkg);
  if (!cmd) return "static";
  const script = pkg?.scripts?.[cmd[1] === "run" ? "dev" : "start"];
  return /\bvite\b/.test(script) ? "app" : "unsupported";
}

/** The port a dev server announces ("Local: http://localhost:5173/"), or null. Colour codes are stripped first. */
export function parseDevUrl(text: string): number | null {
  const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/.exec(clean);
  const port = m ? Number(m[1]) : NaN;
  return port > 0 && port < 65536 ? port : null;
}

interface Dev {
  child?: ChildProcess;
  url: Promise<string | null>;
  /** The port Kohlab asked the dev server for. */
  port?: number;
  /** Set once the dev server has announced exactly that port. */
  origin?: string;
  /** The share token the dev server was started under (its base path), if any. */
  base?: string;
  /** Set when stopped on purpose, so the exit is not reported as a crash. */
  stopping?: boolean;
}

/** One dev server per workspace id. The promise is kept so two callers share one start. */
const devs = new Map<string, Dev>();

/** Why a workspace's dev server did not start or stopped, until the next start works. */
const failures = new Map<string, { at: number; text: string; detail?: string }>();

/** The dev server problem a person can ask the AI to fix, or null. */
export function devServerProblem(ws: Pick<Workspace, "id">): Problem | null {
  const f = failures.get(ws.id);
  return f ? { kind: "devserver", text: f.text, detail: f.detail, at: f.at } : null;
}

export function clearDevServerProblem(ws: Pick<Workspace, "id">) {
  failures.delete(ws.id);
}

function fail(id: string, text: string, cmd: string[], out: string) {
  const detail = `$ ${cmd.join(" ")}\n${out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim()}`.slice(-4000);
  failures.set(id, { at: Date.now(), text, detail });
}

/** A free loopback port, picked by listening on 0: handed to the dev server. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Kill the whole group: the dev server's own children (Vite, Next workers) die with it. */
function killGroup(child: ChildProcess) {
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

/** The URL of the workspace's dev server, starting it if needed; null when there is none or it did not come up. */
export function ensureDevServer(ws: Workspace): Promise<string | null> {
  const have = devs.get(ws.id);
  if (have) return have.url;
  const entry: Dev = { url: Promise.resolve(null) };
  devs.set(ws.id, entry);
  entry.url = startDev(ws, entry).then((url) => {
    // a failed start is not remembered: the next call tries again (the problem stays until then).
    // ponytail: a broken dev script costs its 30 s wait on every open; remember the failure if that shows up.
    if (!url && devs.get(ws.id) === entry) devs.delete(ws.id);
    return url;
  });
  return entry.url;
}

async function startDev(ws: Workspace, entry: Dev): Promise<string | null> {
  const tree = worktreePath(ws);
  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(join(tree, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const cmd = detectDevCommand(pkg);
  if (!cmd || !existsSync(join(tree, "node_modules"))) return null;

  let port: number;
  try {
    port = await freePort();
  } catch {
    return null;
  }
  // A Vite app under a share link runs under that link's base path, so its pages and assets resolve through the proxy.
  const base = ws.shareLink && appKind(pkg) === "app" ? ws.shareLink.token : undefined;
  const args = base ? ["--", "--base", `/p/${base}/`, "--port", String(port), "--strictPort"] : [];
  entry.base = base;
  entry.port = port;
  const who = identityOf(ws);
  const env: Record<string, string> = {};
  for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  env.HOME = who?.home || homedir();
  env.PORT = String(port);
  env.BROWSER = "none"; // no opening a browser on the server's desktop
  // detached: its own process group, so stop can kill the whole tree
  const child = spawn(cmd[0], [...cmd.slice(1), ...args], { cwd: tree, uid: who?.uid, gid: who?.gid, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  entry.child = child;
  let exitCode: number | null = null;
  let exited = false;
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
    if (devs.get(ws.id) === entry) devs.delete(ws.id);
    if (entry.origin && !entry.stopping) fail(ws.id, `Your app stopped running (exit code ${code ?? "unknown"}).`, cmd, out);
  });
  child.on("error", () => {});

  let out = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const found = new Promise<number | null>((resolve) => {
    const onData = (d: Buffer) => {
      out = (out + d.toString()).slice(-8000);
      const p = parseDevUrl(out);
      if (p) resolve(p);
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("exit", () => resolve(null));
  });
  const announced = await Promise.race([
    found,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), DEV_WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));

  // stopped while it was starting: do not leave it running unowned (an exit during the start is a failure, reported below)
  if (entry.stopping) {
    if (child.pid) killGroup(child);
    return null;
  }
  if (announced === null) {
    if (child.pid) killGroup(child);
    fail(
      ws.id,
      exited ? `Your app didn't start (exit code ${exitCode ?? "unknown"}).` : "Your app didn't say where it was running in 30 s.",
      cmd,
      out,
    );
    return null;
  }
  // Only the port Kohlab asked for is trusted. Anything else (another server, Kohlab's own port) is refused, never opened or proxied.
  if (announced !== port) {
    killGroup(child);
    fail(ws.id, "Your app ran on a different address than the one Kohlab gave it.", cmd, out);
    return null;
  }
  failures.delete(ws.id);
  entry.origin = `http://127.0.0.1:${port}`;
  return `${entry.origin}${base ? `/p/${base}/` : ""}`;
}

/** The address of the workspace's running dev server, or null when none runs or it is still starting. */
export function devServerOrigin(ws: Pick<Workspace, "id">): string | null {
  return devs.get(ws.id)?.origin ?? null;
}

/**
 * The port of the workspace's running dev server, for the share proxy: only when it
 * is up, on the port Kohlab gave it, and started under the share link that exists now.
 * Null otherwise, so a request is never forwarded anywhere but that port.
 */
export function devProxyPort(ws: Workspace): number | null {
  const e = devs.get(ws.id);
  if (!e?.origin || e.port === undefined) return null;
  if ((e.base ?? null) !== (ws.shareLink?.token ?? null)) return null;
  return e.port;
}

/** Stop the workspace's dev server, if one runs. */
export function stopDevServer(ws: Pick<Workspace, "id">) {
  const entry = devs.get(ws.id);
  devs.delete(ws.id);
  if (entry) {
    entry.stopping = true;
    if (entry.child) killGroup(entry.child);
  }
}

/** Stop every dev server this process started. Called as the server goes down: the dev servers are detached, so they would outlive it. */
export function stopAllDevServers() {
  for (const id of [...devs.keys()]) stopDevServer({ id });
}
