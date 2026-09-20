#!/usr/bin/env node
/**
 * The updater rewrites the user's git state and restarts their service, so it
 * gets a real fixture rather than a mock: a bare `origin`, two clones (a release
 * clone and the checkout under test), a throwaway WORKS_DIR, a fake `systemctl`,
 * a fake `bun`, and a real HTTP server standing in for the service on a port.
 *
 * Run:  node scripts/check-update.mjs
 *
 * Seven properties:
 *   1. Uncommitted work goes to the stash before anything is downloaded, HEAD
 *      stays on the branch it started on, and no side branch appears.
 *   2. Commits that were never pushed get pushed.
 *   3. The happy path fast-forwards, installs, builds, reloads, and confirms the
 *      service is actually answering on its port — and backs the state up first.
 *   4. With nothing new upstream, nothing is downloaded, installed or restarted.
 *   5. It refuses the two ways an update can hurt you: a diverged branch, and a
 *      reload under KillMode that would kill every live agent session.
 *   6. When the new build does not answer on its port, it rolls the checkout
 *      back AND reloads, so the known-good version is what is serving.
 *   7. A tripwire: none of this may touch the checkout the check lives in.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SOURCE_SCRIPT = join(ROOT, "scripts/update.sh");
const REAL_BUN = spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim();
const PORT = 7812;

const tmp = mkdtempSync(join(tmpdir(), "kohlab-update-"));
const origin = join(tmp, "origin.git");
const rel = join(tmp, "rel");
const work = join(tmp, "work");
const state = join(tmp, "state");
const bin = join(tmp, "bin");
const calls = join(tmp, "calls.log");
const killmode = join(tmp, "killmode");

const GITENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "kohlab check",
  GIT_AUTHOR_EMAIL: "check@kohlab.test",
  GIT_COMMITTER_NAME: "kohlab check",
  GIT_COMMITTER_EMAIL: "check@kohlab.test",
};

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail.replace(/\n/g, "\n        ")}`);
  }
}

function git(args, cwd = work) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GITENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

const versionAt = (p) => JSON.parse(readFileSync(join(p, "package.json"), "utf8")).version;

/**
 * Tripwire. This check must never touch the checkout it lives in: the first
 * version of it ran the live scripts/update.sh (the updater resolves its repo
 * from its own path, so the fixture's cwd was ignored) and really did autosave
 * and push the developer's working tree. Snapshot, then compare at the end.
 */
function liveState() {
  try {
    return JSON.stringify({
      head: git(["rev-parse", "HEAD"], ROOT),
      status: git(["status", "--porcelain"], ROOT),
      refs: git(["for-each-ref", "--format=%(refname)", "refs/heads"], ROOT),
    });
  } catch {
    return null;
  }
}
const LIVE_BEFORE = liveState();

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const write = (p, s) => writeFileSync(p, s);

/** the copy under test — never the live checkout's, which would update IT */
const fixtureScript = join(work, "scripts/update.sh");
if (!fixtureScript.startsWith(tmp) || fixtureScript.startsWith(ROOT)) {
  throw new Error(`refusing to run: ${fixtureScript} is not inside the fixture`);
}

/** run the updater against the fixture; returns { status, out } */
function update(extraArgs = [], extraEnv = {}) {
  const r = spawnSync("bash", [fixtureScript, ...extraArgs], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...GITENV,
      PATH: `${bin}:${process.env.PATH}`,
      CALLS: calls,
      KOHLAB_UNIT: "kohlab-fixture",
      KOHLAB_PROBE_TRIES: "2",
      KOHLAB_PROBE_WAIT: "0",
      ...extraEnv,
    },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// the stand-in service: a real port to probe, in its own process because
// spawnSync blocks this one's event loop
let unit = null;
const SERVER_CODE = `require("node:http").createServer((q,s)=>{s.writeHead(200,{"content-type":"text/html"});s.end("<html>fixture</html>")}).listen(${PORT},"127.0.0.1")`;

function startUnit() {
  unit = spawn("node", ["-e", SERVER_CODE], { stdio: "ignore" });
}
function stopUnit() {
  if (unit) {
    unit.kill();
    unit = null;
  }
}
async function unitAnswers() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: "manual" });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** publish a release from the release clone */
function release(toVersion, file) {
  git(["fetch", "-q", "origin"], rel);
  git(["reset", "-q", "--hard", "origin/main"], rel);
  write(join(rel, "package.json"), JSON.stringify({ name: "kohlab", version: toVersion }, null, 2) + "\n");
  write(join(rel, file), `content of ${file}\n`);
  git(["add", "-A"], rel);
  git(["commit", "-qm", `feat: v${toVersion}`], rel);
  git(["push", "-q", "origin", "main"], rel);
}

