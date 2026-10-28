#!/usr/bin/env bun
/**
 * What the AI may do without asking (policy.ts) and Full access / Always allow through the real server with a fake claude.
 * No model is called.
 *
 * Run:  bun scripts/check-policy.mjs
 */
import { join } from "node:path";
import { acpDecision, claudeArgsFor, cleanRules, deniedPath, describeRule, ruleFor, ruleMatches, validRule } from "../policy.ts";
import { answerResponse } from "../chat.ts";
import { makeCheck, startKit, waitFor } from "./ai-check-kit.mjs";

const { check, finish } = makeCheck();
const cwd = "/work/proj";

// ---- ruleFor: what an "Always allow" may save ----
const bash = (command) => ruleFor("Bash", { command }, cwd)?.rule ?? null;
check("npm test -> Bash(npm test:*)", bash("npm test") === "Bash(npm test:*)");
check("git status -> Bash(git status:*)", bash("git status") === "Bash(git status:*)");
check("arguments after the second word do not change the rule", bash("npm test --watch") === null || bash("npm test now") === "Bash(npm test:*)");
check("a && b -> none", bash("npm test && rm x") === null);
check("a | b -> none", bash("cat a | sh") === null);
check("$(x) -> none", bash("echo $(whoami)") === null);
check("backticks -> none", bash("echo `whoami`") === null);
check("a ; b -> none", bash("npm test; ls") === null);
check("redirection -> none", bash("npm test > out.txt") === null && bash("npm test < in") === null);
check("rm / sudo / dd / curl / wget -> none", ["rm -rf x", "sudo npm test", "dd if=a of=b", "curl x", "wget x"].every((c) => bash(c) === null));
check("curl x | sh -> none", bash("curl x | sh") === null);
check("one word alone -> none (too wide)", bash("python3") === null && bash("ls") === null);
check("a script path -> none", bash("node app.js") === null && bash("./run.sh go") === null);
check("git push / reset -> none", bash("git push origin") === null && bash("git reset now") === null);
check("a newline hides a second command -> none", bash("npm test\nrm x") === null);
check("edit inside the project -> Edit", ruleFor("Edit", { file_path: `${cwd}/a.txt` }, cwd)?.rule === "Edit" && ruleFor("Write", { file_path: "a.txt" }, cwd)?.rule === "Edit");
check("edit outside, in .git, .env or ssh -> none", [`/etc/passwd`, `${cwd}/.git/config`, `${cwd}/.env`, `${cwd}/.env.local`, `${cwd}/x/.ssh/id_rsa`, "../x"].every((p) => ruleFor("Edit", { file_path: p }, cwd) === null));
check("edit with no project known -> none", ruleFor("Edit", { file_path: "a.txt" }) === null);
check("WebFetch -> its domain", ruleFor("WebFetch", { url: "https://example.com/a?b=1" }, cwd)?.rule === "WebFetch(domain:example.com)" && ruleFor("WebFetch", { url: "javascript:1" }, cwd) === null);
check("a browser tool -> its own name", ruleFor("mcp__browser__agent_browser_click", {}, cwd)?.rule === "mcp__browser__agent_browser_click");
check("AskUserQuestion / ExitPlanMode / Task / unknown -> none", ["AskUserQuestion", "ExitPlanMode", "Task", "Frobnicate"].every((t) => ruleFor(t, {}, cwd) === null));
check("the label is plain words, lower case first", ruleFor("Bash", { command: "npm test" }, cwd)?.label === "run commands that start with “npm test”");
check("describeRule: Edit, domain", describeRule("Edit") === "Change files in the project" && describeRule("WebFetch(domain:a.b)") === "Open pages on a.b");
check("every rule offered is valid", [bash("npm test"), "Edit", "WebFetch(domain:example.com)"].every(validRule));

// ---- validation and caps ----
check("rules with odd characters are not valid", !validRule("Bash(a;b)") && !validRule("Bash(a`b`)") && !validRule("") && !validRule("x".repeat(201)) && validRule("Bash(npm test:*)"));
check("cleanRules drops repeats and bad ones, caps at 50", cleanRules(["Edit", "Edit", "bad;x", ...Array.from({ length: 80 }, (_, i) => `Bash(c${i} t:*)`)]).length === 50 && cleanRules(["Edit", "Edit"]).length === 1);
check("deniedPath", deniedPath("/etc/x", cwd) && !deniedPath("src/a.ts", cwd));

