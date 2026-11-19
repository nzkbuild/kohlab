// Shared by the checks that touch the machine (v2.9.4): they remove what they added, in a finally.
// ACL entries live on the directories above a temp dir (grantTraverse adds `u:<name>:x` to each
// one that is not already open), so cleanup walks the same chain and removes the entry there.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/** The agent CLIs the server looks for (server.ts handleAgentsStatus). Their real paths get the same traverse ACL. */
export const AGENT_COMMANDS = ["omp", "hermes", "claude", "codex", "codex-acp", "opencode", "pi", "gemini"];

/** `p` and every directory above it, up to and including "/". */
export function ancestors(p) {
  const out = [];
  for (let d = dirname(p); ; d = dirname(d)) {
    out.push(d);
    if (d === "/") break;
  }
  return out;
}

/** The real paths of the agent CLIs on this machine (what ensureAgentUser walks to). */
export function agentBinaryPaths() {
  const out = [];
  for (const n of AGENT_COMMANDS) {
    const bin = spawnSync("sh", ["-c", `command -v ${n}`], { encoding: "utf8" }).stdout.trim();
    if (!bin) continue;
    out.push(spawnSync("readlink", ["-f", bin], { encoding: "utf8" }).stdout.trim() || bin);
  }
  return out;
}

/**
 * Remove the ACL entries for one account from `paths` and every directory above them.
 * Pass `name` while the account exists, and `uid` once it is gone (userdel leaves the
 * numeric entry behind). Silent when there is nothing to remove.
 */
export function dropAcl(paths, { name, uid } = {}) {
  const dirs = new Set(paths.flatMap((p) => ancestors(p)));
  const who = [name, uid].filter((x) => x !== undefined && x !== null && x !== "");
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const w of who) spawnSync("setfacl", ["-x", `u:${w}`, d], { encoding: "utf8" });
  }
}

/** True when an ACL entry for `name` or numeric `uid` is still on `path` (or on a directory above it). */
export function aclLeft(path, { name, uid }) {
  const out = spawnSync("getfacl", ["-n", "-p", path], { encoding: "utf8" }).stdout ?? "";
  return out.split("\n").some((l) => (name && l.startsWith(`user:${name}:`)) || (uid !== undefined && l.startsWith(`user:${uid}:`)));
}

/** Remove a temp dir the check made (recursive, never following a link at the top). */
export function removeTemp(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Account names on this machine that match a prefix (from /etc/passwd). */
export function accountsLike(re) {
  try {
    return readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .map((l) => l.split(":")[0])
      .filter((n) => n && re.test(n));
  } catch {
    return [];
  }
}

/** Every directory name under /proc that is a PID. */
export function pids() {
  return readdirSync("/proc").filter((p) => /^\d+$/.test(p));
}