const callsFrom = (n) => read(calls).split("\n").slice(n).join("\n");
const callsNow = () => read(calls).split("\n").length;

try {
  // ── fixture ────────────────────────────────────────────────────────────────
  mkdirSync(join(work, "web"), { recursive: true });
  mkdirSync(join(work, "scripts"), { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(bin, { recursive: true });

  git(["init", "-q", "-b", "main", work], tmp);
  copyFileSync(SOURCE_SCRIPT, join(work, "scripts/update.sh"));
  write(join(work, "package.json"), JSON.stringify({ name: "kohlab", version: "1.0.0" }, null, 2) + "\n");
  write(join(work, "web/package.json"), JSON.stringify({ name: "web", version: "0.0.0" }, null, 2) + "\n");
  write(join(work, "notes.txt"), "original notes\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  git(["init", "-q", "--bare", "-b", "main", origin], tmp);
  git(["remote", "add", "origin", origin]);
  git(["push", "-q", "-u", "origin", "main"]);
  git(["clone", "-q", origin, rel], tmp);

  write(join(state, "state.json"), '{"workspaces":[],"agents":{}}\n');

  // fake bun: log the call, delegate `-e` to the real bun (version reads and the
  // port probe both go through it), and fail on demand for the rollback path
  write(join(bin, "bun"), `#!/usr/bin/env bash
echo "bun $*" >> "$CALLS"
if [ "\${1:-}" = "-e" ]; then exec "${REAL_BUN}" "$@"; fi
if [ -n "\${FAKE_BUN_FAIL:-}" ]; then echo "fake bun: failing on purpose" >&2; exit 1; fi
exit 0
`);
  // fake systemctl. `show -p Environment` mirrors systemd's real merged
  // single-line form — a prettier stub once hid a parsing bug in the updater,
  // which found no WORKS_DIR and silently skipped the state backup.
  write(join(bin, "systemctl"), `#!/usr/bin/env bash
echo "systemctl $*" >> "$CALLS"
for a in "$@"; do
  case "$a" in
    is-active) exit 0 ;;
    restart) exit 0 ;;
    Environment) echo "Environment=WORKS_DIR=${state} PORT=${PORT} KOHLAB_KEY=fixture-key"; exit 0 ;;
    KillMode) echo "KillMode=$(cat "${killmode}")"; exit 0 ;;
  esac
done
exit 0
`);
  chmodSync(join(bin, "bun"), 0o755);
  chmodSync(join(bin, "systemctl"), 0o755);
  write(killmode, "process");

  startUnit();
  if (!(await unitAnswers())) throw new Error(`fixture service never came up on port ${PORT}`);

  console.log("\n\x1b[1mkohlab — safe update\x1b[0m");

  // ── 1. save uncommitted work, then update ─────────────────────────────────
  console.log("\n\x1b[1m1. uncommitted work, then a real update\x1b[0m");
  write(join(work, "notes.txt"), "edited but not committed\n");
  write(join(work, "untracked.txt"), "brand new file\n");
  release("1.1.0", "feature.txt");

  const c1 = update();
  check("exits 0", c1.status === 0, c1.out);
  check("saved the work to the stash", /kohlab update autosave/.test(git(["stash", "list"])), git(["stash", "list"]));
  check("the stash holds the modified tracked file", git(["show", "stash@{0}:notes.txt"]) === "edited but not committed");
  check("the stash holds the untracked file", git(["show", "stash@{0}^3:untracked.txt"]) === "brand new file");
  check("HEAD never left the branch", git(["rev-parse", "--abbrev-ref", "HEAD"]) === "main");
  check("no side branch was created", git(["branch", "--list", "kohlab-autosave/*"]) === "");
  check("the checkout is clean afterwards", git(["status", "--porcelain"]) === "");
  check("checkout fast-forwarded to v1.1.0", versionAt(work) === "1.1.0", versionAt(work));
  check("upstream's new file is present", existsSync(join(work, "feature.txt")));
  check("dependencies were installed", c1.out.includes("backend dependencies"), c1.out);
  check("the dashboard was rebuilt", c1.out.includes("dashboard build"), c1.out);
  check("the service was restarted", read(calls).includes("systemctl restart kohlab-fixture"));
  check("the health gate confirmed the port", c1.out.includes(`is serving v1.1.0 on port ${PORT}`), c1.out);
  const backups = spawnSync("ls", [tmp], { encoding: "utf8" }).stdout.split("\n").filter((f) => f.startsWith("kohlab-state-"));
  check("a state backup tarball exists", backups.length === 1, backups.join(", "));

  // ── 2. a commit that was never pushed, nothing new upstream ───────────────
  console.log("\n\x1b[1m2. a commit that was never pushed, nothing new upstream\x1b[0m");
  write(join(work, "local-only.txt"), "never pushed\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "local: work that was never pushed"]);
  const n2 = callsNow();
  const c2 = update();
  check("exits 0", c2.status === 0, c2.out);
  check(
    "pushed the previously unpushed commit",
    git(["log", "--oneline", "main"], origin).includes("local: work that was never pushed"),
    git(["log", "--oneline", "main"], origin),
  );
  check("reports it is already up to date", /already up to date/.test(c2.out), c2.out);
  check("installed, built and restarted nothing", !/install|build|restart/.test(callsFrom(n2)), callsFrom(n2));
  check("no OTA markers in a human's terminal", !/# kohlab update (started|finished)/.test(c2.out), c2.out);

  // ── 2b. the markers the OTA endpoint reads back ───────────────────────────
  // The dashboard runs the same script with KOHLAB_OTA=1 and its stdout going to
  // update.log; these two lines are all it has to tell "running" from "finished,
  // exit N" after the reload kills the server that started the run.
  console.log("\n\x1b[1m2b. the markers an OTA run leaves behind\x1b[0m");
  const c2b = update([], { KOHLAB_OTA: "1" });
  check("writes a started marker naming its pid", /^# kohlab update started \d+ pid \d+$/m.test(c2b.out), c2b.out);
  check("writes a finished marker with the exit code", /^# kohlab update finished \d+ exit 0$/m.test(c2b.out), c2b.out);

  // ── 3. divergence ─────────────────────────────────────────────────────────
  console.log("\n\x1b[1m3. a diverged branch\x1b[0m");
  write(join(work, "divergent.txt"), "mine\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "local: a commit upstream does not have"]);
  release("1.2.0", "upstream-only.txt");

  const c3 = update();
  check("refuses to continue (non-zero exit)", c3.status !== 0, c3.out);
  check("says why: diverged", /diverged/.test(c3.out), c3.out);
  check("did not touch the local commit", git(["log", "--oneline", "-1"]).includes("upstream does not have"));
  check("version unchanged", versionAt(work) === "1.1.0", versionAt(work));

  // ── 4. KillMode that would kill live agents ───────────────────────────────
  console.log("\n\x1b[1m4. a reload that would kill every live agent\x1b[0m");
  git(["fetch", "-q", "origin"]);
  git(["reset", "-q", "--hard", "origin/main"]);
  write(killmode, "control-group");
  release("1.3.0", "another.txt");

  const c4 = update();
  check("refuses the reload (non-zero exit)", c4.status !== 0, c4.out);
  check("names the problem: KillMode", /KillMode=control-group/.test(c4.out), c4.out);
  check("points at --force and the docs", /--force/.test(c4.out) && /docs\/systemd\.md/.test(c4.out), c4.out);
  check("the code is installed, only the reload is pending", versionAt(work) === "1.3.0", versionAt(work));

  // ── 5. --check changes nothing ────────────────────────────────────────────
  console.log("\n\x1b[1m5. --check\x1b[0m");
  write(killmode, "process");
  release("1.4.0", "yet-another.txt");
  const n5 = callsNow();
  const c5 = update(["--check"]);
  check("exits 0", c5.status === 0, c5.out);
  check("announces it changed nothing", /nothing downloaded, installed or restarted/.test(c5.out), c5.out);
  check("did not download the new version", versionAt(work) === "1.3.0", versionAt(work));
  check("ran no install, build or restart", !/install|build|restart/.test(callsFrom(n5)), callsFrom(n5));

  // ── 6. a failing install rolls the checkout back ──────────────────────────
  console.log("\n\x1b[1m6. an install that fails\x1b[0m");
  release("1.5.0", "broken-release.txt");
  const headBefore = git(["rev-parse", "HEAD"]);
  const restartsBefore = (read(calls).match(/systemctl restart/g) ?? []).length;
  const c6 = update([], { FAKE_BUN_FAIL: "1" });
  check("reports failure (non-zero exit)", c6.status !== 0, c6.out);
  check("says it is rolling back", /rolling the checkout back/.test(c6.out), c6.out);
  check("the checkout is back on the old commit", git(["rev-parse", "HEAD"]) === headBefore);
  check("version is back to v1.3.0", versionAt(work) === "1.3.0", versionAt(work));
  check("the new release is not in the tree", !existsSync(join(work, "broken-release.txt")));
  check(
    "nothing was reloaded",
    (read(calls).match(/systemctl restart/g) ?? []).length === restartsBefore,
    callsFrom(0).slice(-200),
  );

  // ── 7. a build that never answers on its port ─────────────────────────────
  console.log("\n\x1b[1m7. a reload that does not come up\x1b[0m");
  stopUnit();
  release("1.6.0", "never-serves.txt");
  const headBefore7 = git(["rev-parse", "HEAD"]);
  const restartsBefore7 = (read(calls).match(/systemctl restart/g) ?? []).length;
  const c7 = update();
  const restartsAfter7 = (read(calls).match(/systemctl restart/g) ?? []).length;
  check("reports failure (non-zero exit)", c7.status !== 0, c7.out);
  check("says it is rolling back", /rolling the checkout back/.test(c7.out), c7.out);
  check("the checkout is back on the old commit", git(["rev-parse", "HEAD"]) === headBefore7, `${headBefore7} → ${git(["rev-parse", "HEAD"])}`);
  check("version is back to v1.3.0", versionAt(work) === "1.3.0", versionAt(work));
  check("the unserved release is not in the tree", !existsSync(join(work, "never-serves.txt")));
  check("it reloaded the restored build (rollback restarts)", restartsAfter7 > restartsBefore7, `${restartsBefore7} → ${restartsAfter7}`);
  check("reports the service still not answering", /not answering on port/.test(c7.out), c7.out);

  // ── 8. tripwire ───────────────────────────────────────────────────────────
  console.log("\n\x1b[1m8. the checkout this check lives in is untouched\x1b[0m");
  const liveAfter = liveState();
  check(
    "no commit, branch or checkout change in " + ROOT,
    LIVE_BEFORE === null || liveAfter === LIVE_BEFORE,
    `${LIVE_BEFORE}\n  became\n  ${liveAfter}`,
  );

  console.log(`\n${failures === 0 ? "\x1b[32mall checks passed\x1b[0m" : `\x1b[31m${failures} check(s) failed\x1b[0m`}\n`);
} finally {
  stopUnit();
  rmSync(tmp, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