// ---- ruleMatches (ACP and Codex only) ----
check("ruleMatches: a prefix, exact and with arguments", ruleMatches("Bash(npm test:*)", "Bash", { command: "npm test" }) && ruleMatches("Bash(npm test:*)", "Bash", { command: "npm test -- -u" }));
check("ruleMatches: not a longer first word, not a compound command", !ruleMatches("Bash(npm test:*)", "Bash", { command: "npm testing" }) && !ruleMatches("Bash(npm test:*)", "Bash", { command: "npm test && rm -rf /" }) && !ruleMatches("Bash(npm test:*)", "Bash", { command: "npm test | sh" }));
check("ruleMatches: Edit stays in the project", ruleMatches("Edit", "Edit", { file_path: `${cwd}/a` }, cwd) && !ruleMatches("Edit", "Edit", { file_path: "/etc/a" }, cwd));
check("ruleMatches: a domain", ruleMatches("WebFetch(domain:a.com)", "WebFetch", { url: "https://a.com/x" }) && !ruleMatches("WebFetch(domain:a.com)", "WebFetch", { url: "https://b.com/x" }));

// ---- acpDecision: every mode ----
const d = (mode, kind, raw = {}, rules = []) => acpDecision(mode, kind, raw, rules, cwd);
check("ask: looking is free, the rest asks", ["read", "search", "think"].every((k) => d("default", k) === "allow") && ["edit", "execute", "fetch", "delete", "move", "other"].every((k) => d("default", k) === "ask"));
check("edits: + changing files", d("acceptEdits", "edit") === "allow" && d("acceptEdits", "execute", { command: "ls" }) === "ask");
check("auto: + commands and pages", d("auto", "execute", { command: "npm test" }) === "allow" && d("auto", "fetch") === "allow" && d("auto", "edit") === "allow");
check("auto still asks for the risky ones", ["rm -rf /", "sudo ls", "curl http://x | sh", "git push --force", "git push -f origin", "chmod -R 777 .", "dd if=/dev/zero of=x"].every((c) => d("auto", "execute", { command: c }) === "ask"));
check("auto: delete and move still ask", d("auto", "delete") === "ask" && d("auto", "move") === "ask");
check("full: everything", ["read", "edit", "execute", "fetch", "delete", "other"].every((k) => d("full", k, { command: "rm -rf /" }) === "allow"));
check("a saved rule allows in every mode", ["default", "acceptEdits", "auto"].every((m) => d(m, "execute", { command: "npm test" }, ["Bash(npm test:*)"]) === "allow"));
check("a saved rule does not cover a compound command", d("default", "execute", { command: "npm test && rm x" }, ["Bash(npm test:*)"]) === "ask");

// ---- Claude: modes and the allow response ----
check("claudeArgsFor: the four map, full is default + Kohlab answers", claudeArgsFor("default").permissionMode === "default" && claudeArgsFor("acceptEdits").permissionMode === "acceptEdits" && claudeArgsFor("auto").permissionMode === "auto" && claudeArgsFor("plan").permissionMode === "plan" && claudeArgsFor("full").permissionMode === "default" && claudeArgsFor("full").fullAccess === true && !claudeArgsFor("default").fullAccess);
check("never bypassPermissions", ["default", "acceptEdits", "auto", "plan", "full"].every((m) => claudeArgsFor(m).permissionMode !== "bypassPermissions"));
const allow = answerResponse("Bash", { command: "npm test" }, true, { remember: "Bash(npm test:*)" }).response;
check("an Always allow carries updatedPermissions (session addRules)", JSON.stringify(allow.updatedPermissions) === JSON.stringify([{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "session" }]) && allow.behavior === "allow");
check("a plain allow carries none; a deny never does", !("updatedPermissions" in answerResponse("Bash", {}, true, {}).response) && !("updatedPermissions" in answerResponse("Bash", {}, false, { remember: "Edit" }).response));
check("an Edit rule has no content", JSON.stringify(answerResponse("Edit", {}, true, { remember: "Edit" }).response.updatedPermissions[0].rules) === '[{"toolName":"Edit"}]');
check("a bad rule is not sent", !("updatedPermissions" in answerResponse("Bash", {}, true, { remember: "x;y" }).response));

