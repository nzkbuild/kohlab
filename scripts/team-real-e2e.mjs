#!/usr/bin/env node
/**
 * Team mode with a REAL Claude. This spends the person's plan: it never runs in check-all, and it refuses to run
 * unless KOHLAB_REAL=1 is set. It starts a throwaway server on its own port, state and socket, on a throwaway repo.
 *
 *   KOHLAB_REAL=1 node scripts/team-real-e2e.mjs
 *
 * Goal: "add hello.txt and goodbye.txt, each one line, and a README listing them". Lead on sonnet (low effort), two
 * builders and a reviewer on haiku; 150k tokens and 6 minutes per agent; no tester. It asserts that two builders
 * overlapped, that both files merged and landed as uncommitted changes, and that the Lead was woken at most six times.
 * It prints the tokens each agent spent.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killDaemonOn } from "./kill-daemon.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const KEY = "team-e2e-key";
let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${!ok && detail ? `  ${String(detail).slice(0, 400)}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.KOHLAB_REAL !== "1") {
  console.log("refused: this run spends real AI quota. Set KOHLAB_REAL=1 to run it.");
  process.exit(2);
}

async function freePort() {
  const srv = createServer();
  const { promise, resolve } = Promise.withResolvers();
  srv.listen(0, "127.0.0.1", () => resolve(srv.address().port));
  const port = await promise;
  const closed = Promise.withResolvers();
  srv.close(closed.resolve);
  await closed.promise;
  return port;
}

const tmp = mkdtempSync(join(tmpdir(), "kohlab-teame2e-"));
const works = join(tmp, "works");
const socket = join(tmp, "pty.sock");
const repo = join(tmp, "repo");
mkdirSync(repo);
const git = (args, cwd = repo) => spawnSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@kohlab.local", ...args], { cwd, encoding: "utf8" });
git(["init", "-q"]);
writeFileSync(join(repo, "README.md"), "# e2e\n");
git(["add", "-A"]);
git(["commit", "-qm", "init"]);

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn("bun", ["run", "server.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: works, PTY_SOCKET: socket },
  stdio: ["ignore", "ignore", "ignore"],
});
const req = async (method, path, body) => {
  const res = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(KEY)}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, text };
};

try {
  for (let i = 0; i < 100 && !(await fetch(`${base}/api/auth/required`).then((r) => r.ok).catch(() => false)); i++) await sleep(200);
  const made = await req("POST", "/api/workspaces", { repo, agent: "claude", chat: true });
  const pid = made.body?.id;
  check("a project is created", typeof pid === "string", made.text.slice(0, 200));

  const started = await req("POST", `/api/workspaces/${pid}/team`, {
    action: "start",
    goal: "add hello.txt and goodbye.txt, each one line, and a README listing them",
    maxAgents: 2,
    builders: 2,
    reviewer: true,
    tester: false,
    gate: "final",
  });
  check("the team starts", started.status === 200, started.text.slice(0, 200));
  // the models and the budgets are the defaults of the Team's roles (team-store.ts); the Lead gets sonnet, low effort
  await req("POST", `/api/workspaces/${pid}/team`, { action: "role", role: "lead", model: "sonnet", effort: "low", budget: { tokens: 150000, minutes: 6 } });
  for (const role of ["builder-1", "builder-2", "reviewer"]) {
    await req("POST", `/api/workspaces/${pid}/team`, { action: "role", role, model: "haiku", budget: { tokens: 150000, minutes: 6 } });
  }

  let maxWorking = 0;
  let view = null;
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline) {
    view = (await req("GET", `/api/workspaces/${pid}/team?after=0`)).body?.team ?? null;
    if (view) {
      maxWorking = Math.max(maxWorking, view.roles.filter((r) => r.state === "working").length);
      if (view.status === "awaiting_approval" || view.status === "done" || view.status === "stopped") break;
    }
    await sleep(3000);
  }
  check("the team reaches awaiting approval", view?.status === "awaiting_approval", view?.status);
  check("two builders overlapped", maxWorking >= 2, `saw ${maxWorking} working at once`);

  const landed = await req("POST", `/api/workspaces/${pid}/team`, { action: "land" });
  check("landing brings the work in", landed.status === 200 && landed.body?.ok === true, landed.text.slice(0, 200));
  const tree = join(works, pid, "tree");
  const status = git(["status", "--porcelain"], tree).stdout;
  check("hello.txt and goodbye.txt landed as uncommitted changes", status.includes("hello.txt") && status.includes("goodbye.txt"), status);
  check("the README lists them", existsSync(join(tree, "README.md")) && /hello\.txt/.test(readFileSync(join(tree, "README.md"), "utf8")) && /goodbye\.txt/.test(readFileSync(join(tree, "README.md"), "utf8")));
  check("the Lead was woken at most six times", (view?.wakes ?? 99) <= 6, `wakes ${view?.wakes}`);

  for (const r of view?.roles ?? []) console.log(`      ${r.name}: ${r.spent.tokens} tokens, ${r.spent.turns} turns`);
} finally {
  server.kill("SIGKILL");
  killDaemonOn(socket);
  rmSync(tmp, { recursive: true, force: true });
}
if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall real team checks passed");
