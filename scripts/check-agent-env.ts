/**
 * Agent PTYs get CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 (lib.ts AGENT_PTY_ENV), so
 * Claude Code renders inline and the browser terminal can scroll it. Run:
 *   bun scripts/check-agent-env.ts
 *
 * Starts the real pty daemon on a throwaway socket, opens sessions the way
 * spawnAgentSession does, and reads back what the shell saw. KOHLAB_KEY in the
 * daemon's environment is a canary that must never reach a PTY, and a key
 * outside the request allowlist must be dropped.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WORKS_DIR = mkdtempSync(join(tmpdir(), "kohlab-cae-state-"));
const { AGENT_PTY_ENV } = await import("../lib");

const DAEMON = new URL("../pty-daemon.cjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "kohlab-cae-"));
const sock = join(dir, "pty.sock");
const CANARY = "canary-7f3a9c";
const EXTRA = "KOHLAB_EXTRA_CANARY";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const daemon = spawn("node", [DAEMON], {
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, PTY_SOCKET: sock, KOHLAB_KEY: CANARY },
  stdio: "ignore",
});

async function connect(): Promise<Socket> {
  for (let i = 0; i < 60; i++) {
    const s = await new Promise<Socket | null>((resolve) => {
      const c = createConnection(sock);
      c.once("connect", () => resolve(c));
      c.once("error", () => resolve(null));
    });
    if (s) return s;
    await sleep(100);
  }
  throw new Error("pty daemon never came up");
}

function request(s: Socket, msg: Record<string, unknown>, replyType: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`no ${replyType} from daemon`)), 5000);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.type === replyType) {
          clearTimeout(timer);
          s.off("data", onData);
          resolve(m);
        }
      }
    };
    s.on("data", onData);
    s.write(JSON.stringify(msg) + "\n");
  });
}

/** Open a session that prints its environment, wait for the end marker, return the output. */
async function envOf(s: Socket, id: string, env: Record<string, string>): Promise<string> {
  const open = await request(
    s,
    { type: "open", id, cwd: dir, cmd: ["sh", "-c", "env; echo ENV-DONE; sleep 2"], env, cols: 120, rows: 36 },
    "open-result",
  );
  if (open.error) throw new Error(`open ${id}: ${open.error}`);
  for (let i = 0; i < 60; i++) {
    const log = await request(s, { type: "log", id }, "log-reply");
    const text = Buffer.from(log.data, "base64").toString("utf8");
    if (text.includes("ENV-DONE")) return text;
    await sleep(100);
  }
  throw new Error(`${id}: shell never finished printing its environment`);
}

let failed: string[] = [];
let s: Socket | null = null;
try {
  s = await connect();
  const agent = await envOf(s, "cae-agent", AGENT_PTY_ENV);
  if (!agent.includes("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1")) failed.push("PTY env lacks CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1");
  if (agent.includes(CANARY)) failed.push("KOHLAB_KEY leaked into the PTY environment");

  const extra = await envOf(s, "cae-extra", { ...AGENT_PTY_ENV, [EXTRA]: "nope" });
  if (extra.includes(EXTRA)) failed.push("a key outside the request allowlist reached the PTY");
  if (!extra.includes("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1")) failed.push("allowlisted key dropped when sent with others");
} catch (e) {
  failed.push((e as Error).message);
} finally {
  s?.destroy();
  daemon.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
  rmSync(process.env.WORKS_DIR!, { recursive: true, force: true });
}

if (failed.length) {
  for (const f of failed) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log("  agent PTY env: alt-screen off, no secrets, allowlist enforced");
