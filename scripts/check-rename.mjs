#!/usr/bin/env bun
/**
 * Project names: the rename rules a person's typed name must pass, and the
 * title a push notification shows for a project. Pure functions, no server.
 *
 * Run:  bun scripts/check-rename.mjs
 */
import { checkProjectTitle, strictlyInside } from "../lib.ts";
import { projectTitleOf } from "../push.ts";

let failures = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

// rename validation
check("name is trimmed", checkProjectTitle("  Corner café  "), { ok: true, title: "Corner café" });
check("80 characters is allowed", checkProjectTitle("x".repeat(80)).ok, true);
check("81 characters is refused", checkProjectTitle("x".repeat(81)).ok, false);
check("length counts characters, not bytes", checkProjectTitle("é".repeat(80)).ok, true);
check("empty is refused", checkProjectTitle("").ok, false);
check("blank is refused", checkProjectTitle("   ").ok, false);
check("a newline inside is refused", checkProjectTitle("a\nb").ok, false);
check("a tab inside is refused", checkProjectTitle("a\tb").ok, false);
check("DEL is refused", checkProjectTitle("a\u007fb").ok, false);
check("not text is refused", checkProjectTitle(42).ok, false);
check("missing is refused", checkProjectTitle(undefined).ok, false);

// project title, as the UI shows it
check("a slug is humanised", projectTitleOf({ id: "bakery-website", task: "bakery-website" }), "Bakery website");
check("a sentence is kept as typed", projectTitleOf({ id: "x", task: "Corner café" }), "Corner café");
check("no task falls back to the id", projectTitleOf({ id: "cafe-1" }), "Cafe 1");

// which folders a delete may remove
check("inside the projects home", strictlyInside("/w/projects/cafe", "/w/projects"), true);
check("the projects home itself is not", strictlyInside("/w/projects", "/w/projects"), false);
check("trailing slash home itself is not", strictlyInside("/w/projects", "/w/projects/"), false);
check("a sibling with the same prefix is not", strictlyInside("/w/projects-x/cafe", "/w/projects"), false);
check("elsewhere is not", strictlyInside("/srv/repos/cafe", "/w/projects"), false);
check("a dot-dot path is not", strictlyInside("/w/projects/../x", "/w/projects"), false);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall project name checks passed");
