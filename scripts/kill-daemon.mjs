import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Stop the pty daemon a throwaway server started on `socketPath`. The daemon is
 * detached and its socket is in its environment, not its command line, so
 * `pkill -f <socket>` matches nothing; read /proc/<pid>/environ instead.
 */
export function killDaemonOn(socketPath) {
  for (const pid of spawnSync("pgrep", ["-f", "pty-daemon.cjs"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`PTY_SOCKET=${socketPath}`)) process.kill(Number(pid), "SIGTERM");
    } catch {
      /* not ours, or already gone */
    }
  }
}
