#!/usr/bin/env node
/**
 * Change Kohlab itself (v2.9), over HTTP through the real server on its own port, state and socket.
 *
 * Nothing real is touched: the "origin" is a local bare repo (KOHLAB_ORIGIN_OVERRIDE), and `gh` on PATH is a fake that
 * records its argv and answers from a state file. No network, no GitHub, no live server.
 *
 *  - project: the owner's project is a chat on kohlab/<id>, made from origin/main, flagged kohlab; a member and an
 *    anonymous caller are refused (403, 401)
 *  - release state: ahead, behind, dirty, versions, CHANGELOG touched, the PR and its checks, the live count
 *  - open refusals: nothing ahead, version unchanged, uncommitted changes, main moved on with a conflict (merge undone)
 *  - open: merges main in, pushes kohlab/<id> to the bare origin, gh pr create with the expected argv (title, body, base)
 *  - merge refused while checks are pending or failing; then gh pr merge --squash --delete-branch; the branch lands on main
 *  - a plain project has no release routes (404); the chat prompt line (a plain chat) and block (a Kohlab project)
 *  - no response carries a URL with credentials; the URL and message helpers strip them
 *
 * Run:  node scripts/check-kohlab.mjs    (bun, since lib.ts is TypeScript)
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killDaemonOn } from "./kill-daemon.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const KEY = "kohlab-check-key";
const SECRET = "SECRETTOKEN123";
let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${!ok && detail ? `  ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return true;
    await sleep(120);
  }
  return false;
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
const enc = encodeURIComponent;

const tmp = mkdtempSync(join(tmpdir(), "kohlab-kohlabcheck-"));
const fakeDir = join(tmp, "fake-bin");
const works = join(tmp, "works");
const socket = join(tmp, "pty.sock");
const origin = join(tmp, "origin.git");
const seed = join(tmp, "seed");
const pusher = join(tmp, "pusher");
const plain = join(tmp, "plain");
const ghState = join(tmp, "gh-state.json");
const ghLog = join(tmp, "gh-argv.log");
mkdirSync(fakeDir);

const GITENV = { ...process.env, GIT_AUTHOR_NAME: "kohlab check", GIT_AUTHOR_EMAIL: "check@kohlab.test", GIT_COMMITTER_NAME: "kohlab check", GIT_COMMITTER_EMAIL: "check@kohlab.test" };
const git = (cwd, args) => execFileSync("git", ["-c", "safe.directory=*", ...args], { cwd, encoding: "utf8", env: GITENV }).trim();
const gitOk = (cwd, args) => spawnSync("git", ["-c", "safe.directory=*", ...args], { cwd, encoding: "utf8", env: GITENV }).status === 0;
const write = (file, text) => writeFileSync(file, text);
const read = (file) => readFileSync(file, "utf8");

// The fake gh: records its argv, and answers `pr list` (filtered by --head), `pr create` and `pr merge` from the state file.
writeFileSync(
  join(fakeDir, "gh"),
  `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
const file = process.env.FAKE_GH_STATE;
const s = JSON.parse(fs.readFileSync(file, "utf8"));
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const [a, b] = args;
if (a === "pr" && b === "list") {
  const head = args[args.indexOf("--head") + 1];
  // headRefOid: the sha of the branch in the bare origin, as GitHub would say
  const sha = (h) => { try { return require("child_process").execFileSync("git", ["--git-dir", process.env.FAKE_ORIGIN, "rev-parse", "refs/heads/" + h], { encoding: "utf8" }).trim(); } catch { return ""; } };
  process.stdout.write(JSON.stringify(s.prs.filter((p) => p.head === head).map((p) => ({ ...p, headRefOid: sha(p.head) }))));
} else if (a === "pr" && b === "create") {
  const head = args[args.indexOf("--head") + 1];
  const n = s.prs.length + 1;
  s.prs.unshift({ number: n, url: "https://github.example/pull/" + n, state: "OPEN", head, statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" }] });
  save();
  process.stdout.write("https://github.example/pull/" + n + "\\n");
} else if (a === "pr" && b === "merge") {
  const p = s.prs.find((x) => x.number === Number(args[2]));
  if (!p) { process.stderr.write("no such pull request\\n"); process.exit(1); }
  const want = (args.find((x) => x.startsWith("--match-head-commit=")) || "").split("=")[1];
  const have = require("child_process").execFileSync("git", ["--git-dir", process.env.FAKE_ORIGIN, "rev-parse", "refs/heads/" + p.head], { encoding: "utf8" }).trim();
  if (want !== have) { process.stderr.write("head moved\\n"); process.exit(1); }
  p.state = "MERGED";
  save();
} else {
  process.stderr.write("fake gh: not in the check\\n");
  process.exit(2);
}
`,
);
chmodSync(join(fakeDir, "gh"), 0o755);
write(ghState, JSON.stringify({ prs: [] }));

const setChecks = (head, rollup) => {
  const s = JSON.parse(read(ghState));
  s.prs.find((p) => p.head === head).statusCheckRollup = rollup;
  write(ghState, JSON.stringify(s));
};
const ghCalls = () => (existsSync(ghLog) ? read(ghLog).split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// The origin: a bare repo with main (1.0.0 and a CHANGELOG), and a pusher clone that stands in for other people.
git(tmp, ["init", "--bare", "-q", "origin.git"]);
git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
mkdirSync(seed);
git(seed, ["init", "-q", "-b", "main"]);
write(join(seed, "README.md"), "# check\n");
write(join(seed, "package.json"), JSON.stringify({ name: "kohlab", version: "1.0.0" }, null, 2) + "\n");
write(join(seed, "CHANGELOG.md"), "# Changelog\n\n## [1.0.0] - 2026-01-01\n\n- First.\n");
git(seed, ["add", "-A"]);
git(seed, ["commit", "-qm", "init"]);
git(seed, ["remote", "add", "origin", origin]);
git(seed, ["push", "-q", "origin", "main"]);
const seedSha = git(seed, ["rev-parse", "main"]);
git(tmp, ["clone", "-q", origin, pusher]);
/** Another person's commit on main, pushed to the origin. */
function pushMain(file, text, subject) {
  write(join(pusher, file), text);
  git(pusher, ["add", "-A"]);
  git(pusher, ["commit", "-qm", subject]);
  git(pusher, ["push", "-q", "origin", "HEAD:main"]);
}
mkdirSync(plain);
git(plain, ["init", "-q", "-b", "main"]);
write(join(plain, "README.md"), "# plain\n");
git(plain, ["add", "-A"]);
git(plain, ["commit", "-qm", "init"]);

