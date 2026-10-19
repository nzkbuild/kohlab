#!/usr/bin/env bun
/**
 * Agent Client Protocol chats: what an ACP agent's session updates become in the chat, and
 * which option a permission answer picks. Pure: no agent process is started.
 *
 * The shapes are the ones hermes and omp sent in the spike (see acp.ts).
 *
 * Run:  bun scripts/check-acp.mjs
 */
import { acpDetail, acpEffects, isAcpAgent, permissionText, pickOption, planTodos } from "../acp.ts";

let failures = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

// which agents are ACP
check("hermes is an ACP agent", isAcpAgent("hermes"), true);
check("omp is an ACP agent", isAcpAgent("omp"), true);
check("claude is not", isAcpAgent("claude"), false);
check("a name from Object.prototype is not", isAcpAgent("constructor"), false);

// text: the streamed draft
check("message chunk is draft text", acpEffects({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } }), [{ kind: "text", text: "Hi" }]);
check("empty chunk does nothing", acpEffects({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } }), []);
check("thought chunk is not shown", acpEffects({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }), []);
check("commands, usage and mode updates do nothing", ["available_commands_update", "usage_update", "session_info_update", "current_mode_update"].map((u) => acpEffects({ sessionUpdate: u })).flat(), []);

// tools: a call flushes the draft first, then shows its line
const hermesCall = { sessionUpdate: "tool_call", toolCallId: "tc-017a555ba3a1", title: "terminal: echo hello > hi.txt", kind: "execute", content: [{ type: "content", content: { type: "text", text: "$ echo hello > hi.txt" } }], locations: [] };
check("tool call flushes the draft, then shows the line", acpEffects(hermesCall), [
  { kind: "flush" },
  { kind: "event", body: { kind: "tool", text: "terminal: echo hello > hi.txt", toolId: "tc-017a555ba3a1" } },
]);
const ompCall = { sessionUpdate: "tool_call", toolCallId: "toolu_bdrk_01DAngpHdJoU2GGJCR76ZeNv|fc_tmp", title: "Creating hi.txt with hello content", kind: "edit", status: "pending", rawInput: { path: "hi.txt", content: "hello" }, locations: [{ path: "/tmp/x/hi.txt" }] };
check("tool call with rawInput carries its path as the detail", acpEffects(ompCall)[1], {
  kind: "event",
  body: { kind: "tool", text: "Creating hi.txt with hello content", toolId: "toolu_bdrk_01DAngpHdJoU2GGJCR76ZeNv|fc_tmp", detail: "hi.txt" },
});
check("a command detail is the command", acpDetail({ command: "ls -la" }), "ls -la");
check("no rawInput means no detail", acpDetail(undefined), undefined);
check("a long command is cut at 2000", acpDetail({ command: "x".repeat(3000) }).length, 2000);

// results: only when finished, with the text of the content blocks
check("a completed update gives its result", acpEffects({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "terminal result\n- **exit_code:** 0" } }] }), [
  { kind: "event", body: { kind: "result", toolId: "tc-1", output: "terminal result\n- **exit_code:** 0" } },
]);
check("an in-progress update gives nothing", acpEffects({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "Writing..." } }] }), []);
check("a failed update is a failed result", acpEffects({ sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "failed", content: [] }), [
  { kind: "event", body: { kind: "result", toolId: "tc-2", output: "", failed: true } },
]);
check("a completed call with no output shows no result", acpEffects({ sessionUpdate: "tool_call_update", toolCallId: "tc-3", status: "completed", content: [{ type: "diff", path: "a", oldText: "", newText: "b" }] }), []);
check("a call that is finished when it starts gets its result too", acpEffects({ sessionUpdate: "tool_call", toolCallId: "tc-4", title: "Read a.txt", status: "completed", content: [{ type: "content", content: { type: "text", text: "a" } }] }).map((e) => e.kind), ["flush", "event", "event"]);

// the checklist
check("plan entries become the checklist", acpEffects({ sessionUpdate: "plan", entries: [{ content: "Make file", status: "completed", priority: "high" }, { content: "Check it", status: "in_progress", priority: "medium" }, { content: "Tell", status: "pending", priority: "low" }] }), [
  { kind: "todos", todos: [{ text: "Make file", status: "done" }, { text: "Check it", status: "active" }, { text: "Tell", status: "pending" }] },
]);
check("plan entries without text are skipped", planTodos([{ status: "pending" }, { content: "ok", status: "pending" }]), [{ text: "ok", status: "pending" }]);

// permissions: which option an answer picks
const opts = [
  { optionId: "ao", kind: "allow_always" },
  { optionId: "ro", kind: "reject_once" },
  { optionId: "ai", kind: "allow_once" },
];
check("allow picks allow_once first", pickOption(opts, true), "ai");
check("allow falls back to allow_always", pickOption([{ optionId: "ao", kind: "allow_always" }, { optionId: "rr", kind: "reject_always" }], true), "ao");
check("allow with no allow option takes the first", pickOption([{ optionId: "x", kind: "other" }], true), "x");
check("refuse picks reject_once", pickOption(opts, false), "ro");
check("refuse falls back to reject_always", pickOption([{ optionId: "ao", kind: "allow_once" }, { optionId: "rr", kind: "reject_always" }], false), "rr");
check("refuse with only allow options is cancelled", pickOption([{ optionId: "ai", kind: "allow_once" }], false), null);
check("allow with no options is cancelled", pickOption([], true), null);

// the question text
check("permission text names the agent and the action", permissionText("hermes", "terminal: echo hi"), "Hermes wants to do this: terminal: echo hi");
check("permission text without a title", permissionText("omp", "  "), "Omp wants to do something");

if (failures) {
  console.log(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall ok");
