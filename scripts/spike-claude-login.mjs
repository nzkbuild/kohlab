#!/usr/bin/env node
/**
 * Spike S1 (v2.6): can `claude auth login --claudeai` run as a managed child with piped stdio, under its own empty
 * CLAUDE_CONFIG_DIR? Does the sign-in link print, and is a pasted code read from stdin? A FAKE code is pasted, so no
 * sign-in completes. HOME and the config dir are throwaway.
 *
 *   node scripts/spike-claude-login.mjs [script]     "script" runs it under a pty (script -qefc) instead of plain pipes
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const viaPty = process.argv[2] === "script";
const base = mkdtempSync(join(tmpdir(), "kohlab-s1-"));
const cfg = join(base, "cfg"), home = join(base, "home");
mkdirSync(cfg, { mode: 0o700 });
mkdirSync(home);
const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: cfg, TERM: "dumb", LANG: "C.UTF-8" };
const [cmd, args] = viaPty ? ["script", ["-qefc", "claude auth login --claudeai", "/dev/null"]] : ["claude", ["auth", "login", "--claudeai"]];
const c = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
const t0 = Date.now();
const show = (tag) => (d) => console.log(`[+${Date.now() - t0}ms ${tag}]`, JSON.stringify(d.toString().replace(/state=[\w-]+/g, "state=…").replace(/code_challenge=[\w-]+/g, "code_challenge=…")));
c.stdout.on("data", show("stdout"));
c.stderr.on("data", show("stderr"));
c.on("exit", (code, sig) => console.log("exit", code, sig));
setTimeout(() => c.stdin.write("FAKECODE#FAKESTATE\r\n"), 4000);
setTimeout(() => c.kill("SIGTERM"), 9000);
setTimeout(() => {
  console.log("config dir after:", readdirSync(cfg), "home after:", readdirSync(home));
  rmSync(base, { recursive: true, force: true });
  process.exit(0);
}, 10_000);
