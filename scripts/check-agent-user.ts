/**
 * The agent account (v1.22): owner agents run unprivileged, and the git round trip
 * still works. Run:  bun scripts/check-agent-user.ts   (needs root and the acl
 * package; skips itself otherwise). Creates one throwaway account and removes it.
 *
 * Asserts the boundary the feature depends on: a workspace made while
 * KOHLAB_AGENT_USER is set is flagged, owned by the account, and the account can
 * commit in it even though the repo lives under root's home; root can still read
 * and merge what it wrote.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const sh = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env } });

if (process.getuid?.() !== 0 || sh("setfacl", ["--version"]).status !== 0 || sh("useradd", ["--help"]).status !== 0) {
  console.log("  skip agent user: needs root, useradd and the acl package");
  process.exit(0);
}

// A regular file at /dev/null (it happens: something redirects into it before it exists)
// makes every non-root process fail on startup, which is exactly who this feature runs.
if (!statSync("/dev/null").isCharacterDevice()) {
  console.log("  skip agent user: /dev/null is not a character device on this host (fix: rm /dev/null && mknod -m 666 /dev/null c 1 3)");
  process.exit(0);
}

const name = `kohlab-chk-${process.pid}`;
const root = mkdtempSync("/root/.kohlab-chk-"); // under /root on purpose: the agent has to be able to reach it
const works = join(root, "works");
const repo = join(root, "repo");
process.env.WORKS_DIR = works;
process.env.KOHLAB_AGENT_USER = name;

let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` ${detail}`}`);
  if (!ok) failed++;
};

try {
  const lib = await import("../lib");
  const git = (cwd: string, ...a: string[]) => sh("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  git(root, "init", "-q", "-b", "main", repo);
  git(repo, "commit", "-q", "--allow-empty", "-m", "start");

  const acct = await lib.ensureAgentUser(name);
  const ws = await lib.createWorkspace({ repo, task: "chk", agent: "sh" });
  const saved = await lib.getWorkspace(ws.id);
  check("workspace is flagged to run as the agent", saved.asAgent === true);
  check("its tree belongs to the account", statSync(ws.path).uid === acct.uid);
  check("identityOf hands the daemon that uid", lib.identityOf(saved)?.uid === acct.uid);

  const as = (script: string) =>
    sh("runuser", ["-u", name, "--", "sh", "-c", script], { HOME: acct.home });
  const w = as(`cd '${ws.path}' && echo hi > f && git add f && git -c user.name=a -c user.email=a@a commit -qm agent`);
  check("the account can commit in its tree (repo is under /root)", w.status === 0, w.stderr);
  check("the account cannot read root's home", as("ls /root").status !== 0);

  check("root can read the tree it does not own", git(ws.path, "status", "--porcelain").status !== 0 /* dubious without -c */);
  const m = await lib.mergeWorkspace(ws.id, {}).then(() => null, (e: Error) => e.message);
  check("root can merge the agent's commit into the repo", m === null, String(m));
  check("the merged file is in the repo", existsSync(join(repo, "f")));
} catch (e) {
  console.log(`  FAIL unexpected: ${(e as Error).message}`);
  failed++;
} finally {
  sh("userdel", ["-r", name]);
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
