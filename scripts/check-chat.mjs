#!/usr/bin/env bun
/**
 * Chat workspaces: the plain-English lines the chat shows. describeTool says what
 * the agent did, describeAsk says what it is asking permission for. No claude
 * process is started here.
 *
 * Run:  bun scripts/check-chat.mjs
 */
import { describeAsk, describeTool } from "../chat.ts";

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

// what the agent asks before doing it
check("Bash ask: text", describeAsk("Bash", { command: "rm -rf x", description: "Clean up" }, cwd).text, "Run a command?");
check("Bash ask: description on its own line first", describeAsk("Bash", { command: "rm -rf x", description: "Clean up" }, cwd).detail, "Clean up\nrm -rf x");
check("Bash ask without description: detail is the command", describeAsk("Bash", { command: "ls" }, cwd).detail, "ls");
check("Write ask", describeAsk("Write", { file_path: `${cwd}/a.txt` }, cwd).text, "Create the file a.txt?");
check("Edit ask", describeAsk("Edit", { file_path: `${cwd}/a.ts` }, cwd).text, "Change the file a.ts?");
check("WebFetch ask", describeAsk("WebFetch", { url: "https://example.com" }, cwd).text, "Open https://example.com?");
check("unknown tool ask: text", describeAsk("Foo", { a: 1 }, cwd).text, "Use Foo?");
check("unknown tool ask: detail is the input as JSON", describeAsk("Foo", { a: 1 }, cwd).detail, '{"a":1}');
check("unknown tool ask: detail trimmed to 300", describeAsk("Foo", { big: "y".repeat(1000) }, cwd).detail.length, 300);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall chat line checks passed");
