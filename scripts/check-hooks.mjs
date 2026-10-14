// Claude Code hooks: a terminal project's status comes from its agent, not from
// whether its process is alive.
//
// Claude sits idle at its prompt after it finishes, and a process check alone
// reads that as "Working" forever and never as "needs you". The hook settings
// spawnAgentSession writes (outside the worktree) call back into POST
// /api/hook/:id with a per-workspace token. This checks the callback contract:
//   1. The settings file lands outside the worktree and carries the right URL.
//   2. A wrong token is refused.
//   3. A permission prompt reads as waiting; Stop ends the run while the process
//      stays alive; the next prompt starts it again.
//   4. The worktree stays clean: the settings file is never written into it.
//   5. A run that a Stop hook ended and whose process later exits is notified once.
import { spawn, spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { killDaemonOn } from "./kill-daemon.mjs";

const PORT = 7818;
const HOOK_PORT = 7819;
const KEY = "hooks-check-key";
const dir = mkdtempSync(join(tmpdir(), "kohlab-hooks-"));
const repo = join(dir, "repo");
const bin = join(dir, "bin");
const argvFile = join(dir, "agent-argv.txt");
const pidFile = join(dir, "agent-pid.txt");
let failures = 0;

function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

function note(text) {
  console.log(`      ${text}`);
}

// Its own socket, always: without one the throwaway server adopts the daemon of
// a real instance on this machine.
const SOCKET = join(tmpdir(), `kohlab-hooks-${process.pid}.sock`);
const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: "127.0.0.1",
  KOHLAB_KEY: KEY,
  WORKS_DIR: dir,
  PTY_SOCKET: SOCKET,
  WATCH_INTERVAL: "200",
  NOTIFY_WEBHOOK: `http://127.0.0.1:${HOOK_PORT}/`,
};

function server() {
  const proc = spawn("bun", ["run", "server.ts"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (b) => (log += b));
  proc.stderr.on("data", (b) => (log += b));
  return { proc, getLog: () => log };
}

const base = `http://127.0.0.1:${PORT}`;
const auth = { authorization: `Bearer ${KEY}` };
const jsonAuth = { ...auth, "content-type": "application/json" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function up() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* not listening yet */
    }
    await wait(250);
  }
  throw new Error("server never came up");
}

const api = async (path, opts = {}) => {
  const res = await fetch(`${base}${path}`, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};

function gitSync(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

// The webhook the server posts when a run ends: counts the completions it hears of.
const webhookHits = [];
const hookSink = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    webhookHits.push(JSON.parse(body || "{}"));
    res.writeHead(204).end();
  });
});

console.log("kohlab agent hooks\n");

// ── setup: a real repository, and a fake `claude` that records its arguments ──
mkdirSync(repo, { recursive: true });
gitSync(repo, ["-c", "init.defaultBranch=main", "init", "--quiet"]);
writeFileSync(join(repo, "readme.md"), "original\n");
gitSync(repo, ["add", "-A"]);
gitSync(repo, ["-c", "user.email=t@kohlab.local", "-c", "user.name=test", "commit", "--quiet", "-m", "initial"]);
mkdirSync(bin, { recursive: true });
const fakeClaude = join(bin, "claude");
// It must be named `claude`: the hook settings are only written for that command.
// The `exec` keeps the pid, so the check can end the process itself later.
writeFileSync(
  fakeClaude,
  ["#!/bin/sh", `echo "$@" > '${argvFile}'`, `echo $$ > '${pidFile}'`, "exec sleep 317", ""].join("\n"),
);
chmodSync(fakeClaude, 0o755);

