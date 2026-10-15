#!/usr/bin/env bun
/**
 * Chat attachments: the file names the composer picks for uploads, and how a sent
 * "Attached: " line is shown back. Pure functions only; nothing is uploaded here.
 *
 * Run:  bun scripts/check-attach.mjs
 */
import { pastedName, safeAttachName, splitAttached, withSuffix } from "../web/src/lib/attach.ts";

let failures = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

// safe names
check("spaces and brackets become dashes", safeAttachName("My Photo (1).png"), "My-Photo--1-.png");
check("unicode letters become dashes", safeAttachName("café.png"), "caf-.png");
check("leading dots are removed", safeAttachName("..secret.txt"), "secret.txt");
check("only dots gives the fallback", safeAttachName("..."), "file");
check("no name gives the fallback", safeAttachName(""), "file");
check("only the basename is kept", safeAttachName("some/where\\a b.pdf"), "a-b.pdf");
check("long name is cut to 80 and keeps its extension", safeAttachName(`${"a".repeat(100)}.png`), `${"a".repeat(76)}.png`);
check("name without extension is kept", safeAttachName("README"), "README");

// suffix for a clash
check("suffix goes before the extension", withSuffix("a.png", 2), "a-2.png");
check("suffix uses the last dot only", withSuffix("a.b.png", 3), "a.b-3.png");
check("name without extension gets the suffix at the end", withSuffix("README", 3), "README-3");
check("suffix keeps the name within 80", withSuffix(`${"a".repeat(80)}.png`, 12), `${"a".repeat(73)}-12.png`);

// pasted images
check("pasted png", pastedName("image/png", 1700000000000), "pasted-1700000000000.png");
check("pasted jpeg uses jpg", pastedName("image/jpeg", 5), "pasted-5.jpg");
check("unknown pasted type uses its subtype", pastedName("image/avif", 5), "pasted-5.avif");

// shown back in the bubble
check("bubble: text and files", splitAttached("make it like this\n\nAttached: uploads/a.png, uploads/b.pdf"), { body: "make it like this", files: ["a.png", "b.pdf"] });
check("bubble: files only", splitAttached("Attached: uploads/a.png"), { body: "", files: ["a.png"] });
check("bubble: plain text untouched", splitAttached("hello there"), { body: "hello there", files: [] });

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall attachment name checks passed");
