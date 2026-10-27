#!/usr/bin/env bun
/**
 * The helper tree of the run view (chat.ts applyHelperLine): what each line of the CLI's stream does to
 * the list of helpers, and what a done line carries. Pure: no AI is started. Every field of a task line
 * is optional in the CLI's schema, so lines with fields missing or unknown must change nothing and break nothing.
 *
 * Run:  bun scripts/check-helpers.ts
 */
import { applyHelperLine, doneFields, helpersAtExit, helpersAtResult, helpersNewTurn, type HelperNode } from "../chat.ts";

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

const T = 1_000_000;
const run = (lines: any[], start: HelperNode[] = [], at = T): HelperNode[] => lines.reduce((nodes: HelperNode[], m: any, i: number) => applyHelperLine(nodes, m, at + i * 1000), start);
const toolUse = (id: string, input: any = {}, extra: any = {}) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Agent", input }] }, ...extra });

// tool_use first, then task_started merges on tool_use_id
let n = run([
  toolUse("tu1", { description: "Look at the styles", subagent_type: "Explore", model: "haiku" }),
  { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "tu1", description: "Look at the styles", subagent_type: "Explore", is_backgrounded: true },
]);
check("tool_use then task_started make one helper", n.length === 1 && n[0].id === "tu1" && n[0].taskId === "t1", JSON.stringify(n));
check("label, kind, model, background, running", n[0].label === "Look at the styles" && n[0].kind === "Explore" && n[0].model === "haiku" && n[0].background === true && n[0].status === "running" && n[0].startedAt === T);

// task_started first
n = run([
  { type: "system", subtype: "task_started", task_id: "t9", description: "Check the links" },
  toolUse("tu9", { description: "Check the links" }),
]);
check("task_started alone makes a helper with an opaque id", n.length === 2 && n[0].id === "task:t9" && n[0].taskId === "t9" && n[0].label === "Check the links");
n = run([{ type: "system", subtype: "task_started", task_id: "t9", tool_use_id: "tu9", description: "Check the links" }, toolUse("tu9", { description: "Check the links" })]);
check("task_started first, tool_use after, still one helper", n.length === 1 && n[0].id === "tu9" && n[0].taskId === "t9");

// a background command is a task but not a helper
check("a background shell task is not a helper", run([{ type: "system", subtype: "task_started", task_id: "b1", task_type: "local_bash", description: "sleep 300" }]).length === 0);

// nested
n = run([
  { type: "system", subtype: "task_started", task_id: "child", description: "Child", parent_task_id: "parent" },
  { type: "system", subtype: "task_started", task_id: "parent", description: "Parent" },
]);
check("a child names its parent, and the parent is listed first", n.length === 2 && n[0].taskId === "parent" && n[1].taskId === "child" && n[1].parentId === n[0].id, JSON.stringify(n.map((x) => [x.id, x.parentId])));
n = run([toolUse("tuP", { description: "Parent" }), toolUse("tuC", { description: "Child" }, { parent_tool_use_id: "tuP" })]);
check("a helper started by a helper is its child", n[1].parentId === "tuP");

// progress
n = run([
  toolUse("tu1", { description: "Work" }),
  { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "tu1", description: "Work" },
  { type: "system", subtype: "task_progress", task_id: "t1", tool_use_id: "tu1", description: "Work", usage: { total_tokens: 1234, tool_uses: 3, duration_ms: 900 }, last_tool_name: "Grep", summary: "Reading the styles" },
]);
check("progress sets steps, tokens, last step and summary", n[0].tools === 3 && n[0].tokens === 1234 && n[0].lastTool === "Grep" && n[0].summary === "Reading the styles");
const long = run([...[toolUse("tu1", {})], { type: "system", subtype: "task_progress", tool_use_id: "tu1", summary: "x".repeat(500) }]);
check("a summary is cut to 200", long[0].summary?.length === 200);

// a helper's own assistant line gives its model and last tool
n = run([
  toolUse("tu1", { description: "Work" }),
  { type: "assistant", parent_tool_use_id: "tu1", message: { model: "claude-haiku-4-5", content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "x", name: "Read", input: {} }] } },
]);
check("the helper's model comes from its own line (over the model asked for)", n[0].model === "claude-haiku-4-5" && n[0].lastTool === "Read");

