#!/usr/bin/env bun
/**
 * Continue fresh (chat.ts): reading the handoff note out of an AI's reply, the first message of the
 * new session, and when Kohlab continues fresh by itself. Pure: no AI is started.
 *
 * Run:  bun scripts/check-fresh.ts
 */
import { extractHandoff, freshDecision, freshMessage, handoffHasWork, HANDOFF_REQUEST } from "../chat.ts";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name} ${detail}`);
  }
}

// ---- the note in the reply ----
const NOTE = "## Goal\nBuild a page\n\n## In progress\nThe header";
check("a handoff block is read", extractHandoff(`\`\`\`handoff\n${NOTE}\n\`\`\``) === NOTE);
check("words around the block are ignored", extractHandoff(`Sure.\n\`\`\`handoff\n${NOTE}\n\`\`\`\nDone.`) === NOTE);
check("no block gives null", extractHandoff("Here is a summary with no block.") === null);
check("a block of another kind is not the note", extractHandoff("```js\nlet a = 1\n```") === null);
check("an unfinished block gives null", extractHandoff("```handoff\n## Goal\nBuild a page") === null);
check("an empty block gives null", extractHandoff("```handoff\n\n```") === null);
check("with two blocks the first one is used", extractHandoff("```handoff\nfirst\n```\n\n```handoff\nsecond\n```") === "first");
check("an unfinished block before a good one is skipped", extractHandoff("```handoff\nlost\n") === null && extractHandoff("```handoff\nA\n```\ntext\n```handoff\nB\n```") === "A");
check("a code fence with a language inside the note stays in it", extractHandoff("```handoff\n## Files that matter\n```js\nlet a = 1\n```\n## Open questions\nNone\n```") === "## Files that matter\n```js\nlet a = 1\n```\n## Open questions\nNone");
check("a block opened with four backticks may hold plain fences", extractHandoff("````handoff\nbefore\n```\ncode\n```\nafter\n````") === "before\n```\ncode\n```\nafter");
check("windows line ends are fine", extractHandoff("```handoff\r\nline\r\n```\r\n") === "line");
check("the note is cut to 8000 characters", extractHandoff(`\`\`\`handoff\n${"x".repeat(9000)}\n\`\`\``)?.length === 8000);
check("the marker is case-insensitive and may be indented a little", extractHandoff("  ```Handoff\nok\n  ```") === "ok");

// ---- does the note have work left ----
check("work under In progress", handoffHasWork("## Done\nA\n## In progress\nThe header\n## Next steps\nNone"));
check("work under Next steps", handoffHasWork("## In progress\nnone\n## Next steps\n- Add the footer"));
check("work on the heading line", handoffHasWork("**Next steps:** add the footer") && handoffHasWork("In progress: the header"));
check("nothing in either is no work", !handoffHasWork("## Goal\nBuild\n## Done\nAll of it\n## In progress\nNone\n## Next steps\nn/a\n## Open questions\nWhat colour?"));
check("only other headings holding text is no work", !handoffHasWork("## Done\nA lot\n## Key decisions\nUse plain HTML"));
check("empty headings are no work", !handoffHasWork("## In progress\n\n## Next steps\n-\n"));
check("a bullet line under a heading counts, a later heading ends it", handoffHasWork("## In progress\n- the header\n## Open questions") && !handoffHasWork("## In progress\n## Open questions\nWhat?"));

// ---- the first message of the new session ----
const msg = freshMessage("NOTE TEXT", "Always be kind", [
  { text: "Write the header", status: "done" },
  { text: "Add the footer", status: "active" },
  { text: "Test it", status: "pending" },
]);
check("it starts as the plan says", msg.startsWith("We are continuing in a fresh session. Here is the handoff note from the previous session:\nNOTE TEXT"));
check("it carries the project notes", msg.includes("Project notes:\nAlways be kind"));
check("it carries the open checklist, not the done items", msg.includes("Open checklist:\n- [~] Add the footer\n- [ ] Test it") && !msg.includes("Write the header"));
check("it ends by asking for the next step", msg.endsWith("Continue with the next step."));
const bare = freshMessage("N", "", []);
check("with no notes or checklist those parts are left out", !bare.includes("Project notes") && !bare.includes("Open checklist") && bare.includes("Continue with the next step."));
check("the request to the old session asks for the block and the headings", HANDOFF_REQUEST.includes("```handoff") && ["Goal", "Done", "In progress", "Next steps", "Key decisions", "Files that matter", "Open questions"].every((h) => HANDOFF_REQUEST.includes(h)) && HANDOFF_REQUEST.includes("Do not change any files"));

// ---- when it starts by itself ----
const idle = { percent: 90, auto: true, busy: false, waiting: false, background: false, recent: false, running: false };
check("at 85 and idle it starts now", freshDecision({ ...idle, percent: 85 }) === "now");
check("below 85 it does not", freshDecision({ ...idle, percent: 84 }) === "no" && freshDecision({ ...idle, percent: 70 }) === "no");
check("an AI that does not report its fullness never starts it", freshDecision({ ...idle, percent: null }) === "no");
check("switched off, never", freshDecision({ ...idle, auto: false }) === "no");
check("while a turn runs it waits", freshDecision({ ...idle, busy: true }) === "pending");
check("while a question is open it waits", freshDecision({ ...idle, waiting: true }) === "pending");
check("while background work runs it waits", freshDecision({ ...idle, background: true }) === "pending");
check("once the turn and background work end it goes", freshDecision({ ...idle, busy: false, background: false }) === "now");
check("not twice at the same time, and not again right after", freshDecision({ ...idle, running: true }) === "no" && freshDecision({ ...idle, recent: true }) === "no");

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
