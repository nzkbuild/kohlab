#!/usr/bin/env bun
/**
 * Chat workspaces: the plain-English lines the chat shows. describeTool says what
 * the agent did, describeAsk says what it is asking permission for. No claude
 * process is started here.
 *
 * Run:  bun scripts/check-chat.mjs
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerResponse, applyTaskEvent, newTaskId, askForm, describeAsk, describeTool, friendlyError, handoffText, helperLabel, noticeText, rankFiles, readCapsFile, resultText, toolDetail, todosOf, usageOf, writeCapsFile } from "../chat.ts";

const cwd = "/srv/works/demo/tree";
let failures = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

// what the agent did
check("Write inside the worktree is shown relative", describeTool("Write", { file_path: `${cwd}/hello.txt` }, cwd), "Created hello.txt");
check("Write outside the worktree stays absolute", describeTool("Write", { file_path: "/etc/x" }, cwd), "Created /etc/x");
check("Edit uses the file path", describeTool("Edit", { file_path: `${cwd}/src/a.ts` }, cwd), "Edited src/a.ts");
check("Bash prefers its description", describeTool("Bash", { command: "ls -la", description: "List files" }, cwd), "Ran: List files");
check("Bash without description cuts the command at 80", describeTool("Bash", { command: "x".repeat(100) }, cwd), `Ran: ${"x".repeat(80)}`);
check("Glob is a search", describeTool("Glob", { pattern: "*.ts" }, cwd), "Searched the files");
check("WebSearch names the query", describeTool("WebSearch", { query: "cats" }, cwd), "Searched the web for cats");
check("unknown tool falls back", describeTool("Frobnicate", {}, cwd), "Used Frobnicate");
check("browser open", describeTool("mcp__browser__agent_browser_open", { url: "https://example.com" }, cwd), "Opened https://example.com in the browser");
check("browser other tool", describeTool("mcp__browser__agent_browser_click", {}, cwd), "Used the browser");

// what the agent did, in full (the expandable line)
check("toolDetail: Bash is the command", toolDetail("Bash", { command: "ls -la" }, cwd), "ls -la");
check("toolDetail: Bash command is cut at 2000", toolDetail("Bash", { command: "x".repeat(3000) }, cwd).length, 2000);
check("toolDetail: Edit lists the old lines then the new", toolDetail("Edit", { old_string: "a\nb", new_string: "c" }, cwd), "- a\n- b\n+ c");
check("toolDetail: MultiEdit separates edits with a blank line", toolDetail("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] }, cwd), "- a\n+ b\n\n- c\n+ d");
const longEdit = toolDetail("Edit", { old_string: "x".repeat(5000), new_string: "y" }, cwd);
check("toolDetail: a long Edit is cut at 4000 and ends with the cut mark", [longEdit.length, longEdit.endsWith("\n…")], [4000, true]);
const bigWrite = Array.from({ length: 50 }, (_, i) => `l${i + 1}`).join("\n");
check("toolDetail: Write shows the first 40 lines as additions", toolDetail("Write", { file_path: "/x", content: bigWrite }, cwd), Array.from({ length: 40 }, (_, i) => `+ l${i + 1}`).join("\n"));
check("toolDetail: Glob with a path names the folder", toolDetail("Glob", { pattern: "*.ts", path: `${cwd}/src` }, cwd), "*.ts in src");
check("toolDetail: an unknown tool has no detail", toolDetail("Frobnicate", {}, cwd), undefined);

// what a tool gave back
check("resultText: a string is itself", resultText("hi"), "hi");
check("resultText: text blocks are joined with a newline", resultText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a\nb");
check("resultText: no content is empty", resultText(undefined), "");
check("resultText: colour codes are removed", resultText("\x1b[31mred\x1b[0m"), "red");
const lines100 = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
check("resultText: only the last 60 lines are kept, with the cut mark", resultText(lines100), "…\n" + Array.from({ length: 60 }, (_, i) => `line ${i + 41}`).join("\n"));
check("resultText: exactly 60 lines are kept whole", resultText(Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n")).startsWith("…"), false);

// what the agent asks before doing it
check("Bash ask: text", describeAsk("Bash", { command: "rm -rf x", description: "Clean up" }, cwd).text, "Claude wants to run a command");
check("Bash ask: detail is the command", describeAsk("Bash", { command: "rm -rf x", description: "Clean up" }, cwd).detail, "rm -rf x");
check("Bash ask: description is the why", describeAsk("Bash", { command: "rm -rf x", description: "Clean up" }, cwd).why, "Clean up");
check("Bash ask without description: detail is the command", describeAsk("Bash", { command: "ls" }, cwd).detail, "ls");
check("Bash ask without description: no why", describeAsk("Bash", { command: "ls" }, cwd).why, undefined);
check("Write ask", describeAsk("Write", { file_path: `${cwd}/a.txt` }, cwd).text, "Claude wants to create the file a.txt");
check("Edit ask", describeAsk("Edit", { file_path: `${cwd}/a.ts` }, cwd).text, "Claude wants to change the file a.ts");
check("WebFetch ask", describeAsk("WebFetch", { url: "https://example.com" }, cwd).text, "Claude wants to open https://example.com");
check("unknown tool ask: text", describeAsk("Foo", { a: 1 }, cwd).text, "Claude wants to use Foo");
check("unknown tool ask: detail is the input as JSON", describeAsk("Foo", { a: 1 }, cwd).detail, '{"a":1}');
check("unknown tool ask: detail trimmed to 300", describeAsk("Foo", { big: "y".repeat(1000) }, cwd).detail.length, 300);

// browser tools name the site they act on
const clickAsk = "mcp__browser__agent_browser_click";
check("browser click ask: names the site", describeAsk(clickAsk, { selector: "@e5" }, cwd, "https://example.com/a").text, "Claude wants to click on example.com");
check("browser click ask: detail is the ref", describeAsk(clickAsk, { selector: "@e5" }, cwd, "https://example.com/a").detail, "@e5");
check("browser click ask with no page: a website", describeAsk(clickAsk, { selector: "@e5" }, cwd, null).text, "Claude wants to click on a website");
check("browser type ask: form, detail is the text", describeAsk("mcp__browser__agent_browser_fill", { text: "hi" }, cwd, "https://example.com/").detail, "hi");
check("browser type ask: text", describeAsk("mcp__browser__agent_browser_type", { text: "hi" }, cwd, "https://example.com/").text, "Claude wants to type into a form on example.com");
check("browser type ask: detail cut at 80", describeAsk("mcp__browser__agent_browser_type", { text: "z".repeat(200) }, cwd, "https://example.com/").detail.length, 80);
check("browser eval ask: a script", describeAsk("mcp__browser__agent_browser_eval", { script: "1" }, cwd, "https://example.com/").text, "Claude wants to run a script on example.com");

// Claude's checklist (TodoWrite) and its helpers (Task or Agent)
check("todos: statuses map, and an in-progress item shows its activeForm", todosOf({ todos: [
  { content: "Plan", status: "completed" },
  { content: "Build", activeForm: "Building", status: "in_progress" },
  { content: "Test", status: "pending" },
  { content: "Ship", status: "weird" },
] }), [
  { text: "Plan", status: "done" },
  { text: "Building", status: "active" },
  { text: "Test", status: "pending" },
  { text: "Ship", status: "pending" },
]);
check("todos: an in-progress item without activeForm keeps its content", todosOf({ todos: [{ content: "Build", status: "in_progress" }] }), [{ text: "Build", status: "active" }]);
check("todos: items without string content are skipped", todosOf({ todos: [{ status: "pending" }, { content: 5 }, null, { content: "Ok", status: "pending" }] }), [{ text: "Ok", status: "pending" }]);
check("todos: no todos list is empty", todosOf({}), []);
check("todos: capped at 50 items", todosOf({ todos: Array.from({ length: 60 }, (_, i) => ({ content: `T${i}`, status: "pending" })) }).length, 50);
check("todos: each text cut at 200", todosOf({ todos: [{ content: "x".repeat(300), status: "pending" }] })[0].text.length, 200);
check("helper: its description", helperLabel({ description: "Find the bug", prompt: "long prompt" }), "Find the bug");
check("helper: no description, the start of the prompt", helperLabel({ prompt: "p".repeat(100) }), "p".repeat(60));
check("helper: nothing, a helper", helperLabel({}), "a helper");
check("helper: a long description cut at 80", helperLabel({ description: "d".repeat(120) }).length, 80);

// task tools (TaskCreate / TaskUpdate), shapes seen from claude 2.1.301
check("task id: structured result", newTaskId({ task: { id: "1", subject: "Create a.txt" } }, ""), "1");
check("task id: from the text", newTaskId(null, "Task #2 created successfully: Create b.txt"), "2");
check("task id: none", newTaskId(null, "oops"), null);
{
  let l = applyTaskEvent([], { create: { id: "1", subject: "Create a.txt", form: "Creating a.txt" } });
  l = applyTaskEvent(l, { create: { id: "2", subject: "Create b.txt" } });
  const view = () => l.map((t) => `${t.status}:${t.text}`).join("|");
  check("tasks: created pending", view(), "pending:Create a.txt|pending:Create b.txt");
  l = applyTaskEvent(l, { update: { taskId: "1", status: "in_progress" } });
  check("tasks: active shows activeForm", view(), "active:Creating a.txt|pending:Create b.txt");
  l = applyTaskEvent(l, { update: { taskId: "1", status: "completed" } });
  check("tasks: done shows subject", view(), "done:Create a.txt|pending:Create b.txt");
  check("tasks: duplicate create ignored", applyTaskEvent(l, { create: { id: "2", subject: "x" } }).length, 2);
  check("tasks: unknown id ignored", applyTaskEvent(l, { update: { taskId: "9", status: "completed" } }).length, 2);
  l = applyTaskEvent(l, { update: { taskId: "2", subject: "Make b.txt" } });
  check("tasks: subject updated", view(), "done:Create a.txt|pending:Make b.txt");
  l = applyTaskEvent(l, { update: { taskId: "2", status: "deleted" } });
  check("tasks: deleted removed", view(), "done:Create a.txt");
}

// what the user reads when Claude fails
check("usage limit: plain sentence", friendlyError("Claude AI usage limit reached|123"), "Claude has reached its usage limit for now. Try again in a little while.");
check("sign-in problem: plain sentence", friendlyError("Invalid API key · Please run /login"), "Claude is signed out on this server. Open Settings → Agents to check the connection.");
check("anything else: generic sentence", friendlyError("something odd happened"), "Something went wrong on Claude's side. Try again.");
check("not installed: set-up sentence", friendlyError("claude is not installed on this server"), "Claude is not set up on this server yet. Open Settings → Agents.");

// quiet lines for what the CLI notices on its own
check("model switch: names the model", noticeText({ subtype: "model_fallback", fallback_model: "claude-haiku-5-5" }), "Switched to claude-haiku-5-5 because the first choice was unavailable");
check("model switch without a name", noticeText({ subtype: "model_fallback" }), "Switched to another model because the first choice was unavailable");
check("compaction: one quiet line", noticeText({ subtype: "compact_boundary" }), "Conversation compacted to save space");
check("retry is not a quiet line", noticeText({ subtype: "api_retry" }), null);

// the footer's usage, from the two CLI replies
const used = usageOf(
  { totalTokens: 15962, maxTokens: 1000000 },
  { rate_limits_available: true, subscription_type: "pro", rate_limits: { five_hour: { utilization: 29, resets_at: "2026-10-16T07:50:00Z" }, seven_day: null } },
);
check("context: used, limit and percent", used.context, { used: 15962, limit: 1000000, percent: 2 });
check("plan: five-hour window, resets as given", used.plan.fiveHour, { percent: 29, resetsAt: "2026-10-16T07:50:00Z" });
check("plan: a window the CLI leaves out is null", used.plan.week, null);
check("plan: subscription name", used.plan.subscription, "pro");
check("no plan limits: plan is null", usageOf({ totalTokens: 1, maxTokens: 10 }, { rate_limits_available: false }).plan, null);
check("no context size: context is null", usageOf({}, {}).context, null);

// the menus and settings kept across a restart (chats/<id>.caps.json)
const dir = mkdtempSync(join(tmpdir(), "caps-check-"));
try {
  const file = join(dir, "x.caps.json");
  const saved = {
    commands: [{ name: "review", description: "Review", argumentHint: "" }],
    models: [{ value: "sonnet", displayName: "Sonnet", description: "", supportedEffortLevels: ["low"] }],
    model: "sonnet",
    mode: "acceptEdits",
  };
  writeCapsFile(file, { ...saved, savedAt: 1 });
  check("caps round trip: what was saved is read back", readCapsFile(file), saved);
  check("caps file is private (0600)", statSync(file).mode & 0o777, 0o600);
  check("caps file: a missing file reads as nothing", readCapsFile(join(dir, "none.caps.json")), null);
  writeFileSync(file, "{not json");
  check("caps file: a corrupt file reads as nothing", readCapsFile(file), null);
  writeFileSync(file, "5");
  check("caps file: a non-object reads as nothing", readCapsFile(file), null);
  writeFileSync(file, JSON.stringify({ commands: "x", models: [{ value: 3 }], model: 4 }));
  check("caps file: wrong shapes are dropped, not crashed on", readCapsFile(file), { commands: [], models: [], model: null, mode: null });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// the question and plan cards, and the answers that go back to Claude
const q1 = askForm("AskUserQuestion", { questions: [{ question: "  Which colour?  ", header: "Colour", options: [{ label: "Red" }, { label: "" }, { label: "Blue", description: "Calm" }] }] });
check("askForm: one question gives the one-question text", q1?.text, "Claude has a question");
check("askForm: one question is a question form", q1?.form, "question");
check("askForm: the question and its options are sanitized", q1 && "questions" in q1 ? q1.questions : null, [{ question: "  Which colour?  ", header: "Colour", options: [{ label: "Red" }, { label: "Blue", description: "Calm" }] }]);
const qs = Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}`, options: [{ label: "A" }] }));
const q5 = askForm("AskUserQuestion", { questions: [{ question: "", options: [{ label: "x" }] }, ...qs] });
check("askForm: a question with no text is dropped and 5 are capped to 4", q5 && "questions" in q5 ? [q5.text, q5.questions.length] : null, ["Claude has 4 questions", 4]);
check("askForm: the question with no text is skipped, so the next one leads",q5 && "questions" in q5 ? q5.questions[0].question : null, "Q0");
check("askForm: ExitPlanMode returns the plan", askForm("ExitPlanMode", { plan: "# Plan" }), { text: "Claude's plan is ready", form: "plan", plan: "# Plan" });
check("askForm: an empty plan is null", askForm("ExitPlanMode", { plan: "   " }), null);
check("askForm: an unrelated tool is null", askForm("Write", { file_path: "/x" }), null);

const qin = { questions: [{ question: "Colour?", options: [{ label: "Red" }] }, { question: "Size?", options: [{ label: "S" }] }] };
const qa = answerResponse("AskUserQuestion", qin, true, { answers: { "Colour?": "Red", "Size?": "L", "Nope?": "x" } });
check("answerResponse: keeps only known question keys", qa.response, { behavior: "allow", updatedInput: { ...qin, answers: { "Colour?": "Red", "Size?": "L" } } });
check("answerResponse: reply joins the answers", qa.reply, "Red; L");
const longQ = "L".repeat(600);
const lin = { questions: [{ question: longQ, options: [{ label: "A" }] }] };
check("answerResponse: an answer under the cut question text lands under the full one", answerResponse("AskUserQuestion", lin, true, { answers: { [longQ.slice(0, 500)]: "A" } }).response.updatedInput.answers, { [longQ]: "A" });
check("answerResponse: a __proto__ key is ignored", Object.keys(answerResponse("AskUserQuestion", qin, true, { answers: JSON.parse('{"__proto__":"x","Colour?":"Red"}') }).response.updatedInput.answers), ["Colour?"]);
check("answerResponse: question deny message", answerResponse("AskUserQuestion", qin, false, {}), { response: { behavior: "deny", message: "The user chose not to answer." } });
check("answerResponse: plan deny with text", answerResponse("ExitPlanMode", { plan: "p" }, false, { message: "  Add tests  " }), { response: { behavior: "deny", message: "The user wants changes to the plan: Add tests" }, reply: "Add tests" });
check("answerResponse: plan deny without text", answerResponse("ExitPlanMode", { plan: "p" }, false, {}), { response: { behavior: "deny", message: "The user did not approve the plan." } });
check("answerResponse: Write allow unchanged", answerResponse("Write", { file_path: "/x" }, true, {}), { response: { behavior: "allow", updatedInput: { file_path: "/x" } } });
check("answerResponse: Write deny unchanged", answerResponse("Write", { file_path: "/x" }, false, {}), { response: { behavior: "deny", message: "The user said no." } });

// what a new AI is told about the conversation (handoffText)
const hev = (n, body) => ({ n, at: 0, ...body });
check("handoffText: nothing is empty", handoffText([], "omp"), "");
check("handoffText: a switch line alone is empty", handoffText([hev(1, { kind: "tool", text: "Switched to omp" })], "claude"), "");
check(
  "handoffText: person, assistant and tool lines, oldest first, done and switch lines skipped",
  handoffText(
    [
      hev(1, { kind: "user", text: "Make a page" }),
      hev(2, { kind: "tool", text: "Created index.html" }),
      hev(3, { kind: "assistant", text: "Done." }),
      hev(4, { kind: "done" }),
      hev(5, { kind: "tool", text: "Switched to omp" }),
    ],
    "claude",
  ),
  "Person: Make a page\nDid: Created index.html\nAssistant: Done.",
);
check("handoffText: whitespace runs become one space", handoffText([hev(1, { kind: "user", text: "  hello \n\n  there\t x " })], "omp"), "Person: hello there x");
check("handoffText: a long line is cut to 240 characters, ending in ...", handoffText([hev(1, { kind: "user", text: "a".repeat(500) })], "omp"), `Person: ${"a".repeat(229)}...`);
check(
  "handoffText: an answered question shows its question; an open one does not",
  handoffText(
    [
      hev(1, { kind: "ask", requestId: "r1", text: "Claude has a question", form: "question", questions: [{ question: "Colour?", options: [] }] }),
      hev(2, { kind: "answer", requestId: "r1", allow: true, reply: "Red" }),
      hev(3, { kind: "ask", requestId: "r2", text: "Claude wants to run a command" }),
    ],
    "claude",
  ),
  "Assistant asked: Colour?",
);
const bigEvents = [hev(1, { kind: "user", text: "first question" }), ...Array.from({ length: 60 }, (_, i) => hev(i + 2, { kind: "assistant", text: `reply ${i} ${"x".repeat(150)}` })), hev(99, { kind: "user", text: "latest question" })];
const bigOut = handoffText(bigEvents, "omp", 1000);
const bigLines = bigOut.split("\n");
check("handoffText: the first message is always kept", bigLines[0], "Person: first question");
check("handoffText: the line after the first says how many were left out", /^\(… \d+ earlier lines left out …\)$/.test(bigLines[1]), true);
check("handoffText: the latest message is kept", bigLines.at(-1), "Person: latest question");
check("handoffText: the summary stays within the budget", bigOut.length <= 1000, true);
check("handoffText: a short conversation has no omission line", handoffText(bigEvents.slice(0, 3), "omp").includes("left out"), false);

// a note is a divider, not an AI step: handoffText leaves it out
check("handoffText: a note is skipped", handoffText([hev(1, { kind: "user", text: "hi" }), hev(2, { kind: "note", text: "Switched to omp" }), hev(3, { kind: "assistant", text: "hello" })], "claude"), "Person: hi\nAssistant: hello");
check("handoffText: a note alone is empty", handoffText([hev(1, { kind: "note", text: "Went back to before: “x”" })], "claude"), "");
check("handoffText: an old saved go-back tool line is skipped too", handoffText([hev(1, { kind: "user", text: "hi" }), hev(2, { kind: "tool", text: "Went back to before: “x”" })], "claude"), "Person: hi");
check("handoffText: an old saved background line is skipped too", handoffText([hev(1, { kind: "user", text: "hi" }), hev(2, { kind: "tool", text: "Background task finished: npm test" })], "claude"), "Person: hi");
check("handoffText: a real AI step is still kept", handoffText([hev(1, { kind: "tool", text: "Created index.html" })], "claude"), "Did: Created index.html");

// @ mentions: a case-insensitive substring of the path; basename prefix matches first; at most 50
const files = ["docs/readme.md", "src/App.tsx", "src/apple/index.ts", "pineapple.txt", "lib/app.css"];
check("rankFiles: case-insensitive substring of the path", rankFiles(files, "APP"), ["src/App.tsx", "lib/app.css", "src/apple/index.ts", "pineapple.txt"]);
check("rankFiles: basename prefix ranks before a mid-name match", rankFiles(["x/pineapple.txt", "app.md"], "app"), ["app.md", "x/pineapple.txt"]);
check("rankFiles: a directory part matches", rankFiles(files, "src/"), ["src/App.tsx", "src/apple/index.ts"]);
check("rankFiles: no match is empty", rankFiles(files, "zzz"), []);
check("rankFiles: an empty query lists the files in order", rankFiles(files, ""), files);
check("rankFiles: capped at 50", rankFiles(Array.from({ length: 80 }, (_, i) => `f${i}.ts`), "f").length, 50);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall chat line checks passed");