// task_updated, task_notification
n = run([
  toolUse("tu1", { run_in_background: true }),
  { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "tu1", description: "Work" },
  { type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "completed", end_time: 1_700_000_000 } },
]);
check("task_updated completed ends it, end_time in seconds becomes ms", n[0].status === "done" && n[0].endedAt === 1_700_000_000_000);
n = run([toolUse("tu1", {}), { type: "system", subtype: "task_updated", task_id: "x", patch: { status: "failed" } }]);
check("task_updated for an unknown task changes nothing", n[0].status === "running");
n = run([toolUse("tu1", {}), { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "tu1" }, { type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "killed" } }]);
check("killed is stopped", n[0].status === "stopped" && n[0].endedAt !== null);
for (const [status, want] of [["completed", "done"], ["failed", "failed"], ["stopped", "stopped"]] as const) {
  n = run([toolUse("tu1", {}), { type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "tu1", status, summary: "All done", output_file: "/x" }]);
  check(`task_notification ${status} is ${want}, with its summary`, n[0].status === want && n[0].summary === "All done" && n[0].endedAt !== null);
}

// tool_result ends a foreground helper, not a background one
const result = (id: string, is_error = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error, content: "x" }] } });
check("a foreground helper is done when its call returns", run([toolUse("a", {}), result("a")])[0].status === "done");
check("a failed call is failed", run([toolUse("a", {}), result("a", true)])[0].status === "failed");
check("a background helper goes on after its call returns", run([toolUse("a", { run_in_background: true }), result("a")])[0].status === "running");
check("a call that returns after the helper ended changes nothing", (() => {
  const x = run([toolUse("a", {}), { type: "system", subtype: "task_notification", tool_use_id: "a", status: "failed" }, result("a")]);
  return x[0].status === "failed";
})());

// tolerance
const before = run([toolUse("a", {})]);
for (const junk of [null, 7, "x", {}, { type: "system" }, { type: "system", subtype: "task_started" }, { type: "system", subtype: "task_progress" }, { type: "system", subtype: "task_updated" }, { type: "system", subtype: "task_notification", status: 5 }, { type: "stream_event" }, { type: "assistant" }, { type: "assistant", message: { content: "text" } }, { type: "user", message: { content: [null, 3] } }, { type: "system", subtype: "task_progress", tool_use_id: "a", usage: "lots", last_tool_name: 5, summary: {} }])
  check(`a line with missing or odd fields is ignored: ${JSON.stringify(junk)?.slice(0, 50)}`, (() => {
    const out = applyHelperLine(before, junk, T);
    return out.length === 1 && out[0].status === "running" && out[0].tools === null && out[0].summary === null;
  })());
check("a line that is not about helpers returns the same list", applyHelperLine(before, { type: "stream_event", event: {} }, T) === before);
check("the list given is never changed", (() => {
  const copy = JSON.stringify(before);
  applyHelperLine(before, { type: "system", subtype: "task_notification", tool_use_id: "a", status: "completed" }, T);
  return JSON.stringify(before) === copy;
})());

// cap and order
const many = run(Array.from({ length: 60 }, (_, i) => toolUse(`h${i}`, { description: `h${i}` })));
check("at most 50 helpers", many.length === 50);
const mixed = run([...Array.from({ length: 50 }, (_, i) => toolUse(`h${i}`, {})), result("h3"), toolUse("new", {})]);
check("when full, a finished helper goes first", mixed.length === 50 && !mixed.some((x) => x.id === "h3") && mixed.some((x) => x.id === "new"));
const unordered = run([toolUse("c", {}, { parent_tool_use_id: "p" }), toolUse("p", {})]);
check("parents come before children, however they arrived", unordered[0].id === "p" && unordered[1].id === "c");
check("a long label is cut to 80", run([toolUse("a", { description: "y".repeat(300) })])[0].label.length <= 80);

// life of a turn
const mix: HelperNode[] = run([toolUse("fg", {}), toolUse("bg", { run_in_background: true })]);
const ended = helpersAtResult(mix, T + 9);
check("at a result, foreground helpers are done and background ones go on", ended[0].status === "done" && ended[0].endedAt === T + 9 && ended[1].status === "running");
check("a new turn drops finished helpers and keeps running ones", helpersNewTurn(ended).map((x) => x.id).join() === "bg");
check("when the process ends nothing is running", helpersAtExit(ended, T + 20).every((x) => x.status !== "running") && helpersAtExit(ended, T + 20)[1].status === "stopped");

// the done line
check("done carries the model and the tokens", JSON.stringify(doneFields("claude-sonnet-5-5", { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 40 })) === '{"model":"claude-sonnet-5-5","tokens":{"in":115,"out":40}}');
check("done leaves out what is unknown", JSON.stringify(doneFields(null, undefined)) === "{}" && JSON.stringify(doneFields("", {})) === "{}");
check("done: model without usage, usage without model", JSON.stringify(doneFields("m", null)) === '{"model":"m"}' && JSON.stringify(doneFields(undefined, { output_tokens: 7 })) === '{"tokens":{"in":0,"out":7}}');
check("done: odd usage values are ignored", JSON.stringify(doneFields("m", { input_tokens: "many", output_tokens: -3 })) === '{"model":"m"}');

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