let s = null;
let hooked = null;
try {
  hookSink.listen(HOOK_PORT, "127.0.0.1");
  s = server();
  await up();

  await api("/api/agents", {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify({ name: "claude", cmd: fakeClaude }),
  });

  const created = await api("/api/workspaces", {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify({ task: "hooks check", repo, agent: "claude" }),
  });
  const id = created.body?.id;
  check("a workspace can be created from a local repo", typeof id, "string");
  if (!id) throw new Error("no workspace id, cannot continue");

  const porcelain = gitSync(repo, ["worktree", "list", "--porcelain"]);
  const wanted = porcelain.split("\n\n").find((b) => b.includes(`kohlab/${id}`));
  const tree = wanted?.split("\n").find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
  if (!tree) throw new Error("no worktree for the workspace, cannot continue");

  const started = await api(`/api/workspaces/${id}/start`, { method: "POST", headers: jsonAuth });
  check("start returns ok", started.status, 200);

  // ── 1. the settings file: outside the worktree, pointing at this workspace ──
  const hooksFile = join(dir, id, "kohlab-hooks.json");
  check("the hook settings file is written", existsSync(hooksFile), true);
  check("and it is outside the worktree", hooksFile.startsWith(tree), false);
  const settings = existsSync(hooksFile) ? JSON.parse(readFileSync(hooksFile, "utf8")) : {};
  const command = settings.hooks?.Stop?.[0]?.hooks?.[0]?.command ?? "";
  check(
    "every hook event is wired",
    ["UserPromptSubmit", "Notification", "PostToolUse", "Stop"].every((e) => Array.isArray(settings.hooks?.[e])),
    true,
  );
  check("its curl posts to this workspace's hook URL", command.includes(`'${base}/api/hook/${id}'`), true);
  const token = command.match(/x-kohlab-hook: ([\w-]+)/)?.[1];
  check("and carries the hook token", typeof token, "string");
  note(`hook command: ${command}`);

  // The agent really was started with the settings.
  await wait(300);
  const argv = existsSync(argvFile) ? readFileSync(argvFile, "utf8") : "";
  check("the agent is started with --settings pointing at that file", argv.includes(`--settings ${hooksFile}`), true);

  // ── 2. a wrong token is refused, the same way a missing workspace is ──────
  const hook = (body, tok = token) =>
    fetch(`${base}/api/hook/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-kohlab-hook": tok },
      body: JSON.stringify(body),
    }).then((r) => r.status);
  const row = async () => (await api("/api/workspaces", { headers: auth })).body.find((w) => w.id === id) ?? {};

  check("a wrong token is refused", await hook({ hook_event_name: "Stop" }, "not-the-token"), 404);
  check("a missing token is refused", await hook({ hook_event_name: "Stop" }, ""), 404);
  check(
    "a bad workspace id is refused",
    (await fetch(`${base}/api/hook/no-such-ws`, { method: "POST", headers: { "content-type": "application/json", "x-kohlab-hook": token }, body: "{}" })).status,
    404,
  );
  check("a refused Stop did not end the run", (await row()).running, true);

  // ── 3. waiting, ended, and started again ─────────────────────────────────
  check(
    "a permission prompt is accepted",
    await hook({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }),
    204,
  );
  let r = await row();
  check("the permission prompt shows as waiting", r.waiting, true);
  check("and the run still counts as running", r.running, true);

  check("Stop is accepted", await hook({ hook_event_name: "Stop" }), 204);
  r = await row();
  check("Stop clears the waiting question", r.waiting, false);
  check("Stop ends the run in the UI, while the process is alive", r.running, false);
  check("Stop records when the run stopped", typeof r.stopped, "number");
  const health = await api("/api/health", { headers: auth });
  check("the agent process is still alive after Stop", health.body.workspaces?.running, 1);

  check("a prompt is accepted", await hook({ hook_event_name: "UserPromptSubmit", prompt: "again" }), 204);
  r = await row();
  check("the next prompt makes it running again", r.running, true);
  check("and clears the stop", r.stopped, null);

  // ── 4. the worktree is untouched by all of this ──────────────────────────
  check("the worktree is still clean", gitSync(tree, ["status", "--porcelain"]).trim(), "");

  // ── 5. the run a Stop hook ended is notified once, not again when the process exits
  check("Stop notified the run as done", webhookHits.length >= 1, true);
  await hook({ hook_event_name: "Stop" });
  await wait(300);
  const doneBefore = webhookHits.filter((h) => h.id === id).length;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  process.kill(pid, "SIGTERM");
  await wait(1500);
  const doneAfter = webhookHits.filter((h) => h.id === id).length;
  check("the process exiting later does not notify the run a second time", doneAfter, doneBefore);
  note(`completions heard: ${doneBefore} before exit, ${doneAfter} after`);
} catch (e) {
  failures++;
  console.log(`FAIL  ${e.message}`);
} finally {
  hookSink.close();
  if (s) {
    s.proc.kill("SIGTERM");
    await wait(300);
    if (failures) console.log(`\n--- server log ---\n${s.getLog().slice(-2000)}`);
  }
  killDaemonOn(SOCKET);
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall agent hook checks passed");
process.exit(failures ? 1 : 0);