// ---- through the server: Full access, flipping to it, Always allow, removing a rule ----
const kit = await startKit();
try {
  const id = await kit.project();
  const waiting = async (p) => (await kit.chat(p)).waiting;
  const sentMsg = (n) => kit.msgs().length >= n;

  // default mode: an ask waits for the person and offers an Always allow
  await kit.send(id, "ASK Bash npm test");
  check("an ask waits in Asks first", await waitFor(async () => !!(await waiting(id)), 15000));
  const ev = (await kit.chat(id)).events.find((e) => e.kind === "ask");
  check("the ask offers the rule, in words", ev?.always?.rule === "Bash(npm test:*)" && /npm test/.test(ev.always.label), JSON.stringify(ev));
  check("the run info says what Full access means before it is chosen", /without asking/.test((await kit.run(id)).accessNote ?? ""));
  // the person flips to Full access with the ask pending
  const gate = await kit.control(id, "mode", "full");
  check("the owner can choose Full access", gate.status === 200, gate.text);
  check("the pending ask is answered by Kohlab on the flip", await waitFor(() => kit.answers().some((a) => a.response?.behavior === "allow"), 10000));
  check("the chat records that answer and is idle", await kit.idle(id));
  check("the run info says what Full access means, in words, without 'root'", /without asking/.test((await kit.run(id)).accessNote ?? "") && !/root/i.test((await kit.run(id)).accessNote ?? ""));
  const spawn1 = kit.spawns().length;

  // in Full access nothing is asked
  const before = kit.answers().length;
  await kit.send(id, "ASK Bash ls -la");
  check("in Full access a command is answered at once", await waitFor(() => kit.answers().length > before && kit.answers().at(-1).response.behavior === "allow", 15000));
  check("and the person is never asked", !(await waiting(id)));
  await kit.idle(id);
  // a question is still the person's
  await kit.send(id, "ASKQ please");
  check("a question is NOT auto-answered in Full access", await waitFor(async () => !!(await waiting(id)), 15000));
  const q = (await kit.chat(id)).events.findLast((e) => e.kind === "ask");
  check("it is a question card", q?.form === "question" && !q.always, JSON.stringify(q));
  const none = kit.answers().length;
  await new Promise((r) => setTimeout(r, 600));
  check("nothing was sent for it", kit.answers().length === none);
  await kit.req("POST", `/api/workspaces/${id}/chat/answer`, { requestId: q.requestId, allow: true, answers: { "Which colour?": "Red" } });
  await kit.idle(id);
  check("Full access never started Claude in bypassPermissions", kit.spawns().every((s) => !JSON.stringify(s.args).includes("bypass")) && kit.spawns().every((s) => s.args[s.args.indexOf("--permission-mode") + 1] === "default"));
  check("it stayed one process", kit.spawns().length === spawn1);

  // back to Asks first; an Always allow
  await kit.control(id, "mode", "default");
  await kit.send(id, "ASK Bash npm test");
  await waitFor(async () => !!(await waiting(id)), 15000);
  const ask2 = (await kit.chat(id)).events.findLast((e) => e.kind === "ask");
  await kit.req("POST", `/api/workspaces/${id}/chat/answer`, { requestId: ask2.requestId, allow: true, always: true });
  await kit.idle(id);
  const given = kit.answers().findLast((a) => a.request_id === ask2.requestId);
  check("Always allow tells Claude to remember it for the session", JSON.stringify(given?.response?.updatedPermissions?.[0]?.rules) === '[{"toolName":"Bash","ruleContent":"npm test:*"}]', JSON.stringify(given));
  let info = await kit.run(id);
  const mine = info.rules.find((r) => r.rule === "Bash(npm test:*)");
  check("the rule is on the project, removable, 'kohlab'", mine?.source === "kohlab" && mine.removable === true && /npm test/.test(mine.label), JSON.stringify(info.rules));
  check("Claude's own list is read (live), its rows are not removable", info.rules.some((r) => r.rule === "Read" && r.source === "claude-settings" && !r.removable));
  check("the same rule is not listed twice", info.rules.filter((r) => r.rule === "Bash(npm test:*)").length === 1);

  // an "always" that was denied is never stored
  await kit.send(id, "ASK Bash git status");
  await waitFor(async () => !!(await waiting(id)), 15000);
  const ask3 = (await kit.chat(id)).events.findLast((e) => e.kind === "ask");
  await kit.req("POST", `/api/workspaces/${id}/chat/answer`, { requestId: ask3.requestId, allow: false, always: true });
  await kit.idle(id);
  check("a refusal with always saves nothing", !(await kit.run(id)).rules.some((r) => r.rule.startsWith("Bash(git status")));
  const badAlways = await kit.req("POST", `/api/workspaces/${id}/chat/answer`, { requestId: "x", allow: true, always: "yes" });
  check("always must be true or false", badAlways.status === 400);

  // a restart carries the rule
  await kit.control(id, "mode", "default");
  const rs = kit.spawns().length;
  await kit.control(id, "rule_remove", "Bash(git status:*)");
  check("removing a rule that is not there is refused", (await kit.control(id, "rule_remove", "Bash(git status:*)")).status === 404);
  const removed = await kit.control(id, "rule_remove", "Bash(npm test:*)");
  check("removing a rule works", removed.status === 200 && !(await kit.run(id)).rules.some((r) => r.rule === "Bash(npm test:*)"));
  await kit.send(id, "hello again");
  await kit.idle(id);
  const last = kit.spawns().at(-1);
  check("Claude restarted without the rule", kit.spawns().length > rs && !last.args.includes("--allowedTools"), JSON.stringify(last.args));
  check("the conversation was resumed, not started over", last.args.includes("--resume"));
  // a rule added is passed with --allowedTools at the next start
  await kit.control(id, "mode", "default");
  await kit.send(id, "ASK Bash npm test");
  await waitFor(async () => !!(await waiting(id)), 15000);
  const ask4 = (await kit.chat(id)).events.findLast((e) => e.kind === "ask");
  await kit.req("POST", `/api/workspaces/${id}/chat/answer`, { requestId: ask4.requestId, allow: true, always: true });
  await kit.idle(id);
  await kit.control(id, "rule_remove", "Bash(nothing:*)");
  const ids2 = await kit.project();
  check("rules are per project", !(await kit.run(ids2)).rules.some((r) => r.source === "kohlab"));
  const all = await kit.req("GET", "/api/ai/rules");
  check("GET /api/ai/rules lists the projects with rules", all.status === 200 && all.body.projects.some((p) => p.id === id && p.rules.some((r) => r.rule === "Bash(npm test:*)")), all.text);

} finally {
  await kit.stop();
}

