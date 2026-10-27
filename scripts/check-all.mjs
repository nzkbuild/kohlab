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
  // A hung check must fail by name, not hold the whole run (and a CI runner) forever.
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", env: process.env, timeout: 300_000 });
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
 * The server spawns it detached so it outlives the server: that is the
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
      /* gone, or not readable, either way not ours */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), "kohlab-checkall-"));
const works = join(tmp, "works");
let server = null;

try {
  banner("kohlab, full check suite");

  banner("static checks");
  run("chat lines (describeTool, describeAsk)", "bun", ["scripts/check-chat.mjs"]);
  run("chat notes, worked time, project download", "bun", ["scripts/check-chat-notes.mjs"]);
  run("state file writes (concurrent first-run saves)", "bun", ["scripts/check-state-write.mjs"]);
  run("turn checkpoints (snapshot, what a message changed, go back)", "bun", ["scripts/check-checkpoints.mjs"]);
  run("agent client protocol (update mapping, permission choices)", "bun", ["scripts/check-acp.mjs"]);
  run("terminal transcript lines (what the chat view shows)", "bun", ["scripts/check-transcript.mjs"]);
  run("project names (rename rules, notification titles)", "bun", ["scripts/check-rename.mjs"]);
  run("web preview paths (no escape from the worktree)", "bun", ["scripts/check-preview.mjs"]);
  run("shared browser rules (dev command, dev URL, allowed URLs)", "bun", ["scripts/check-browser-unit.mjs"]);
  run("shared browser coordinates (letterbox, clamp)", "bun", ["scripts/check-browser-coords.mjs"]);
  run("chat markdown (code, links, lists, headings)", "bun", ["scripts/check-markdown.mjs"]);
  run("problems (dev server failures, page rules, share refused)", "bun", ["scripts/check-problems.mjs"]);
  run("problems text (summaries, fences, the message to the AI)", "bun", ["scripts/check-problems-text.mjs"]);
  run("point (pick checks, label and line, round trip)", "bun", ["scripts/check-pick.mjs"]);
  run("point text (labels, lines, chips)", "bun", ["scripts/check-point-text.mjs"]);
  run("picture markup (strokes, undo, clear)", "bun", ["scripts/check-markup.mjs"]);
  run("earlier versions as files (no links, dotfiles, climbs)", "bun", ["scripts/check-version-look.mjs"]);
  run("copy a project (history, notes, gate, title)", "bun", ["scripts/check-copy.mjs"]);
  run("share link proxy (expiry, credentials, caps, the app's port)", "bun", ["scripts/check-link-proxy.mjs"]);
  run("diff splitter", "bun", ["scripts/check-diff.ts"]);
  run("lifecycle status", "bun", ["scripts/check-status.ts"]);
  run("agent hooks (status from the agent, not the process)", "node", ["scripts/check-hooks.mjs"]);
  run("sidebar groups", "bun", ["scripts/check-sidebar-groups.mjs"]);
  run("home name", "bun", ["scripts/check-home-name.ts"]);
  run("token contrast (WCAG 2.2 AA)", "node", ["scripts/check-contrast.mjs"]);
  run("screen model", "node", ["scripts/check-screen.mjs"]);
  run("corruption handling", "node", ["scripts/check-corruption.mjs"]);
  run("safe update (save → install → reload)", "node", ["scripts/check-update.mjs"]);
  run("release checking (OTA)", "bun", ["scripts/check-release.ts"]);
  run("cli surface", "node", ["scripts/check-cli.mjs"]);
  run("access bootstrap", "node", ["scripts/check-access.mjs"]);
  run("auth hardening (gate, throttle, rotation, socket key)", "node", ["scripts/check-auth-hardening.mjs"]);
  run("chat pictures (own sandbox route, auth, size cap)", "node", ["scripts/check-picture.mjs"]);
  run("durability (schema, backup, rotation, daemon health)", "node", ["scripts/check-durability.mjs"]);
  run("push encryption (RFC 8291 vector)", "bun", ["scripts/check-push-crypto.ts"]);
  run("push delivery (fake push service)", "node", ["scripts/check-push-delivery.mjs"]);
  run("push stays out of terminals", "node", ["scripts/check-push.mjs"]);
  run("merge last mile", "node", ["scripts/check-merge.mjs"]);
  run("review gate (accept and discard)", "node", ["scripts/check-review-gate.mjs"]);
  run("AI hub cards (parsers, redaction, picker, cache)", "bun", ["scripts/check-providers.ts"]);
  run("helper tree and done line (stream lines, cap, order)", "bun", ["scripts/check-helpers.ts"]);
  run("continue fresh (handoff note, first message, auto rule)", "bun", ["scripts/check-fresh.ts"]);
  run("run text (picker groups, helper rows, strip, tokens)", "bun", ["scripts/check-run-text.mjs"]);
  run("static accessibility scan", "node", ["scripts/check-a11y-static.mjs"]);
  run("hooks stay above early returns (the cold-load crash)", "node", ["scripts/check-hooks-order.mjs"]);
  run("performance budgets", "node", ["scripts/check-load.mjs"]);
  // Against the built web/dist; skips with a reason when no Chromium is present.
  run("rendered UI (browser)", "node", ["scripts/check-browser.mjs"]);
  // Own throwaway servers with two chat projects; skip with a reason when no Chromium is present.
  run("hard load of a project does not crash (browser)", "node", ["scripts/check-cold-load.mjs"]);
  run("design rules: one primary, targets, one-segment switch, contrast (browser)", "node", ["scripts/check-design.mjs"]);
  run("terminal touch scroll (browser)", "node", ["scripts/check-terminal-touch.mjs"]);
  // Its own throwaway server, with a fake claude on PATH: a terminal waits for the chat's background work.
  run("background work holds the terminal (fake claude)", "node", ["scripts/check-chat-background.mjs"]);
  // Own throwaway servers with fake claude, codex, hermes and omp on PATH; the hub checks create a member and a viewer and remove them again.
  run("AI hub over HTTP (fake AIs, redaction, canary secrets)", "node", ["scripts/check-providers-http.mjs"]);
  run("helper tree and run info over HTTP (fake claude)", "node", ["scripts/check-chat-helpers.mjs"]);
  run("continue fresh over HTTP (fake claude)", "node", ["scripts/check-fresh-http.mjs"]);
  run("AI hub in the browser (Settings, picker, run strip and panel)", "node", ["scripts/check-ai-hub-ui.mjs"]);
  // Needs root, and creates two throwaway OS accounts that it removes again: it
  // skips itself with a printed reason when it cannot provision.
  run("per-user isolation (root)", "node", ["scripts/check-isolation.mjs"]);
  run("agent user (root)", "bun", ["scripts/check-agent-user.ts"]);
  run("agent claude config sync", "bun", ["scripts/check-agent-config-sync.ts"]);
  run("agent PTY env (alt screen off, no secrets)", "bun", ["scripts/check-agent-env.ts"]);
  run("invitations (root)", "node", ["scripts/check-invite.mjs"]);
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
