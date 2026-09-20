#!/usr/bin/env node
/**
 * The CLI surface: the standard command list, the aliases, and the exit codes.
 *
 * Run:  node scripts/check-cli.mjs
 *
 * The command list is a contract — `kohlab <command>` is the whole interface, so
 * a command that silently disappears, or an alias that stops resolving, is a
 * break. Exit codes matter for the same reason: a script that runs
 * `kohlab bogus || exit` must be able to tell that nothing ran.
 *
 * Commands that touch the daemon or the network (list, status, logs, serve) are
 * named here but not executed: this check stays hermetic and must not spawn a
 * PTY daemon or reach the live one.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "kohlab-cli-"));

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
    return;
  }
  failures.push(name);
  console.log(`  FAIL ${name} ${detail}`);
}

/** Run the CLI with an isolated state dir, so it never reads a real deployment. */
function cli(args) {
  const r = spawnSync("bun", ["run", join(ROOT, "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, WORKS_DIR: tmp, KOHLAB_UNIT: "kohlab-nonexistent" },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

try {
  console.log("\nkohlab — cli surface\n");

  const bare = cli([]);
  check("no arguments prints the command list", bare.status === 0 && bare.out.includes("usage: kohlab <command>"), bare.out.slice(0, 120));
  for (const section of ["basic", "workspaces", "server", "access", "agents"]) {
    check(`the list is grouped: ${section}`, bare.out.includes(`\n${section}\n`), bare.out.slice(0, 200));
  }

  for (const flag of ["help", "-h", "--help"]) {
    const r = cli([flag]);
    check(`${flag} prints the list and exits 0`, r.status === 0 && r.out.includes("usage: kohlab <command>"));
  }

  for (const flag of ["version", "-v", "-V", "--version"]) {
    const r = cli([flag]);
    check(`${flag} prints a version`, r.status === 0 && /^kohlab \d+\.\d+\.\d+/m.test(r.out), r.out.slice(0, 80));
  }

  const standard = [
    "help", "version", "status", "doctor",
    "list", "create", "start", "stop", "restart", "logs", "diff", "commit", "remove",
    "serve", "open", "update",
    "users", "audit", "agents",
  ];
  for (const cmd of standard) {
    check(
      `documented: ${cmd}`,
      new RegExp(`\\n  ${cmd}[\\s|<]`).test(bare.out),
      bare.out.slice(0, 200),
    );
  }

  const bad = cli(["bogus"]);
  check("an unknown command exits non-zero", bad.status === 1, `exit ${bad.status}`);
  check("an unknown command says so", bad.out.includes("unknown command: bogus"));
  check("an unknown command still prints the list", bad.out.includes("usage: kohlab <command>"));

  const missing = cli(["create"]);
  check("a missing argument exits non-zero", missing.status === 1, `exit ${missing.status}`);
  check("a missing argument names the usage", missing.out.includes("usage: kohlab create"), missing.out.slice(0, 120));

  // Aliases must resolve — not merely be documented.
  for (const [alias, hint] of [["new", "create"], ["rm", "remove"], ["delete", "remove"], ["log", "logs"]]) {
    const r = cli([alias]);
    check(`alias ${alias} resolves to ${hint}`, r.status === 1 && !r.out.includes("unknown command"), r.out.slice(0, 120));
  }

  // `install` is the legacy name for doctor; it must not be "unknown" either.
  const legacy = cli(["install"]);
  check("alias install resolves to doctor", !legacy.out.includes("unknown command"), legacy.out.slice(0, 120));

  const aliases = bare.out.split("aliases:")[1] ?? "";
  for (const pair of ["ls=list", "new=create", "rm=delete=remove", "log=logs", "server=serve", "install=doctor"]) {
    check(`alias documented: ${pair}`, aliases.includes(pair), aliases.trim().slice(0, 120));
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("failed:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("cli surface intact\n");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
