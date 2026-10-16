#!/usr/bin/env bun
/**
 * Chat workspaces: the plain-English lines the chat shows. describeTool says what
 * the agent did, describeAsk says what it is asking permission for. No claude
 * process is started here.
 *
 * Run:  bun scripts/check-chat.mjs
 */
import { describeAsk, describeTool, friendlyError, noticeText, usageOf } from "../chat.ts";

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

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall chat line checks passed");
