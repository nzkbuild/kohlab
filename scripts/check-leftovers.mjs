#!/usr/bin/env node
// scripts/leftovers.mjs, tested in a throwaway WORKS_DIR with fake folders, a symlink out of it and a fake stray
// daemon (v2.9.4). Only --dirs-only and --sockets-under are used, so no account or ACL on this machine is touched,
// and only daemons under this check's own temp dir are candidates. Nothing real is removed or killed.
//
//   node scripts/check-leftovers.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const LEFTOVERS = join(ROOT, "scripts", "leftovers.mjs");
let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` ${detail}`}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const tmp = mkdtempSync(join(tmpdir(), "kohlab-left-"));
const works = join(tmp, "works");
const outside = join(tmp, "outside");
const socket = join(tmp, "stray.sock");
const live = join(tmp, "live.sock");
let daemon = null;

/** Run the tool against the throwaway WORKS_DIR, scoped to this temp dir. */
function tool(extra) {
  return spawnSync(process.execPath, [LEFTOVERS, "--dirs-only", "--sockets-under", tmp, ...extra], {
    encoding: "utf8",
    env: { ...process.env, WORKS_DIR: works, PTY_SOCKET: live },
  });
}

try {
  mkdirSync(works, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "keep-me.txt"), "outside WORKS_DIR\n");
  mkdirSync(join(works, "kohlab-test-keep")); // referenced by state.json
  mkdirSync(join(works, "kohlab-test-gone")); // a test run's folder, nothing references it
  mkdirSync(join(works, "kohlab-pty-test-old"));
  mkdirSync(join(works, "not-a-test")); // no test prefix: never listed
  symlinkSync(outside, join(works, "kohlab-test-link")); // a link out of WORKS_DIR: never followed or removed
  writeFileSync(join(works, "state.json"), JSON.stringify({ workspaces: [{ id: "keep", dir: join(works, "kohlab-test-keep") }] }));

  // A stray daemon: its command line names pty-daemon.cjs and its socket is not the live one.
  daemon = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)", "pty-daemon.cjs"], {
    env: { ...process.env, PTY_SOCKET: socket },
    stdio: "ignore",
  });
  await sleep(300);

  console.log("listing (nothing changes)");
  const listed = tool([]);
  check("the list runs", listed.status === 0, listed.stderr);
  check("the unreferenced test folders are listed for removal", /rm\s+\S*kohlab-test-gone/.test(listed.stdout) && /rm\s+\S*kohlab-pty-test-old/.test(listed.stdout), listed.stdout);
  check("the referenced folder is kept", /keep\s+\S*kohlab-test-keep/.test(listed.stdout));
  check("the link is listed as kept, never followed", /keep\s+\S*kohlab-test-link/.test(listed.stdout));
  check("a non-test folder is not listed", !listed.stdout.includes("not-a-test"));
  check("the stray daemon is listed", listed.stdout.includes(`socket ${socket}`), listed.stdout);
  check("listing removed nothing", existsSync(join(works, "kohlab-test-gone")) && existsSync(join(works, "kohlab-pty-test-old")));
  check("listing killed nothing", alive(daemon.pid));

  console.log("apply (only what was listed)");
  const applied = tool(["--apply"]);
  check("apply runs", applied.status === 0, applied.stderr);
  check("the unreferenced test folders are gone", !existsSync(join(works, "kohlab-test-gone")) && !existsSync(join(works, "kohlab-pty-test-old")));
  check("the referenced folder stays", existsSync(join(works, "kohlab-test-keep")));
  check("the non-test folder stays", existsSync(join(works, "not-a-test")));
  check("the link stays and what it points at is untouched", existsSync(join(works, "kohlab-test-link")) && existsSync(join(outside, "keep-me.txt")));
  check("state.json stays", existsSync(join(works, "state.json")));
  check("the stray daemon is stopped", await (async () => {
    for (let i = 0; i < 40 && alive(daemon.pid); i++) await sleep(100);
    return !alive(daemon.pid);
  })());
  check("each removal is printed", /removed folder .*kohlab-test-gone/.test(applied.stdout) && /stopped daemon pid/.test(applied.stdout), applied.stdout);

  console.log("refusal when state.json cannot be read");
  const bad = join(tmp, "works-bad");
  mkdirSync(join(bad, "kohlab-test-stays"), { recursive: true });
  writeFileSync(join(bad, "state.json"), "{ not json");
  const refused = spawnSync(process.execPath, [LEFTOVERS, "--dirs-only", "--sockets-under", tmp, "--apply"], {
    encoding: "utf8",
    env: { ...process.env, WORKS_DIR: bad, PTY_SOCKET: live },
  });
  check("apply with an unreadable state.json removes nothing", existsSync(join(bad, "kohlab-test-stays")) && /state\.json cannot be read|refused/.test(refused.stdout), refused.stdout);
} finally {
  try {
    if (daemon && alive(daemon.pid)) daemon.kill("SIGKILL");
  } catch {
    /* gone */
  }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : "\nall leftovers checks passed");
process.exit(failed ? 1 : 0);
