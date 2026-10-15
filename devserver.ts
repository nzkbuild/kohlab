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
import type { Workspace } from "./types";
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
  /** Set once the dev server has announced its port. */
  origin?: string;
}

/** One dev server per workspace id. The promise is kept so two callers share one start. */
const devs = new Map<string, Dev>();

/** A free loopback port, picked by listening on 0: handed to the dev server as PORT. */
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
    // a failed start is not remembered: the next call tries again.
    // ponytail: a broken dev script costs its 30 s wait on every open; remember the failure if that shows up.
    if (!url && devs.get(ws.id) === entry) devs.delete(ws.id);
    return url;
  });
  return entry.url;
}

async function startDev(ws: Workspace, entry: Dev): Promise<string | null> {
  const tree = worktreePath(ws);
  let pkg: unknown;
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
  const who = identityOf(ws);
  const env: Record<string, string> = {};
  for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  env.HOME = who?.home || homedir();
  env.PORT = String(port);
  env.BROWSER = "none"; // no opening a browser on the server's desktop
  // detached: its own process group, so stop can kill the whole tree
  const child = spawn(cmd[0], cmd.slice(1), { cwd: tree, uid: who?.uid, gid: who?.gid, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  entry.child = child;
  child.on("exit", () => {
    if (devs.get(ws.id) === entry) devs.delete(ws.id);
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

  // stopped while it was starting: do not leave it running unowned
  if (!announced || devs.get(ws.id) !== entry) {
    if (child.pid) killGroup(child);
    return null;
  }
  entry.origin = `http://127.0.0.1:${announced}`;
  return entry.origin;
}

/** The address of the workspace's running dev server, or null when none runs or it is still starting. */
export function devServerOrigin(ws: Pick<Workspace, "id">): string | null {
  return devs.get(ws.id)?.origin ?? null;
}

/** Stop the workspace's dev server, if one runs. */
export function stopDevServer(ws: Pick<Workspace, "id">) {
  const entry = devs.get(ws.id);
  devs.delete(ws.id);
  if (entry?.child) killGroup(entry.child);
}

/** Stop every dev server this process started. Called as the server goes down: the dev servers are detached, so they would outlive it. */
export function stopAllDevServers() {
  for (const id of [...devs.keys()]) stopDevServer({ id });
}