// The helpers the check's own logic uses, in-process (lib.ts reads WORKS_DIR when it is first imported).
process.env.WORKS_DIR = join(tmp, "unit-works");
mkdirSync(process.env.WORKS_DIR, { recursive: true });
const K = await import("../kohlab.ts");

// ── pure rules ──
check("the origin's credentials come out", K.withoutUserinfo(`https://x-access-token:${SECRET}@github.com/nzkbuild/kohlab`) === "https://github.com/nzkbuild/kohlab");
check("an ssh address keeps its user", K.withoutUserinfo("git@github.com:nzkbuild/kohlab.git") === "git@github.com:nzkbuild/kohlab.git");
check("owner/name from https", K.repoSlug("https://github.com/nzkbuild/kohlab") === "nzkbuild/kohlab");
check("owner/name from git@ with .git", K.repoSlug("git@github.com:nzkbuild/kohlab.git") === "nzkbuild/kohlab");
check("a message keeps no credentials", !K.scrub(`fatal: unable to access 'https://u:${SECRET}@github.com/a/b'`).includes(SECRET));
check("no checks: none", K.checksOf([]) === "none");
check("completed and successful: passing", K.checksOf([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }]) === "passing");
check("still running: pending", K.checksOf([{ status: "IN_PROGRESS", conclusion: "" }]) === "pending");
check("a status still pending: pending", K.checksOf([{ state: "PENDING" }]) === "pending");
check("a failure beats a running check", K.checksOf([{ status: "COMPLETED", conclusion: "FAILURE" }, { status: "IN_PROGRESS" }]) === "failing");
const CL = "# Changelog\n\n## [1.1.0] - 2026-11-17\n\n- Tweaked the readme.\n\n## [1.0.0] - 2026-01-01\n\n- First.\n";
check("the PR body is the version's section only", K.changelogSection(CL, "1.1.0") === "- Tweaked the readme.");
check("an unknown version has no body", K.changelogSection(CL, "9.9.9") === "");
check("no origin override: no origin", (await spawnNoOrigin()) === "null");

