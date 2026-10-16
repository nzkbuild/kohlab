#!/usr/bin/env bun
/**
 * A Claude project's earlier conversations: which transcript files are listed, in what order,
 * and how each is titled. Reads only a temporary folder; no claude process is started here.
 *
 * Run:  bun scripts/check-sessions.mjs
 */
import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions } from "../chat.ts";

const cwd = "/srv/works/demo/tree";
let failures = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

const user = (content, extra = {}) => JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });

const dir = mkdtempSync(join(tmpdir(), "kohlab-sessions-"));
try {
  const a = join(dir, "a.jsonl");
  writeFileSync(a, [user("first ask"), user("second")].join("\n") + "\n");
  writeFileSync(join(dir, "b.jsonl"), user("<command-name>/clear</command-name>\n<command-message>clear</command-message>") + "\n");
  const long = "w".repeat(200);
  writeFileSync(join(dir, "c.jsonl"), user(long) + "\n");
  writeFileSync(join(dir, "x y.jsonl"), user("bad name") + "\n");
  symlinkSync(a, join(dir, "d.jsonl"));
  writeFileSync(join(dir, "notes.txt"), user("not a transcript") + "\n");

  // a is older than c, so c lists first
  utimesSync(a, new Date(Date.now() - 100_000), new Date(Date.now() - 100_000));

  const got = listSessions(dir, cwd);
  check("only real, named transcripts with a user message are listed, newest first", got.map((s) => s.id), ["c", "a"]);
  check("title is the first thing asked", got.find((s) => s.id === "a")?.title, "first ask");
  check("long title cut to 80 characters with an ellipsis", got.find((s) => s.id === "c")?.title, `${"w".repeat(80)}…`);
  check("the listed time is the file's modification time", Math.round((got.find((s) => s.id === "a")?.at ?? 0) / 1000), Math.round((Date.now() - 100_000) / 1000));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

check("a missing folder lists nothing", listSessions(join(dir, "gone"), cwd), []);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall session checks passed");
