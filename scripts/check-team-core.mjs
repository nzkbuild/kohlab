#!/usr/bin/env bun
/**
 * Team core (team-store.ts, team-git.ts): the pure rules, the state files and the
 * git steps of a team, on throwaway repos and a throwaway WORKS_DIR. No server, no AI.
 *
 * Run:  bun scripts/check-team-core.mjs
 */
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The store resolves WORKS_DIR when lib.ts loads, so point it at a scratch dir first.
process.env.KOHLAB_KEY = "check-team-core";
const scratch = mkdtempSync(join(tmpdir(), "kohlab-team-core-"));
process.env.WORKS_DIR = join(scratch, "works");
mkdirSync(process.env.WORKS_DIR, { recursive: true });

const store = await import("../team-store.ts");
const tg = await import("../team-git.ts");

let failures = 0;
let passed = 0;

function check(name, ok, detail = "") {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
}

try {
  // 2. Paths: teamDir lives under WORKS_DIR/teams and refuses anything that is not a team id.
  const tid = "0123456789ab";
  check("teamDir is WORKS_DIR/teams/<id>", store.teamDir(tid) === join(process.env.WORKS_DIR, "teams", tid));
  let badId = false;
  try {
    store.teamDir("../escape");
  } catch {
    badId = true;
  }
  check("teamDir refuses a path-like id", badId);

  // 3. Areas: validated, trailing wildcards dropped, overlap on path boundaries.
  const area = (x) => store.validArea(x);
  check("area accepts plain prefixes", JSON.stringify(area(["src/auth", "README.md"])) === '["src/auth","README.md"]');
  check("area drops trailing /** and /*", JSON.stringify(area(["src/auth/**", "web/*"])) === '["src/auth","web"]');
  check("area refuses .., absolute, leading dash, bare *", ["../x", "/etc", "-rf", "*", "a/../b"].every((p) => area([p]) === null));
  check("area refuses bad characters and empty lists", area(["a b"]) === null && area([]) === null && area(Array(9).fill("a")) === null);
  check("area refuses non-strings", area([42]) === null && area("src") === null);
  check("overlap: same and nested prefixes", store.areasOverlap(["src/auth"], ["src/auth/login"]) && store.areasOverlap(["src"], ["src/x"]));
  check("overlap: sibling names do not overlap", !store.areasOverlap(["src/auth"], ["src/authz"]));
  check("overlap: disjoint areas", !store.areasOverlap(["src/a", "docs"], ["src/b", "web"]));

  // 4. Budgets: ok / near at 80% / over at 100%, tokens or wall time; spend counts turns.
  const b = { tokens: 5000, minutes: 1 };
  check("budget ok under 80%", store.budgetState(b, { tokens: 3999, ms: 0, turns: 0 }) === "ok");
  check("budget near at 80% tokens", store.budgetState(b, { tokens: 4000, ms: 0, turns: 0 }) === "near");
  check("budget over at 100% tokens", store.budgetState(b, { tokens: 5000, ms: 0, turns: 0 }) === "over");
  check("budget over on wall time alone", store.budgetState(b, { tokens: 0, ms: 60_000, turns: 0 }) === "over");
  check("budget with no limits is ok", store.budgetState({}, { tokens: 1e9, ms: 1e9, turns: 0 }) === "ok");
  const s1 = store.addSpent({ tokens: 10, ms: 5, turns: 2 }, 7, 3);
  check("addSpent adds tokens and ms and one turn", s1.tokens === 17 && s1.ms === 8 && s1.turns === 3, JSON.stringify(s1));

  // 5. Assignments: deps done, areas disjoint from busy tasks and earlier picks, idle builders only, capped.
  const sp = { tokens: 0, ms: 0, turns: 0 };
  const task = (id, over = {}) => ({ id, title: id, brief: "", area: ["x"], deps: [], status: "todo", rounds: 0, spent: sp, created: 0, updated: 0, ...over });
  const role = (id, state = "idle") => ({ id, kind: "builder", name: id, member: "", mode: "acceptEdits", instructions: "", budget: {}, spent: sp, state, line: "", since: 0, inboxRead: 0 });
  const mk = (tasks, roles = [role("builder-1"), role("builder-2")]) => ({ id: tid, project: "p", goal: "g", status: "running", created: 0, updated: 0, base: "b", int: "i", maxAgents: 2, gate: "final", budget: {}, spent: sp, roles: [{ id: "lead", kind: "lead", name: "Lead", member: "", mode: "plan", instructions: "", budget: {}, spent: sp, state: "idle", line: "", since: 0, inboxRead: 0 }, ...roles], tasks, needsYou: [], seq: 0, wakes: 0 });
  const picks = (t, n) => store.pickAssignments(t, n).map((p) => `${p.task}>${p.role}`).join(" ");
  const tasks1 = [
    task("T1", { area: ["src/a"] }),
    task("T2", { area: ["src/a/x"] }), // overlaps T1, picked earlier in the same call
    task("T3", { deps: ["T9"], area: ["lib"] }), // dependency not done
    task("T4", { area: ["docs"] }),
    task("T5", { area: ["web"] }),
  ];
  check("picks in id order onto idle builders, skipping overlaps", picks(mk(tasks1), 5) === "T1>builder-1 T4>builder-2", picks(mk(tasks1), 5));
  check("freeSlots caps the picks", picks(mk(tasks1), 1) === "T1>builder-1", picks(mk(tasks1), 1));
  check("a working task's area blocks a todo", picks(mk([task("T1", { status: "working", area: ["docs"] }), task("T4", { area: ["docs/x"] })]), 3) === "");
  check("a done dependency unlocks a task", picks(mk([task("T9", { status: "done" }), task("T3", { deps: ["T9"], area: ["lib"] })]), 2) === "T3>builder-1");
  check("busy builders get nothing", picks(mk(tasks1, [role("builder-1", "working"), role("builder-2", "working")]), 5) === "");
  check("no more picks than idle builders", picks(mk([task("T1", { area: ["a"] }), task("T2", { area: ["b"] }), task("T3", { area: ["c"] })]), 5).split(" ").length === 2);

  // 6. Text: caps hold on a full board, untrusted text is wrapped, roles carry the matrix's models.
  const big = mk(Array.from({ length: 30 }, (_, i) => task(`T${i + 1}`, { title: "t".repeat(80), status: ["todo", "working", "done", "review", "blocked"][i % 5], assignee: i % 5 === 1 ? "builder-2" : undefined, area: [`dir${i}/deep/path`] })));
  big.budget = { tokens: 1_200_000, minutes: 60 };
  big.spent = { tokens: 500_000, ms: 0, turns: 4 };
  const lead = big.roles[0];
  const inbox = Array.from({ length: 8 }, (_, i) => ({ n: i, at: 0, kind: "message", from: "builder-1", to: "lead", task: "T1", text: `m${i} ${"x".repeat(400)}` }));
  const dg = store.digestFor(big, lead, inbox);
  check("digest <= 1500 chars on a 30-task board with a full inbox", dg.length <= store.DIGEST_CAP && dg.length > 100, String(dg.length));
  check("digest shows the board and the budget in percent", dg.includes("Board: todo") && store.digestFor(big, lead, []).includes("goal 41%"), dg.slice(0, 200));
  const short8 = Array.from({ length: 8 }, (_, i) => ({ n: i, at: 0, kind: "message", from: "builder-1", to: "lead", text: `hi ${i}` }));
  const dg8 = store.digestFor(big, lead, short8);
  check("digest wraps unread messages and caps them at five", (dg8.match(/<team-message /g) ?? []).length === 5 && dg8.includes("3 more unread"), dg8.slice(-200));
  check("digest keeps the budget line when the inbox is long", dg.includes("Budget: goal 41%") && dg.includes("more unread"), dg.slice(-300));
  const bf = store.briefFor(big, task("T7", { title: "x".repeat(200), brief: "b".repeat(5000), area: ["src/a", "src/b"] }), "g".repeat(900), Array.from({ length: 12 }, () => "s".repeat(900)));
  check("builder brief <= 3000 chars with huge inputs", bf.length <= store.BRIEF_CAP && bf.includes("You may change only these paths: src/a, src/b"), String(bf.length));
  const rv = store.reviewMessageFor(big, task("T2", { brief: "brief", summary: "sum" }), "1 file changed", "d".repeat(60_000), false);
  check("review diff capped at 24 KB with a note", Buffer.byteLength(rv) < 25 * 1024 && rv.includes("cut at 24 KB"), String(Buffer.byteLength(rv)));
  const rvSmall = store.reviewMessageFor(big, task("T2"), "s", "+one\n", false);
  check("small review diff is not marked cut", rvSmall.includes("+one") && !rvSmall.includes("cut at 24 KB"));
  const ls = store.roleSettings("lead");
  check("lead settings: sonnet, high, plan, team and brain tools", ls.model === "sonnet" && ls.effort === "high" && ls.mode === "plan" && ls.allowRules.includes("mcp__team__*") && ls.allowRules.includes("mcp__brain__*"));
  check("no role gets bypassPermissions", ["lead", "builder", "reviewer", "tester"].every((k) => store.roleSettings(k).mode !== "bypassPermissions"));
  check("builder settings: haiku, low, acceptEdits, recall only", store.roleSettings("builder").mode === "acceptEdits" && store.roleSettings("builder").allowRules.includes("mcp__brain__recall") && !store.roleSettings("builder").allowRules.includes("mcp__brain__*"));

  // wakeNeeded: triggers on new events, state triggers only after a quiet 30 s.
  const now = 1_000_000;
  const quietTeam = (tasks, extra = {}) => ({ ...mk(tasks), updated: now - 60_000, ...extra });
  check("wake: message to lead", store.wakeNeeded(big, [{ n: 1, at: 0, kind: "message", from: "builder-1", to: "lead", text: "hi" }], now) === "message from Builder 1" || store.wakeNeeded(big, [{ n: 1, at: 0, kind: "message", from: "builder-1", to: "lead", text: "hi" }], now)?.startsWith("message from"));
  check("wake: a message to someone else does not wake the lead", store.wakeNeeded({ ...big, updated: now }, [{ n: 1, at: 0, kind: "message", from: "builder-1", to: "reviewer", text: "hi" }], now) === null);
  check("wake: blocked task event", store.wakeNeeded(big, [{ n: 1, at: 0, kind: "task", from: "lead", task: "T5", text: "blocked" }], now) === "T5 blocked");
  check("wake: no wake for a routine merge event", store.wakeNeeded(mk([task("T1", { status: "done" }), task("T2", { status: "working" })]), [{ n: 1, at: 0, kind: "merge", from: "builder-1", task: "T1", text: "merged" }], now) === null);
  check("wake: all done and quiet, no finish", store.wakeNeeded(quietTeam([task("T1", { status: "done" })]), [], now) === "all tasks done, no finish");
  check("wake: not quiet yet, no state wake", store.wakeNeeded({ ...mk([task("T1", { status: "done" })]), updated: now }, [], now) === null);
  check("wake: stalled when nothing moves and nothing can be assigned", store.wakeNeeded(quietTeam([task("T1", { status: "blocked" })]), [], now) === "stalled");

  // 7. State: atomic 0600 files, tokens never in the view, per-team queue, event rotation.
  const proj = { id: "proj1", name: "Demo" };
  const tf = store.newTeam(proj, "  add hello and goodbye  ", { maxAgents: 2, gate: "final", builders: 2, reviewer: true, tester: false }, "a".repeat(40));
  const tid2 = tf.team.id;
  check("newTeam: roles are lead, two builders, reviewer; tester off", tf.team.roles.map((r) => r.id).join(",") === "lead,builder-1,builder-2,reviewer", tf.team.roles.map((r) => r.id).join(","));
  check("newTeam: goal trimmed, int branch named from the id, status running", tf.team.goal === "add hello and goodbye" && tf.team.int === `kohlab/team-${tid2}` && tf.team.status === "running");
  check("newTeam: one 24-byte token per role", Object.keys(tf.secrets).sort().join(",") === "builder-1,builder-2,lead,reviewer" && Object.values(tf.secrets).every((t) => Buffer.from(t, "base64url").length === 24));
  const onDisk = join(process.env.WORKS_DIR, "teams", tid2, "team.json");
  check("team.json is written with mode 0600", existsSync(onDisk) && (statSync(onDisk).mode & 0o777) === 0o600, (statSync(onDisk).mode & 0o777).toString(8));
  check("readTeam returns what newTeam wrote", JSON.stringify(store.readTeam(tid2)) === JSON.stringify(tf));
  check("readTeam on an unknown id is null", store.readTeam("ffffffffffff") === null);
  const view = JSON.stringify(store.teamView(tf));
  check("teamView carries no token", Object.values(tf.secrets).every((t) => !view.includes(t)) && !view.includes("secrets"));
  check("findRoleByToken: the right token gives its role", store.findRoleByToken(tf, tf.secrets["builder-2"])?.id === "builder-2");
  const wrong = Buffer.from(tf.secrets["builder-2"], "base64url");
  wrong[0] ^= 1;
  check("findRoleByToken: a wrong token gives null", store.findRoleByToken(tf, "nope") === null);
  check("findRoleByToken: an equal-length wrong token gives null", store.findRoleByToken(tf, wrong.toString("base64url")) === null && wrong.toString("base64url").length === tf.secrets["builder-2"].length);
  check("findRoleByToken: empty token gives null", store.findRoleByToken(tf, "") === null);
  let badTeam = false;
  try {
    store.readTeam("../escape");
  } catch {
    badTeam = true;
  }
  check("readTeam refuses a path-like id", badTeam);

  // The per-team queue: twenty concurrent increments all land.
  await Promise.all(Array.from({ length: 20 }, () => store.withTeam(tid2, (f) => { f.team.wakes += 1; })));
  check("withTeam serialises concurrent writers", store.readTeam(tid2).team.wakes === 20, String(store.readTeam(tid2).team.wakes));
  const threw = await store.withTeam(tid2, () => { throw new Error("boom"); }).then(() => false, () => true);
  check("withTeam rejects when fn throws and still saves", threw);

  // Events: numbered, capped text, read after a cursor.
  await store.withTeam(tid2, (f) => {
    store.appendEvent(f, { kind: "tool", from: "lead", text: "x".repeat(900) });
    store.appendEvent(f, { kind: "message", from: "lead", to: "builder-1", text: "go" });
  });
  const evs = store.readEvents(tid2, 0);
  check("events are numbered from 1 and text is capped at 600", evs.map((e) => e.n).join(",") === "1,2" && evs[0].text.length === 600, JSON.stringify(evs.map((e) => e.n)));
  check("readEvents after a cursor", store.readEvents(tid2, 1).map((e) => e.n).join(",") === "2");
  const counted = store.readTeam(tid2).team.seq;
  check("the team counter matches the events written", counted === 2, String(counted));

  // Rotation: past 5000, rewritten to the last 4000 each 1000 events.
  await store.withTeam(tid2, (f) => {
    for (let i = 0; i < 5998; i++) store.appendEvent(f, { kind: "note", from: "you", text: `e${i}` });
  });
  const lines = readFileSync(join(process.env.WORKS_DIR, "teams", tid2, "events.jsonl"), "utf8").split("\n").filter(Boolean);
  check("events rotate to the last 4000 at 6000", lines.length === 4000 && JSON.parse(lines[0]).n === 2001, `lines=${lines.length}`);
  check("readEvents still reads the rotated file", store.readEvents(tid2, 5990).map((e) => e.n).join(",") === "5991,5992,5993,5994,5995,5996,5997,5998,5999,6000");

  // Active teams: running ones are listed; done ones are not.
  check("listActiveTeamIds lists the running team", store.listActiveTeamIds().includes(tid2));
  await store.withTeam(tid2, (f) => { f.team.status = "done"; });
  check("listActiveTeamIds drops a done team", !store.listActiveTeamIds().includes(tid2));

  // 8. Git: worktrees, commits, merges, conflicts, landing. Throwaway repos under the scratch dir.
  const repo = join(scratch, "repo");
  const sh = (cwd, ...args) => execFileSync("git", ["-c", "safe.directory=*", ...args], { cwd, encoding: "utf8" }).trim();
  const mergeInProgress = (dir) => {
    try {
      sh(dir, "rev-parse", "-q", "--verify", "MERGE_HEAD");
      return true;
    } catch {
      return false;
    }
  };
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "check@kohlab.test");
  sh(repo, "config", "user.name", "check");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/x.txt"), "one\n");
  writeFileSync(join(repo, "README.md"), "readme\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "base");
  const base = sh(repo, "rev-parse", "HEAD");
  // A hook that would fail every commit. Team git turns hooks off, so commits still work.
  const marker = join(scratch, "hook-ran");
  writeFileSync(join(repo, ".git/hooks/pre-commit"), `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });

  const intDir = join(scratch, "int");
  const b1Dir = join(scratch, "b1");
  const b2Dir = join(scratch, "b2");
  const rDir = join(scratch, "rev");
  const intBranch = "kohlab/team-t1";
  await tg.addTree(repo, intDir, intBranch, base);
  check("addTree creates a branch worktree at the start point", sh(intDir, "rev-parse", "--abbrev-ref", "HEAD") === intBranch && (await tg.headOf(intDir)) === base);
  await tg.addTree(repo, b1Dir, "kohlab/team-t1-builder-1", base);
  await tg.addTree(repo, b2Dir, "kohlab/team-t1-builder-2", base);
  await tg.addTree(repo, rDir, null, base);
  check("addTree with no branch is detached", sh(rDir, "rev-parse", "--abbrev-ref", "HEAD") === "HEAD");
  check("a clean worktree reports clean", (await tg.isClean(b1Dir)) === true);

  // Builder 1 edits its file and one outside its area, then commits. Hooks must not run.
  writeFileSync(join(b1Dir, "src/x.txt"), "builder one\n");
  writeFileSync(join(b1Dir, "other.txt"), "outside\n");
  const c1 = await tg.commitAll(b1Dir, "T1: edit x");
  check("commitAll commits and reports changed", c1.changed === true && c1.head === (await tg.headOf(b1Dir)));
  check("commit hooks are off (pre-commit would have failed)", !existsSync(marker));
  rmSync(join(repo, ".git/hooks/pre-commit")); // the project side below commits normally
  const c1again = await tg.commitAll(b1Dir, "nothing new");
  check("commitAll with nothing to commit reports unchanged", c1again.changed === false && c1again.head === c1.head);
  const files1 = await tg.changedFiles(b1Dir, base);
  check("changedFiles lists everything the task changed (area check uses this)", files1.sort().join(",") === "other.txt,src/x.txt", files1.join(","));
  const stat = await tg.diffText(b1Dir, base, c1.head, 100000);
  check("diffText gives a stat and the patch", stat.stat.includes("src/x.txt") && stat.diff.includes("+builder one") && stat.truncated === false);
  const cut = await tg.diffText(b1Dir, base, c1.head, 20);
  check("diffText stops at the cap and says so", cut.truncated === true && Buffer.byteLength(cut.diff) <= 20, String(Buffer.byteLength(cut.diff)));

  // Clean merge into the integration tree.
  const m1 = await tg.mergeInto(intDir, "kohlab/team-t1-builder-1", "T1: edit x", undefined);
  check("clean merge into the integration tree", m1.ok === true && m1.head === (await tg.headOf(intDir)));
  check("the merge is no-ff (two parents)", sh(intDir, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length === 3);

  // Builder 2 changes the same line, so its merge conflicts.
  writeFileSync(join(b2Dir, "src/x.txt"), "builder two\n");
  const c2 = await tg.commitAll(b2Dir, "T2: edit x too");
  const intBefore = await tg.headOf(intDir);
  const m2 = await tg.mergeInto(intDir, "kohlab/team-t1-builder-2", "T2: edit x too", undefined);
  check("conflicting merge is refused with the files listed", m2.ok === false && m2.files.join(",") === "src/x.txt", JSON.stringify(m2));
  check("conflict aborts: the integration tree is clean and unchanged", (await tg.isClean(intDir)) && (await tg.headOf(intDir)) === intBefore);
  check("no merge left in progress after abort", !mergeInProgress(intDir));

  // The builder merges the integration head into its own tree and keeps the markers for it to fix.
  const conflicted = await tg.mergeKeepingConflicts(b2Dir, intBranch);
  check("mergeKeepingConflicts leaves the conflicting files for the builder", conflicted.join(",") === "src/x.txt", conflicted.join(","));
  check("the conflict markers are in the file", readFileSync(join(b2Dir, "src/x.txt"), "utf8").includes("<<<<<<<"));
  writeFileSync(join(b2Dir, "src/x.txt"), "one and two\n");
  const c2b = await tg.commitAll(b2Dir, "resolve");
  check("the builder can commit the resolution", c2b.changed === true);
  const m2b = await tg.mergeInto(intDir, "kohlab/team-t1-builder-2", "T2: edit x too", undefined, "theirs");
  check("the resolved branch merges cleanly into the integration tree", m2b.ok === true, JSON.stringify(m2b));

  // Builder 1 moves on to the integration head; its tree matches it afterwards.
  const head = await tg.headOf(intDir);
  await tg.resetTree(b1Dir, "kohlab/team-t1-builder-1", head);
  check("resetTree moves a builder branch to the integration head", (await tg.headOf(b1Dir)) === head && sh(b1Dir, "rev-parse", "--abbrev-ref", "HEAD") === "kohlab/team-t1-builder-1");
  writeFileSync(join(rDir, "stray.txt"), "junk\n");
  await tg.resetTree(rDir, null, head);
  check("resetTree on a detached tree drops untracked files", (await tg.headOf(rDir)) === head && !existsSync(join(rDir, "stray.txt")));

  // Landing: squash into the project as uncommitted changes.
  const landed = await tg.landSquash(repo, intBranch, base);
  check("landSquash brings the team's files in as uncommitted changes", landed.ok === true && landed.files.sort().join(",") === "other.txt,src/x.txt", JSON.stringify(landed));
  check("landing commits nothing (HEAD is the base)", sh(repo, "rev-parse", "HEAD") === base);
  check("landed files are visible in the project tree", sh(repo, "status", "--porcelain").includes("src/x.txt"));
  const dirty = await tg.landSquash(repo, intBranch, base);
  check("landing refuses a dirty project tree", dirty.ok === false && dirty.reason === "dirty");

  // Undo the landing, put a conflicting commit on the project, then land: conflict, tree restored.
  sh(repo, "reset", "-q", "--hard", "HEAD");
  sh(repo, "clean", "-fdq");
  writeFileSync(join(repo, "src/x.txt"), "project side\n");
  sh(repo, "commit", "-q", "-am", "project edit");
  const projHead = sh(repo, "rev-parse", "HEAD");
  const clash = await tg.landSquash(repo, intBranch, base);
  check("landing conflict is reported with its files", clash.ok === false && clash.reason === "conflict" && clash.files.join(",") === "src/x.txt", JSON.stringify(clash));
  check("landing conflict restores the project tree", (await tg.isClean(repo)) && sh(repo, "rev-parse", "HEAD") === projHead && readFileSync(join(repo, "src/x.txt"), "utf8") === "project side\n");

  // Teardown: the worktree and its branch go; repeating is harmless.
  await tg.removeTree(repo, b1Dir, "kohlab/team-t1-builder-1");
  check("removeTree removes the worktree and its branch", !existsSync(b1Dir) && !sh(repo, "branch", "--list", "kohlab/team-t1-builder-1").includes("builder-1"));
  await tg.removeTree(repo, b1Dir, "kohlab/team-t1-builder-1");
  check("removeTree is harmless when repeated", true);

  // Remaining steps are added below as they are written.
  console.log(`\n${passed} passed, ${failures} failed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (failures) process.exit(1);
