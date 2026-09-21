// The review gate: accept or discard.
//
// Kohlab's pitch is that a finished workspace is something you "accept or
// discard", and for several releases only accept existed. The sole way to say no
// was to delete the workspace, its worktree and its branch, so rejecting an
// attempt cost far more than accepting one. This checks both halves.
//
// Three properties matter beyond the happy path:
//   1. Discard removes the agent's work AND keeps the workspace. `git reset
//      --hard` alone leaves new files behind, so untracked paths are the half a
//      naive implementation gets wrong.
//   2. Discard refuses while the agent is still running. A reset under a live
//      writer leaves neither the agent's work nor the branch's.
//   3. Commit still works. Adding the inverse of an action is exactly the kind
//      of change that breaks it.
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PORT = 7805;
const KEY = "review-gate-check-key";
const dir = mkdtempSync(join(tmpdir(), "kohlab-gate-"));
const repo = join(dir, "repo");
let failures = 0;

function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${got}, wanted ${want})`}`);
}

function note(text) {
  console.log(`      ${text}`);
}

// Its own socket, always: without one the throwaway server adopts the daemon of
// a real instance on this machine, which would make this check depend on, and
// able to disturb, something it was never meant to touch.
const SOCKET = join(tmpdir(), `kohlab-gate-${process.pid}.sock`);
const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: "127.0.0.1",
  KOHLAB_KEY: KEY,
  WORKS_DIR: dir,
  PTY_SOCKET: SOCKET,
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
  // Only used for setup and assertions, where a failure should be loud.
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

console.log("kohlab review gate\n");

// ── setup: a real repository, so a real worktree can be made from it ─────────
mkdirSync(repo, { recursive: true });
gitSync(repo, ["-c", "init.defaultBranch=main", "init", "--quiet"]);
writeFileSync(join(repo, "readme.md"), "original\n");
gitSync(repo, ["add", "-A"]);
gitSync(repo, ["-c", "user.email=t@kohlab.local", "-c", "user.name=test", "commit", "--quiet", "-m", "initial"]);

let s = null;
try {
  s = server();
  await up();

  // The agent command has to exist before a workspace can name it.
  await api("/api/agents", {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify({ name: "sh", cmd: "sh" }),
  });

  const created = await api("/api/workspaces", {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify({ task: "gate check", repo, agent: "sh" }),
  });
  const id = created.body?.id;
  check("a workspace can be created from a local repo", typeof id, "string");
  if (!id) throw new Error("no workspace id, cannot continue");

  // Discover the worktree from git rather than guessing the layout: the server
  // decides where it lives, and a test that hardcodes the path silently checks
  // the wrong directory when that changes.
  const porcelain = gitSync(repo, ["worktree", "list", "--porcelain"]);
  const blocks = porcelain.split("\n\n");
  const wanted = blocks.find((b) => b.includes(`kohlab/${id}`));
  const tree = wanted?.split("\n").find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
  check("its worktree exists", typeof tree === "string" && existsSync(tree), true);
  note(`worktree: ${tree}`);
  if (!tree) throw new Error("no worktree for the workspace, cannot continue");

  // ── the agent's work: one modified file, one new file ─────────────────────
  writeFileSync(join(tree, "readme.md"), "the agent rewrote this\n");
  writeFileSync(join(tree, "agent-note.md"), "the agent made this\n");
  const dirty = gitSync(tree, ["status", "--porcelain"]).trim();
  check("the worktree is dirty before the decision", dirty.length > 0, true);
  note(`git status --porcelain: ${JSON.stringify(dirty)}`);

  // ── accept still works ───────────────────────────────────────────────────
  const committed = await api(`/api/workspaces/${id}/commit`, {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify({ message: "accept it" }),
  });
  check("commit (accept) is still ok", committed.status, 200);
  check(
    "the commit landed on the workspace's own branch",
    gitSync(tree, ["log", "--oneline", "-1"]).includes("accept it"),
    true,
  );
  const clean = gitSync(tree, ["status", "--porcelain"]).trim();
  check("and the tree is clean afterwards", clean, "");

  // ── discard: the half that did not exist ─────────────────────────────────
  writeFileSync(join(tree, "readme.md"), "a second attempt\n");
  writeFileSync(join(tree, "second-attempt.md"), "discard me\n");
  check("the tree is dirty again", gitSync(tree, ["status", "--porcelain"]).trim().length > 0, true);

  const discarded = await api(`/api/workspaces/${id}/discard`, { method: "POST", headers: jsonAuth });
  check("discard returns ok", discarded.status, 200);
  check("discard reports success", discarded.body?.ok, true);

  check(
    "a tracked file is reverted to the branch's content",
    readFileSync(join(tree, "readme.md"), "utf8"),
    "the agent rewrote this\n",
  );
  check(
    "an untracked file is removed, which reset --hard alone would not do",
    existsSync(join(tree, "second-attempt.md")),
    false,
  );
  check("the tree is clean after discard", gitSync(tree, ["status", "--porcelain"]).trim(), "");

  const list = await api("/api/workspaces", { headers: auth });
  check(
    "the workspace itself survives, which is the whole point",
    Array.isArray(list.body) && list.body.some((w) => w.id === id),
    true,
  );
  check(
    "its branch is still there, so it can run again",
    gitSync(repo, ["branch", "--list", `kohlab/${id}`]).includes(`kohlab/${id}`),
    true,
  );

  // ── the guard: never reset under a live writer ───────────────────────────
  const started = await api(`/api/workspaces/${id}/start`, { method: "POST", headers: jsonAuth });
  check("the workspace can be started", started.status, 200);
  await wait(1500);
  const refusal = await api(`/api/workspaces/${id}/discard`, { method: "POST", headers: jsonAuth });
  check("discard while the agent is running is refused", refusal.status, 400);
  check(
    "and the refusal says what to do about it",
    typeof refusal.body?.error === "string" && /stop the workspace/i.test(refusal.body.error),
    true,
  );
  note(`refusal: ${JSON.stringify(refusal.body?.error)}`);
  await api(`/api/workspaces/${id}/stop`, { method: "POST", headers: jsonAuth });
  await wait(500);

  // ── it is auditable, because it destroys work ────────────────────────────
  const audit = await api("/api/audit", { headers: auth });
  const events = Array.isArray(audit.body?.events) ? audit.body.events : [];
  check(
    "discard is recorded in the audit trail",
    events.some((e) => e.action === "discard" && e.id === id),
    true,
  );
} catch (e) {
  failures++;
  console.log(`FAIL  threw: ${e.message}`);
  if (s) console.log(s.getLog().split("\n").slice(-15).join("\n"));
} finally {
  if (s) s.proc.kill("SIGKILL");
  await wait(300);
  rmSync(dir, { recursive: true, force: true });
  rmSync(SOCKET, { force: true });
}

console.log(`\n${failures === 0 ? "all review-gate checks passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
