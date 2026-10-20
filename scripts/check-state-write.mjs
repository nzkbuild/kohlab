#!/usr/bin/env bun
/**
 * State file writes: concurrent first-run loads and saves must not fail. Every
 * atomic write goes to its own temp file, so two writes at once never share one
 * (the fixed `state.json.tmp` used to make the second rename fail with ENOENT).
 * Runs in a throwaway WORKS_DIR; the real state is never touched.
 *
 * Run:  bun scripts/check-state-write.mjs
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "kohlab-state-write-"));
process.env.WORKS_DIR = join(dir, "works");
let failures = 0;

function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
}

try {
  const { loadState, saveState, STATE_FILE, WORKS_DIR } = await import("../lib.ts");

  // a fresh install: no state file yet, so every first read writes one
  const results = await Promise.allSettled([
    ...Array.from({ length: 20 }, () => loadState()),
    ...Array.from({ length: 20 }, (_, i) => saveState({ schemaVersion: 1, workspaces: [], agents: {}, note: `save ${i}` })),
  ]);
  const failed = results.filter((r) => r.status === "rejected");
  check("20 concurrent first-run loads and saves all succeed", failed.length === 0, failed[0]?.reason?.message);

  const saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  check("the state file is whole JSON after the race", typeof saved === "object" && saved !== null);
  const leftovers = readdirSync(WORKS_DIR).filter((f) => f.endsWith(".tmp"));
  check("no temp files left behind", leftovers.length === 0, leftovers.join(", "));

  // a second round, over the existing file, still succeeds
  const again = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => saveState({ schemaVersion: 1, workspaces: [], agents: {}, note: `again ${i}` })));
  check("20 concurrent saves over an existing file all succeed", again.every((r) => r.status === "fulfilled"));
} catch (e) {
  check("state writes run without throwing", false, e.message);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall state write checks passed");
