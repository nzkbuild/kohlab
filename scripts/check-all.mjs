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
import { accountsLike } from "./cleanup-kit.mjs";

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

// Accounts the checks make (per-user isolation, invitations, the agent user): the run must leave none behind.
const TEST_ACCOUNT = /^(kohlab-chk-|koh-)/;
const accountsAtStart = accountsLike(TEST_ACCOUNT);
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
  // Own throwaway server (sh projects, no AI): a folder with no index.html lists its pages; the pages route; share links.
  run("web preview pages (listing, escaping, JSON route, share links)", "bun", ["scripts/check-preview-pages.mjs"]);
  // Needs web/dist and Chromium (skips without); mocks the pages, preview and shared-browser calls.
  run("web preview pages in the browser (Page | Code, Look, Pages menu)", "node", ["scripts/check-preview-pages-ui.mjs"]);
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
  run("GitHub checks for an update (parser, gh gate, fail-soft)", "bun", ["scripts/check-release-checks.ts"]);
  run("cli surface", "node", ["scripts/check-cli.mjs"]);
  run("access bootstrap", "node", ["scripts/check-access.mjs"]);
  run("auth hardening (gate, throttle, rotation, socket key)", "node", ["scripts/check-auth-hardening.mjs"]);
  run("chat pictures (own sandbox route, auth, size cap)", "node", ["scripts/check-picture.mjs"]);
  run("durability (schema, backup, rotation, daemon health)", "node", ["scripts/check-durability.mjs"]);
  run("backup drill (verify, corrupt, restore elsewhere, hostile archives, daily job, routes)", "node", ["scripts/check-backup.mjs"]);
  run("Recently deleted (trash, restore, forever, purge, ownership, CLI, auto purge)", "node", ["scripts/check-trash.mjs"]);
  run("Recently deleted screen (Settings list, Undo toast, confirm copy)", "node", ["scripts/check-trash-ui.mjs"]);
  run("push encryption (RFC 8291 vector)", "bun", ["scripts/check-push-crypto.ts"]);
  run("push delivery (fake push service)", "node", ["scripts/check-push-delivery.mjs"]);
  run("push stays out of terminals", "node", ["scripts/check-push.mjs"]);
  run("merge last mile", "node", ["scripts/check-merge.mjs"]);
  run("review gate (accept and discard)", "node", ["scripts/check-review-gate.mjs"]);
  run("AI hub cards (parsers, redaction, picker, cache)", "bun", ["scripts/check-providers.ts"]);
  run("helper tree and done line (stream lines, cap, order)", "bun", ["scripts/check-helpers.ts"]);
  run("continue fresh (handoff note, first message, auto rule)", "bun", ["scripts/check-fresh.ts"]);
  run("run text (picker groups, helper rows, strip, tokens)", "bun", ["scripts/check-run-text.mjs"]);
  run("capability tiles (every AI, states, model outcome lines)", "bun", ["scripts/check-capabilities.mjs"]);
  run("static accessibility scan", "node", ["scripts/check-a11y-static.mjs"]);
  run("hooks stay above early returns (the cold-load crash)", "node", ["scripts/check-hooks-order.mjs"]);
  // Reads the built web/dist: run `cd web && bun run build` first. No lowered ||= (the frozen terminal).
  run("built bundle has no lowered ||= (the frozen terminal)", "node", ["scripts/check-bundle.mjs"]);
  run("performance budgets", "node", ["scripts/check-load.mjs"]);
  // Against the built web/dist; skips with a reason when no Chromium is present.
  run("rendered UI (browser)", "node", ["scripts/check-browser.mjs"]);
  // Own throwaway servers with two chat projects; skip with a reason when no Chromium is present.
  run("hard load of a project does not crash (browser)", "node", ["scripts/check-cold-load.mjs"]);
  run("design rules: one primary, targets, one-segment switch, contrast (browser)", "node", ["scripts/check-design.mjs"]);
  // Own throwaway server on port 7959: Settings -> AI in Soft and Plain, the colour choice and its save, the picker's outcome lines.
  run("calm app in the browser (AI tiles, capability tiles, Soft/Plain, picker lines)", "node", ["scripts/check-calm-ui.mjs"]);
  run("terminal touch scroll (browser)", "node", ["scripts/check-terminal-touch.mjs"]);
  // Own throwaway server with a sh terminal; a DECRQM query (Claude Code's start-up) must not freeze the screen.
  run("terminal survives a DECRQM query (browser)", "node", ["scripts/check-terminal-decrqm.mjs"]);
  // Own throwaway server: the header Terminal button, the status-bar button, the sidebar row (owner only) and the /terminal page run a real shell.
  run("server terminal and Terminal buttons (browser)", "node", ["scripts/check-server-shell-ui.mjs"]);
  // Own throwaway server: the server terminal is owner-only, hidden from the list, and its routes are refused but for closing a terminal.
  run("server terminal: owner only, hidden, runs sh as the server user", "node", ["scripts/check-server-shell.mjs"]);
  // Its own throwaway server, with a fake claude on PATH: a terminal waits for the chat's background work.
  run("background work holds the terminal (fake claude)", "node", ["scripts/check-chat-background.mjs"]);
  // Own throwaway servers with fake claude, codex, hermes and omp on PATH; the hub checks create a member and a viewer and remove them again.
  run("AI hub over HTTP (fake AIs, redaction, canary secrets)", "node", ["scripts/check-providers-http.mjs"]);
  run("helper tree and run info over HTTP (fake claude)", "node", ["scripts/check-chat-helpers.mjs"]);
  run("continue fresh over HTTP (fake claude)", "node", ["scripts/check-fresh-http.mjs"]);
  // Project brain (v2.7): the vault on a throwaway folder; the routes and the MCP server over HTTP with a fake claude; the graph and the Brain tab in the browser.
  run("project brain (vault, links, summary, recall, undo)", "bun", ["scripts/check-brain.ts"]);
  run("project brain over HTTP and MCP (fake claude)", "node", ["scripts/check-brain-http.mjs"]);
  // Change Kohlab itself (v2.9): a throwaway server with a local bare origin and a fake gh; nothing reaches GitHub.
  run("change Kohlab itself (release rules over HTTP, fake gh and bare origin)", "bun", ["scripts/check-kohlab.mjs"]);
  run("project brain graph (layout, sizes, recalled line)", "bun", ["scripts/check-brain-graph.mjs"]);
  // Team mode (v2.8): the pure rules and the git steps (throwaway repos), and the team's text (digests, labels).
  run("team core (areas, picks, budgets, digests, store, git on throwaway repos)", "bun", ["scripts/check-team-core.mjs"]);
  run("team text (meters, durations, agent lines, board, event labels)", "bun", ["scripts/check-team-text.mjs"]);
  run("project brain in the browser (Brain tab, Run panel)", "node", ["scripts/check-brain-ui.mjs"]);
  // AI control (v2.6): each starts its own throwaway server with a fake claude (and fake router, Codex, omp) on PATH; no model is called.
  // Team mode (v2.8): its own throwaway server with a scripted fake claude driving the real team MCP server; the Team tab in the browser.
  run("team over HTTP and MCP (fake claude)", "node", ["scripts/check-team-http.mjs"]);
  run("team tab in the browser (org chart, board, feed, phone switch)", "node", ["scripts/check-team-ui.mjs"]);
  run("AI defaults (project > default > built in, pinned by the first message, reset)", "bun", ["scripts/check-defaults.mjs"]);
  run("AI permissions (modes, Always allow, Full access, ACP decisions)", "bun", ["scripts/check-policy.mjs"]);
  run("AI accounts (second sign-in, router, canary key, custom models)", "bun", ["scripts/check-accounts.mjs"]);
  run("usage-limit fallback (next account or model, once, the way back)", "bun", ["scripts/check-fallback.mjs"]);
  run("omp model (the hub's pick sticks, a refusal is said plainly) and ACP permissions", "bun", ["scripts/check-omp-model.mjs"]);
  run("AI hub in the browser (Settings, picker, run strip and panel)", "node", ["scripts/check-ai-hub-ui.mjs"]);
  run("AI control in the browser (defaults, accounts, fallback, permissions, one message)", "node", ["scripts/check-ai-control-ui.mjs"]);
  run("AI sign-in without a terminal (main and extra accounts, sign out, timeout, agent reach)", "node", ["scripts/check-signin.mjs"]);
  run("AI OpenCode (install, browser-code sign-in, keys, profiles, card, chat lane)", "bun", ["scripts/check-opencode.mjs"]);
  run("AI sign-in in the browser (one dialog, sign out, duplicate, chat button)", "node", ["scripts/check-signin-ui.mjs"]);
  run("AI OpenCode in the browser (install, connect, keys, switch, sign out, member view)", "node", ["scripts/check-opencode-ui.mjs"]);
  run("update gate in the browser (passed, pending, failed, unknown; confirm first)", "node", ["scripts/check-update-gate-ui.mjs"]);
  run("Settings → Backups in the browser (owner view, download, delete, failure, members)", "node", ["scripts/check-backups-ui.mjs"]);
  // Needs root, and creates two throwaway OS accounts that it removes again: it
  // skips itself with a printed reason when it cannot provision.
  run("per-user isolation (root)", "node", ["scripts/check-isolation.mjs"]);
  run("agent user (root)", "bun", ["scripts/check-agent-user.ts"]);
  run("agent claude config sync", "bun", ["scripts/check-agent-config-sync.ts"]);
  run("agent PTY env (alt screen off, no secrets)", "bun", ["scripts/check-agent-env.ts"]);
  run("invitations (root)", "node", ["scripts/check-invite.mjs"]);
  run("AI user: status rules, the owner refusal, CLI and installer dry runs", "bun", ["scripts/check-ai-user.ts"]);
  run("AI user notice in Settings -> AI (browser)", "node", ["scripts/check-ai-user-notice.mjs"]);
  run("pairing claim throttle (same refusal, a clean source still works)", "node", ["scripts/check-pair-throttle.mjs"]);
  run("leftovers tool (listing, then apply in a throwaway dir)", "node", ["scripts/check-leftovers.mjs"]);
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

  // Hygiene, last: any test account that was not there at the start is a FAIL, by name.
  const left = accountsLike(TEST_ACCOUNT).filter((n) => !accountsAtStart.includes(n));
  results.push({ name: "no test accounts left behind (kohlab-chk-*, koh-*)", ok: left.length === 0, ms: 0 });
  console.log(left.length ? `  \x1b[31mFAIL\x1b[0m no test accounts left behind: ${left.join(", ")}` : "  \x1b[32mok  \x1b[0m no test accounts left behind");

  const failed = results.filter((r) => !r.ok);
  banner(failed.length ? `${results.length - failed.length}/${results.length} passed` : `all ${results.length} checks passed`);
  if (failed.length) {
    console.log("\nfailed:");
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exit(1);
  }
}
