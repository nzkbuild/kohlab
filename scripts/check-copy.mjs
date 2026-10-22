#!/usr/bin/env bun
// Copies: committed history is kept, uncommitted work is left out, settings and notes carry over, chat and tokens do not.
// Only an owner may copy: a viewer and a keyless request are refused, and a name over 80 characters is a 400.
/**
 * Make a copy of a project. In-process for the copy itself (a throwaway repo, the
 * library functions), then a throwaway server for the gate: a viewer and a request
 * without the key are refused, and a name over 80 characters is a 400.
 *
 * Run: bun scripts/check-copy.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 7951;
const OWNER_KEY = "copy-check-key";

const tmp = mkdtempSync(join(tmpdir(), "kohlab-copy-"));
const works = join(tmp, "works");
mkdirSync(works, { recursive: true });
process.env.WORKS_DIR = works;
process.env.PTY_SOCKET = join(tmp, "pty.sock");
process.env.KOHLAB_KEY = OWNER_KEY;

const { createWorkspace, copyWorkspace, mutateState, addUser, worktreePath } = await import("../lib.ts");

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`);
}
const git = (cwd, ...args) => execFileSync("git", ["-c", "safe.directory=*", ...args], { cwd, encoding: "utf8" }).trim();

const server = [];
try {
  // A project with one commit, then a second committed file and one uncommitted file in its tree.
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "check@kohlab.test");
  git(repo, "config", "user.name", "check");
  writeFileSync(join(repo, "README.md"), "hello");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "start");

  const src = await createWorkspace({ repo, task: "Source project", agent: "sh" });
  const tree = worktreePath(src);
  git(tree, "config", "user.email", "check@kohlab.test");
  git(tree, "config", "user.name", "check");
  writeFileSync(join(tree, "committed.txt"), "kept");
  git(tree, "add", "-A");
  git(tree, "commit", "-q", "-m", "kept work");
  writeFileSync(join(tree, "uncommitted.txt"), "not kept");
  await mutateState((s) => {
    const w = s.workspaces.find((x) => x.id === src.id);
    w.model = "opus";
    w.notes = "Keep the header blue.";
    w.effort = "high";
    w.permissionMode = "plan";
    w.shareLink = { token: "share-secret", expires: null };
    w.previewToken = "preview-secret";
  });

  const copy = await copyWorkspace(src.id, "Source copy");
  const ctree = worktreePath(copy);
  check("copy is a new project with the new name", copy.id !== src.id && copy.task === "Source copy", `${copy.id} ${copy.task}`);
  check("committed work is in the copy", existsSync(join(ctree, "committed.txt")));
  check("uncommitted work is left out of the copy", !existsSync(join(ctree, "uncommitted.txt")));
  check("model, effort, permission mode and notes carry over", copy.model === "opus" && copy.effort === "high" && copy.permissionMode === "plan" && copy.notes === "Keep the header blue.");
  check("share link and preview token are not copied", copy.shareLink === undefined && copy.previewToken === undefined);
  check("a project that is not a chat stays a terminal project", !copy.chat);

  let tooLong = null;
  try {
    await copyWorkspace(src.id, "x".repeat(81));
  } catch (e) {
    tooLong = e.message;
  }
  check("a name over 80 characters is refused", tooLong !== null && /80/.test(tooLong), String(tooLong));
  let empty = null;
  try {
    await copyWorkspace(src.id, "   ");
  } catch (e) {
    empty = e.message;
  }
  check("an empty name is refused", empty !== null, String(empty));

  // Gate: a viewer and a keyless request are refused; the owner gets the copy.
  const viewer = await addUser({ id: "viewer-check", name: "Viewer", role: "viewer" });
  const port = PORT;
  const env = { ...process.env, PORT: String(port), KOHLAB_KEY: OWNER_KEY, WORKS_DIR: works, PTY_SOCKET: join(tmp, "pty.sock") };
  const srv = spawn("bun", ["run", "server.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  srv.stderr.on("data", (d) => (log += d));
  srv.stdout.on("data", (d) => (log += d));
  server.push(srv);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/api/auth/required`).then((r) => r.ok).catch(() => false);
    if (!up) await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) throw new Error("throwaway server did not start: " + log.slice(-600));
  const url = `http://127.0.0.1:${port}/api/workspaces/${src.id}/copy`;
  const post = (headers, name) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ name }) });

  const anon = await post({}, "Anon copy");
  check("no key: refused (401)", anon.status === 401, String(anon.status));
  const asViewer = await post({ authorization: `Bearer ${viewer.key}` }, "Viewer copy");
  check("viewer: refused (403)", asViewer.status === 403, String(asViewer.status));
  const long = await post({ authorization: `Bearer ${OWNER_KEY}` }, "x".repeat(81));
  check("owner, name over 80: 400", long.status === 400, String(long.status));
  const made = await post({ authorization: `Bearer ${OWNER_KEY}` }, "Route copy");
  const body = await made.json().catch(() => ({}));
  check("owner: copy made (200) and answers like a new workspace", made.status === 200 && typeof body.id === "string" && body.running === false && typeof body.path === "string", `${made.status} ${JSON.stringify(body).slice(0, 160)}`);
  check("a copy's answer has no share token", !JSON.stringify(body).includes("share-secret"));
} catch (e) {
  failures++;
  console.log(`FAIL  ${e.message}`);
} finally {
  for (const s of server) s.kill("SIGKILL");
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("pty-daemon.cjs")) continue;
      if (!readFileSync(`/proc/${pid}/environ`, "utf8").includes(`PTY_SOCKET=${join(tmp, "pty.sock")}`)) continue;
      process.kill(Number(pid), "SIGTERM");
    } catch {
      /* gone */
    }
  }
  rmSync(tmp, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall copy checks passed");
