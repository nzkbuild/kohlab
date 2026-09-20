#!/usr/bin/env node
/**
 * Run every check. One command:
 *
 *   node scripts/check-all.mjs        (or: bun run check)
 *
 * Starts its own throwaway server on its own port, socket and state directory,
 * so it never touches a running instance. Add `--verbose` to see each check's
 * full output rather than just its tail on failure.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const VERBOSE = process.argv.includes("--verbose");
const PORT = 7801;
const KEY = "check-all-key";

const results = [];

function banner(text) {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
}

function run(name, cmd, args, cwd = ROOT) {
  const started = Date.now();
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", env: process.env });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const ok = res.status === 0;
  const ms = Date.now() - started;
  results.push({ name, ok, ms });
  console.log(`  ${ok ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}  \x1b[2m(${ms}ms)\x1b[0m`);
  if (VERBOSE || !ok) {
    // Show what failed, not the whole log, unless asked.
    const lines = out.trim().split("\n");
    const shown = VERBOSE ? lines : lines.slice(-14);
    for (const l of shown) console.log(`       ${l}`);
  }
  return ok;
}

/**
 * Kill the detached PTY daemon this run spawned.
 *
 * The server spawns it detached so it outlives the server — that is the
 * product's promise, not a bug. In a throwaway run it simply leaks: one daemon
 * per check run stays behind, holding memory and a stale socket, and the
 * documented way to end agents (`pkill -f pty-daemon.cjs`) would then take out
 * the live deployment's daemon too. Match on our own PTY_SOCKET so only this
 * run's daemon dies.
 */
function killDaemon(socketPath) {
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("pty-daemon.cjs")) continue;
      if (!readFileSync(`/proc/${pid}/environ`, "utf8").includes(`PTY_SOCKET=${socketPath}`)) continue;
      process.kill(Number(pid), "SIGTERM");
    } catch {
      /* gone, or not readable — either way not ours */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), "kohlab-checkall-"));
const works = join(tmp, "works");
let server = null;

try {
  banner("kohlab — full check suite");

  banner("static checks");
  run("diff splitter", "bun", ["scripts/check-diff.ts"]);
  run("token contrast (WCAG 2.2 AA)", "node", ["scripts/check-contrast.mjs"]);
  run("screen model", "node", ["scripts/check-screen.mjs"]);
  run("corruption handling", "node", ["scripts/check-corruption.mjs"]);
  run("safe update (save → install → reload)", "node", ["scripts/check-update.mjs"]);
  run("release checking (OTA)", "bun", ["scripts/check-release.ts"]);
  run("cli surface", "node", ["scripts/check-cli.mjs"]);
  run("backend types", join(ROOT, "node_modules/.bin/tsc"), ["--noEmit"]);
  run("frontend types", join(ROOT, "web/node_modules/.bin/tsc"), ["--noEmit"], join(ROOT, "web"));

  banner("backend contract (against a throwaway server)");
  server = spawn("bun", ["run", "server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      KOHLAB_KEY: KEY,
      WORKS_DIR: join(works, ".works"),
      PTY_SOCKET: join(works, "pty.sock"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (d) => {
    serverLog += d.toString();
  });
  server.stderr.on("data", (d) => {
    serverLog += d.toString();
  });

  let up = false;
  for (let i = 0; i < 60; i++) {
    up = await fetch(`http://127.0.0.1:${PORT}/api/auth/required`)
      .then((r) => r.ok)
      .catch(() => false);
    if (up) break;
    await sleep(150);
  }

  if (!up) {
    results.push({ name: "start throwaway server", ok: false, ms: 0 });
    console.log("  \x1b[31mFAIL\x1b[0m start throwaway server");
    console.log(`       ${serverLog.trim().split("\n").slice(-10).join("\n       ")}`);
  } else {
    run("backend contract (keyed)", "node", ["scripts/smoke.mjs", String(PORT), `--key=${KEY}`]);
  }
} finally {
  try {
    server?.kill("SIGKILL");
  } catch {
    /* gone */
  }
  // the daemon is detached, so killing the server does not take it with us
  try {
    killDaemon(join(works, "pty.sock"));
  } catch {
    /* nothing to do */
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* gone */
  }

  const failed = results.filter((r) => !r.ok);
  banner(failed.length ? `${results.length - failed.length}/${results.length} passed` : `all ${results.length} checks passed`);
  if (failed.length) {
    console.log("\nfailed:");
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exit(1);
  }
}
