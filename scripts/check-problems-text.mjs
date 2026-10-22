#!/usr/bin/env bun
/**
 * Problem text: the plain-English summary of what went wrong, and the message the
 * AI is sent to fix it. Pure functions only; nothing is sent here.
 *
 * Run:  bun scripts/check-problems-text.mjs
 */
import { problemSummary, problemsMessage } from "../web/src/lib/problemText.ts";

let failures = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

function checkTrue(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond || !detail ? "" : `  (${detail})`}`);
}

// summaries
check("no problems, no summary", problemSummary([]), "");
check("app did not start", problemSummary([{ kind: "devserver", text: "npm run dev exited with code 1" }]), "Your app didn't start.");
check("console error", problemSummary([{ kind: "console", text: "Uncaught TypeError: x is undefined" }]), "The page showed an error.");
check("page error", problemSummary([{ kind: "page", text: "Script error" }]), "The page showed an error.");
check(
  "failed request names the file",
  problemSummary([{ kind: "request", text: "GET 404 https://site.test/img/logo.png?v=2" }]),
  "A part of the page didn't load (logo.png).",
);
check("failed request with no file name", problemSummary([{ kind: "request", text: "GET 500 https://site.test/api/" }]), "A part of the page didn't load.");
check(
  "more than one problem adds a count",
  problemSummary([
    { kind: "console", text: "a" },
    { kind: "console", text: "b" },
    { kind: "request", text: "c" },
  ]),
  "The page showed an error. There are 3 problems in all.",
);
check("summary of one problem has no count", problemSummary([{ kind: "console", text: "a" }]).includes("problems in all"), false);

// message: one line per problem, with its label
const one = problemsMessage([{ kind: "console", text: "Uncaught TypeError: x", detail: "at main.js:3" }]);
checkTrue("message opens with the request", one.startsWith("The page has a problem. Please find out what's wrong, fix it, then check the page again.\n\n```text\n"), one);
checkTrue("message holds the labelled line with its detail", one.includes("\n[console error] Uncaught TypeError: x: at main.js:3\n"), one);
checkTrue("message closes its fence", one.endsWith("\n```"), one);

const labels = problemsMessage([
  { kind: "page", text: "p" },
  { kind: "request", text: "r" },
  { kind: "devserver", text: "d" },
]).split("\n");
checkTrue("page error label", labels.includes("[page error] p"), labels.join(" | "));
checkTrue("failed request label", labels.includes("[failed request] r"), labels.join(" | "));
checkTrue("app start label", labels.includes("[app start] d"), labels.join(" | "));

// a line break inside page text cannot start a new line of the message
const multi = problemsMessage([{ kind: "console", text: "first\nsecond", detail: "x\r\ny" }]);
checkTrue("newlines in text collapse to one line", multi.includes("[console error] first second: x y\n"), multi);

// backticks inside the text cannot close the fence
const ticks = problemsMessage([{ kind: "console", text: "```js\nalert(1)\n```" }]);
const fenceOpen = ticks.match(/\n(`{3,})text\n/);
checkTrue("fence is longer than any backtick run in the text", fenceOpen && fenceOpen[1].length >= 4, ticks);
const fence = fenceOpen ? fenceOpen[1] : "";
checkTrue("the closing fence matches the opening fence", ticks.endsWith(`\n${fence}`), ticks);
const inner = ticks.slice(ticks.indexOf(`${fence}text\n`) + fence.length + 5, ticks.lastIndexOf(`\n${fence}`));
checkTrue("the text keeps its backticks inside the fence", inner.includes("```js"), inner);

// a huge list never makes a message the chat would refuse (it takes 20 000 characters)
const big = problemsMessage(Array.from({ length: 20 }, (_, i) => ({ kind: "page", text: "e".repeat(300), detail: "d".repeat(4000) + i })));
checkTrue("a huge message stays under the cap", big.length <= 12_500 && big.includes("[page error]"), String(big.length));

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall problem text checks passed");