/** kohlabOrigin() with KOHLAB_ORIGIN_OVERRIDE set to nothing, in its own process (it is read once). */
async function spawnNoOrigin() {
  const snippet = `process.env.WORKS_DIR=${JSON.stringify(join(tmp, "unit-works2"))}; (async () => { const K = await import(${JSON.stringify(join(ROOT, "kohlab.ts"))}); process.stdout.write(String(K.kohlabOrigin())); })();`;
  const p = spawnSync(process.execPath, ["-e", snippet], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, KOHLAB_ORIGIN_OVERRIDE: "" },
  });
  return p.stdout.trim();
}

// ── the throwaway server ──
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let server = null;
let serverLog = "";
const JSON_HEADERS = { "content-type": "application/json" };
const seen = []; // every response body, for the credentials scan

async function call(method, path, { key = KEY, body } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${BASE}${path}${key === null ? "" : `${sep}key=${enc(key)}`}`;
  const res = await fetch(url, { method, headers: body ? JSON_HEADERS : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  seen.push(text);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, text };
}
const RELEASE = (id) => `/api/workspaces/${id}/release`;
const treeOf = (id) => join(works, id, "tree");

try {
  server = spawn("bun", ["run", "server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      KOHLAB_KEY: KEY,
      WORKS_DIR: works,
      PTY_SOCKET: socket,
      KOHLAB_ORIGIN_OVERRIDE: origin,
      PATH: `${fakeDir}:${process.env.PATH}`,
      FAKE_GH_STATE: ghState,
      FAKE_GH_LOG: ghLog,
      FAKE_ORIGIN: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  const up = await waitFor(() => fetch(`${BASE}/api/auth/required`).then((r) => r.ok), 20000);
  if (!up) throw new Error(`throwaway server did not start:\n${serverLog.slice(-800)}`);

  const invite = async (id, role) => {
    const invited = await call("POST", "/api/invites", { body: { id, name: id, role } });
    const token = (invited.body?.path ?? "").split("#")[1];
    const joined = await fetch(`${BASE}/api/join`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token }) }).then((r) => r.json());
    return joined.key;
  };
  const memberKey = await invite("kohlab-member", "member");

  // ── project creation ──
  const p1 = await call("POST", "/api/kohlab/project", { body: {} });
  const P1 = p1.body?.id;
  check("the owner starts a Change Kohlab project", p1.status === 200 && typeof P1 === "string", `${p1.status} ${p1.text.slice(0, 160)}`);
  check("it is a chat named Change Kohlab, flagged kohlab", p1.body?.chat === true && p1.body?.kohlab === true && p1.body?.task === "Change Kohlab", p1.text.slice(0, 200));
  check("its branch is kohlab/<id>, made from origin/main", P1 && git(treeOf(P1), ["rev-parse", "--abbrev-ref", "HEAD"]) === `kohlab/${P1}` && git(treeOf(P1), ["rev-parse", "HEAD"]) === seedSha);
  const p2 = await call("POST", "/api/kohlab/project", { body: { name: "Second look" } });
  const P2 = p2.body?.id;
  check("a second project takes the name it is given", p2.status === 200 && p2.body?.task === "Second look" && P2 !== P1, p2.text.slice(0, 160));
  const member = await call("POST", "/api/kohlab/project", { key: memberKey, body: {} });
  check("a member cannot start one (403)", member.status === 403, `${member.status} ${member.text.slice(0, 120)}`);
  const anon = await call("POST", "/api/kohlab/project", { key: null, body: {} });
  check("no credentials cannot start one (401)", anon.status === 401, `${anon.status}`);
  check("a member cannot read a release (403)", (await call("GET", RELEASE(P1), { key: memberKey })).status === 403);

  // The AI's account must not change the shared clone's config or hooks (they run as root during release).
  const srcGit = join(works, "clones", "kohlab-source", ".git");
  const asAgent = (script) => spawnSync("su", ["-s", "/bin/sh", "kohlab-agent", "-c", script], { encoding: "utf8" }).status;
  if (spawnSync("id", ["kohlab-agent"]).status === 0 && existsSync(srcGit)) {
    check("the AI's account cannot write the shared clone's config", asAgent(`echo x >> '${srcGit}/config'`) !== 0);
    check("the AI's account cannot add a hook", asAgent(`echo x > '${srcGit}/hooks/pre-push'`) !== 0);
  }

  // ── P1: the release state and the refusals ──
  const s0 = await call("GET", RELEASE(P1));
  check("a fresh project: nothing ahead or behind, version 1.0.0", s0.status === 200 && s0.body.ahead === 0 && s0.body.behind === 0 && s0.body.dirty === false && s0.body.version === "1.0.0" && s0.body.base?.version === "1.0.0", s0.text.slice(0, 300));
  check("no PR yet, and the live count is a number", s0.body.pr === null && typeof s0.body.live?.behind === "number" && s0.body.changelogTouched === false, s0.text.slice(0, 300));
  check("branch named in the state", s0.body.branch === `kohlab/${P1}`);
  const nothing = await call("POST", RELEASE(P1), { body: { action: "open" } });
  check("open refused with nothing ahead", nothing.status === 409 && nothing.body.error === "Nothing to release yet.", nothing.text.slice(0, 160));

  write(join(treeOf(P1), "README.md"), "# check\n\nTweaked.\n");
  git(treeOf(P1), ["add", "-A"]);
  git(treeOf(P1), ["commit", "-qm", "tweak readme"]);
  const unbumped = await call("POST", RELEASE(P1), { body: { action: "open" } });
  check("open refused while the version is unchanged", unbumped.status === 409 && unbumped.body.error === "Bump the version and add a CHANGELOG entry first.", unbumped.text.slice(0, 160));

  write(join(treeOf(P1), "scratch.txt"), "not committed\n");
  const dirty = await call("POST", RELEASE(P1), { body: { action: "open" } });
  check("open refused with uncommitted changes", dirty.status === 409 && dirty.body.error === "Keep or undo the changes first.", dirty.text.slice(0, 160));
  check("the state says dirty", (await call("GET", RELEASE(P1))).body.dirty === true);
  rmSync(join(treeOf(P1), "scratch.txt"));

  // P2 is made ready now and its README overlaps a change main gets later.
  write(join(treeOf(P2), "README.md"), "# check\n\nSecond look.\n");
  write(join(treeOf(P2), "package.json"), JSON.stringify({ name: "kohlab", version: "1.1.0" }, null, 2) + "\n");
  write(join(treeOf(P2), "CHANGELOG.md"), "# Changelog\n\n## [1.1.0] - 2026-11-17\n\n- Second look.\n\n## [1.0.0] - 2026-01-01\n\n- First.\n");
  git(treeOf(P2), ["add", "-A"]);
  git(treeOf(P2), ["commit", "-qm", "release v1.1.0: second look"]);

  write(join(treeOf(P1), "package.json"), JSON.stringify({ name: "kohlab", version: "1.1.0" }, null, 2) + "\n");
  write(join(treeOf(P1), "CHANGELOG.md"), CL);
  git(treeOf(P1), ["add", "-A"]);
  git(treeOf(P1), ["commit", "-qm", "release v1.1.0: tweak the readme"]);
  const ready = await call("GET", RELEASE(P1));
  check("ready: two ahead, version 1.1.0 against 1.0.0, CHANGELOG touched", ready.body.ahead === 2 && ready.body.version === "1.1.0" && ready.body.base.version === "1.0.0" && ready.body.changelogTouched === true && ready.body.behind === 0, ready.text.slice(0, 300));

  // ── main moves on (no overlap for P1) ──
  pushMain("OTHER.md", "other\n", "add other");
  const moved = await call("GET", RELEASE(P1));
  check("polling reuses a fetch from the last seconds: not behind yet", moved.body.behind === 0, moved.text.slice(0, 200));

  // ── open P1: merge main in, push, open the PR ──
  const opened = await call("POST", RELEASE(P1), { body: { action: "open" } });
  check("open sends it: 200 with an open PR, checks pending", opened.status === 200 && opened.body.pr?.state === "open" && opened.body.pr?.checks === "pending" && opened.body.pr?.number === 1, opened.text.slice(0, 300));
  const remoteHead = git(join(tmp), ["ls-remote", origin, `refs/heads/kohlab/${P1}`]).split("\t")[0];
  check("the branch reached the origin at the project's HEAD", remoteHead === git(treeOf(P1), ["rev-parse", "HEAD"]), `${remoteHead}`);
  check("main is merged into the branch (the tree has OTHER.md)", existsSync(join(treeOf(P1), "OTHER.md")));
  check("open fetched fresh and merged main in: not behind", (await call("GET", RELEASE(P1))).body.behind === 0);
  const slug = K.repoSlug(origin);
  const create = ghCalls().find((c) => c[0] === "pr" && c[1] === "create");
  check("gh pr create: base main, head kohlab/<id>, title from the newest commit, body from the CHANGELOG section", !!create && JSON.stringify(create) === JSON.stringify(["pr", "create", "--repo", slug, "--base", "main", "--head", `kohlab/${P1}`, "--title=release v1.1.0: tweak the readme", "--body=- Tweaked the readme."]), JSON.stringify(create));

  const again = await call("POST", RELEASE(P1), { body: { action: "open" } });
  check("open again updates the same PR (no second create)", again.status === 200 && ghCalls().filter((c) => c[1] === "create").length === 1 && again.body.pr?.number === 1);

  const early = await call("POST", RELEASE(P1), { body: { action: "merge" } });
  check("merge refused while GitHub is still checking", early.status === 409 && early.body.error === "GitHub is still checking.", early.text.slice(0, 160));
  setChecks(`kohlab/${P1}`, [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }]);
  const failing = await call("GET", RELEASE(P1));
  check("the state says checks failing", failing.body.pr?.checks === "failing", failing.text.slice(0, 200));
  const refusedFail = await call("POST", RELEASE(P1), { body: { action: "merge" } });
  check("merge refused when GitHub's checks failed", refusedFail.status === 409 && refusedFail.body.error === "GitHub's checks failed. Ask Claude to fix them.", refusedFail.text.slice(0, 160));
  setChecks(`kohlab/${P1}`, [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "StatusContext", state: "SUCCESS" }]);
  const passing = await call("GET", RELEASE(P1));
  check("the state says checks passing", passing.body.pr?.checks === "passing", passing.text.slice(0, 200));

  // newer work after sending: merge refused, and nothing is lost
  write(join(treeOf(P1), "later.txt"), "later\n");
  git(treeOf(P1), ["add", "-A"]);
  git(treeOf(P1), ["commit", "-qm", "-- later work"]);
  const stale = await call("POST", RELEASE(P1), { body: { action: "merge" } });
  check("merge refused when the project changed after it was sent", stale.status === 409 && stale.body.error === "The project changed after it was sent. Send it for checking again.", stale.text.slice(0, 200));
  git(treeOf(P1), ["reset", "-q", "--hard", "HEAD~1"]);
  const merged = await call("POST", RELEASE(P1), { body: { action: "merge" } });
  check("merge: 200, the PR is merged", merged.status === 200 && merged.body.pr?.state === "merged", merged.text.slice(0, 200));
  check("gh pr merge --squash --delete-branch for PR 1", ghCalls().some((c) => JSON.stringify(c) === JSON.stringify(["pr", "merge", "1", "--repo", slug, "--squash", "--delete-branch", `--match-head-commit=${remoteHead}`])), JSON.stringify(ghCalls()));
  const afterMerge = await call("GET", RELEASE(P1));
  check("after the merge the branch is main again: nothing ahead, clean", afterMerge.body.ahead === 0 && afterMerge.body.dirty === false, afterMerge.text.slice(0, 200));

  // ── P2: main changes the same README line, so the merge conflicts and is undone ──
  pushMain("README.md", "# check\n\nChanged on main.\n", "main readme");
  const clash = await call("POST", RELEASE(P2), { body: { action: "open" } });
  check("main moved on and overlaps: refused in plain words", clash.status === 409 && clash.body.error === "Main moved on and overlaps this change. Ask Claude to bring it up to date.", clash.text.slice(0, 200));
  check("the conflicted merge is undone: clean tree, no merge in progress", git(treeOf(P2), ["status", "--porcelain"]) === "" && !gitOk(treeOf(P2), ["rev-parse", "-q", "--verify", "MERGE_HEAD"]));
  check("nothing was pushed for P2", git(tmp, ["ls-remote", origin, `refs/heads/kohlab/${P2}`]) === "");

  // ── a plain project has no release routes ──
  const plainMade = await call("POST", "/api/workspaces", { body: { repo: plain, agent: "sh", task: "plain project" } });
  const PL = plainMade.body?.id;
  check("a plain project is made", plainMade.status === 200 && typeof PL === "string", plainMade.text.slice(0, 160));
  check("a plain project: the release state is 404", (await call("GET", RELEASE(PL))).status === 404);
  check("a plain project: open is 404 too", (await call("POST", RELEASE(PL), { body: { action: "open" } })).status === 404);

  // ── the chat's prompt: the line on a plain chat, the block on a Kohlab project ──
  // No typed task: a chat created with a message sends it to the real AI, so this one is only created, never sent to.
  const chatMade = await call("POST", "/api/workspaces", { body: { repo: plain, agent: "claude", chat: true } });
  const C = chatMade.body?.id;
  const LINE = "To change Kohlab itself, the owner starts 'Change Kohlab itself' on Home; you can't update or restart Kohlab from here.";
  const plainSys = (await call("GET", `/api/workspaces/${C}/chat/run`)).body?.instructions?.system ?? "";
  check("a plain chat carries the one line", plainSys.endsWith(` ${LINE}`), plainSys.slice(-200));
  check("the line is at most 200 characters", LINE.length <= 200);
  const kSys = (await call("GET", `/api/workspaces/${P1}/chat/run`)).body?.instructions?.system ?? "";
  const base = plainSys.slice(0, plainSys.length - (LINE.length + 1));
  const block = kSys.slice(base.length + 1);
  check("a Kohlab project carries the block, not the line", kSys.startsWith(base + " This project is a copy of Kohlab's own source") && !kSys.includes(LINE));
  check("the block is at most 900 characters", block.length > 0 && block.length <= 900, `${block.length}`);

  // ── no credentials in any response ──
  const leaked = seen.filter((t) => /https?:\/\/[^\s"/]+@/.test(t) || t.includes(SECRET));
  check("no response carries a URL with credentials", leaked.length === 0, leaked.length ? leaked[0].slice(0, 160) : "");
} catch (err) {
  failures++;
  console.log(`FAIL  ${err.message}\n${serverLog.slice(-600)}`);
} finally {
  try {
    server?.kill("SIGKILL");
  } catch {
    /* gone */
  }
  killDaemonOn(socket);
  await sleep(300);
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a leftover temp folder is not a failure */
  }
}

console.log(failures ? `\n${failures} failed` : "\nall change-Kohlab checks passed");
process.exit(failures ? 1 : 0);
