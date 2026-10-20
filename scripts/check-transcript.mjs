#!/usr/bin/env bun
/**
 * Terminal projects: Claude Code's own transcript lines become chat events. Pure:
 * no file is read and no claude process is started here.
 *
 * Run:  bun scripts/check-transcript.mjs
 */
import { transcriptEvents } from "../chat.ts";

const cwd = "/srv/works/demo/tree";
let failures = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

const user = (content, extra = {}) => JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (content, extra = {}) => JSON.stringify({ type: "assistant", message: { role: "assistant", content }, ...extra });

check("plain user string", transcriptEvents([user("make a page")], cwd), [{ kind: "user", text: "make a page" }]);
check(
  "system reminder stripped from a user message",
  transcriptEvents([user("Fix it\n<system-reminder>secret plan</system-reminder>")], cwd),
  [{ kind: "user", text: "Fix it" }],
);
check("user text that is only a system reminder is skipped", transcriptEvents([user("<system-reminder>only this</system-reminder>")], cwd), []);
check("isMeta user line is skipped", transcriptEvents([user("a note for Claude", { isMeta: true })], cwd), []);
check("sidechain user line is skipped", transcriptEvents([user("helper prompt", { isSidechain: true })], cwd), []);
check("sidechain assistant line is skipped", transcriptEvents([assistant([{ type: "text", text: "helper says" }], { isSidechain: true })], cwd), []);
check(
  "tool_result-only user line is skipped",
  transcriptEvents([user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }])], cwd),
  [],
);
check("command bookkeeping (/clear) is skipped", transcriptEvents([user("<command-name>/clear</command-name>\n<command-message>clear</command-message>")], cwd), []);
check("local command output is skipped", transcriptEvents([user("<local-command-stdout>done</local-command-stdout>")], cwd), []);
check(
  "assistant text and tool_use kept, thinking ignored",
  transcriptEvents(
    [assistant([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Looking now" }, { type: "tool_use", name: "Read", input: { file_path: `${cwd}/src/a.ts` } }])],
    cwd,
  ),
  [
    { kind: "assistant", text: "Looking now" },
    { kind: "tool", text: "Read src/a.ts" },
  ],
);
check(
  "TodoWrite is ignored",
  transcriptEvents([assistant([{ type: "tool_use", name: "TodoWrite", input: { todos: [] } }])], cwd),
  [],
);
check(
  "bookkeeping tools (ToolSearch, TaskList) are hidden",
  transcriptEvents([assistant([{ type: "tool_use", id: "h1", name: "ToolSearch", input: {} }, { type: "tool_use", id: "h2", name: "TaskList", input: {} }])], cwd),
  [],
);
check("malformed line is skipped", transcriptEvents(["{not json", user("after the bad line")], cwd), [{ kind: "user", text: "after the bad line" }]);
check(
  "attachment and system lines are skipped",
  transcriptEvents([JSON.stringify({ type: "attachment", attachment: {} }), JSON.stringify({ type: "system", subtype: "x", content: "hi" })], cwd),
  [],
);
check(
  "user blocks: text kept, image ignored",
  transcriptEvents([user([{ type: "image", source: {} }, { type: "text", text: "see this" }])], cwd),
  [{ kind: "user", text: "see this" }],
);
check(
  "background task note: one quiet line with its summary",
  transcriptEvents([user("<task-notification>\n<task-id>b1</task-id>\n<summary>Background command \"npm test\" completed (exit code 0)</summary>\n</task-notification>")], cwd),
  [{ kind: "note", text: 'Background task finished: Background command "npm test" completed (exit code 0)' }],
);
check(
  "background task note: summary cut at 120 characters",
  transcriptEvents([user(`<task-notification><summary>${"s".repeat(200)}</summary></task-notification>`)], cwd),
  [{ kind: "note", text: `Background task finished: ${"s".repeat(120)}` }],
);
check(
  "background task note without a summary",
  transcriptEvents([user("<task-notification><task-id>b1</task-id></task-notification>")], cwd),
  [{ kind: "note", text: "A background task finished" }],
);
check("helper message to Claude is skipped", transcriptEvents([user('<agent-message from="helper">done</agent-message>')], cwd), []);
check(
  "compaction line: one quiet line",
  transcriptEvents([JSON.stringify({ type: "system", subtype: "compact_boundary", compactMetadata: {} })], cwd),
  [{ kind: "note", text: "Conversation compacted to save space" }],
);
check(
  "other system lines (a retry) are skipped",
  transcriptEvents([JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1 })], cwd),
  [],
);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall transcript checks passed");
