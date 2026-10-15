#!/usr/bin/env bun
/**
 * Project model choice: parseModel accepts exactly the three aliases and
 * "default", and refuses anything else. No claude process is started here.
 *
 * Run:  bun scripts/check-model.mjs
 */
import { parseModel } from "../lib.ts";

let failures = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

check("opus is accepted", parseModel("opus"), "opus");
check("sonnet is accepted", parseModel("sonnet"), "sonnet");
check("haiku is accepted", parseModel("haiku"), "haiku");
check("default is accepted (clears the choice)", parseModel("default"), "default");
check("upper case is refused", parseModel("Opus"), null);
check("a full model id is refused", parseModel("claude-opus-4-1"), null);
check("empty string is refused", parseModel(""), null);
check("undefined is refused", parseModel(undefined), null);
check("a number is refused", parseModel(3), null);
check("an object is refused", parseModel({ model: "opus" }), null);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall model checks passed");