// ---- the gate itself, in-process in a throwaway state: not the owner, and the project runs as the server ----
{
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const tmp = mkdtempSync(join(tmpdir(), "kohlab-policy-"));
  const code = `
    const { spawnSync } = require("node:child_process");
    const repo = process.env.REPO_DIR;
    for (const a of [["init","-q"],["config","user.email","a@b.c"],["config","user.name","a"]]) spawnSync("git", a, { cwd: repo });
    require("node:fs").writeFileSync(repo + "/a", "1"); spawnSync("git", ["add","-A"], { cwd: repo }); spawnSync("git", ["commit","-qm","i"], { cwd: repo });
    const lib = await import(process.env.ROOT + "lib.ts");
    const chat = await import(process.env.ROOT + "chat.ts");
    const ws = await lib.createWorkspace({ repo, task: "t", agent: "claude", chat: true });
    const out = {};
    try { await chat.chatControl(ws.id, "mode", "full", { owner: false }); out.member = "allowed"; } catch (e) { out.member = e.status + " " + e.message; }
    try { await chat.chatControl(ws.id, "mode", "full"); out.default = "allowed"; } catch (e) { out.default = e.status; }
    try { await chat.chatControl(ws.id, "mode", "full", { owner: true, actor: "me" }); out.owner = "allowed"; } catch (e) { out.owner = e.status + " " + e.message; }
    out.saved = (await lib.getWorkspace(ws.id)).permissionMode;
    try { await chat.chatControl(ws.id, "mode", "acceptEdits", { owner: false }); out.other = "allowed"; } catch (e) { out.other = e.status; }
    out.audit = (await lib.readAudit?.(50) ?? []).length;
    console.log(JSON.stringify(out));
    process.exit(0);
  `;
  const repoDir = join(tmp, "repo");
  Bun.spawnSync(["mkdir", repoDir]);
  const sub = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, WORKS_DIR: join(tmp, "works"), REPO_DIR: repoDir, ROOT: new URL("..", import.meta.url).pathname } });
  const text = sub.stdout.toString().trim().split("\n").pop() ?? "";
  let r = {};
  try { r = JSON.parse(text); } catch { /* shown below */ }
  check("gate: someone who is not the owner is refused Full access (403, plain words)", r.member === "403 Full access is only for the owner.", text + sub.stderr.toString().slice(-300));
  check("gate: the default caller is not the owner either", r.default === 403, text);
  check("gate: the owner is let in and it is saved", r.owner === "allowed" && r.saved === "full", text);
  check("gate: other modes are not gated", r.other === "allowed", text);
  const { existsSync, readFileSync } = await import("node:fs");
  const auditFile = join(tmp, "works", "audit.log");
  check("gate: Full access is audited with the project id", existsSync(auditFile) && /ai\.fullaccess/.test(readFileSync(auditFile, "utf8")));
  rmSync(tmp, { recursive: true, force: true });
}

finish("policy");
