#!/usr/bin/env node
/**
 * Push messages stay out of terminals: a socket that attached to a session gets
 * raw bytes only, while a dashboard socket still hears that a workspace finished.
 * (The done JSON used to be printed into every open terminal.)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let failed = 0;
const check = (name, ok) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };
const PORT = 7861, KEY = "dk", dir = mkdtempSync(join(tmpdir(), "done-"));
const repo = join(dir, "repo");
spawnSync("git", ["init", "-q", "-b", "main", repo]);
spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "s"]);
const proc = spawn("bun", ["run", "server.ts"], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: join(dir, "w"), PTY_SOCKET: join(tmpdir(), `done-${process.pid}.sock`) }, stdio: "ignore" });
const api = (p, body) => fetch(`http://127.0.0.1:${PORT}${p}?key=${KEY}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}).then(r => r.json());
try {
  for (let i = 0; i < 80; i++) { if (await fetch(`http://127.0.0.1:${PORT}/api/health`).then(r => r.ok, () => false)) break; await new Promise(r => setTimeout(r, 250)); }
  const ws = await api("/api/workspaces", { repo, task: "t", agent: "sh" });
  await api(`/api/workspaces/${ws.id}/start`, {});
  const term = new WebSocket(`ws://127.0.0.1:${PORT}/?key=${KEY}`), push = new WebSocket(`ws://127.0.0.1:${PORT}/?key=${KEY}`);
  let termOut = "", pushOut = "";
  term.onmessage = e => termOut += e.data; push.onmessage = e => pushOut += e.data;
  await new Promise(r => term.onopen = r); await new Promise(r => push.onopen = r);
  term.send(JSON.stringify({ type: "attach", id: ws.id, terminalId: "main" }));
  await new Promise(r => setTimeout(r, 1500));
  term.send("exit\r");
  await new Promise(r => setTimeout(r, 8000));
  check("a terminal socket is not sent the done message", !termOut.includes("workspace.done"));
  check("a dashboard socket still is", pushOut.includes("workspace.done"));
} finally { proc.kill("SIGKILL"); spawnSync("pkill", ["-f", `done-${process.pid}.sock`]); }
process.exit(failed ? 1 : 0);
