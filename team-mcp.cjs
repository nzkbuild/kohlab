#!/usr/bin/env node
// The team's MCP server: the tools one team agent (Lead, Builder, Reviewer or Tester) uses to plan, report and talk. Started per agent by
// Claude, from the MCP config Kohlab writes (team.ts). It only forwards to the server's /api/team-tool/<team> endpoint with the
// role's own token; the server decides what the role may do. Node built-ins and the global fetch only.
// Never print the URL or the token: stdout carries JSON-RPC lines only.

const readline = require("node:readline");

const URL_ = process.env.KOHLAB_TEAM_URL || "";
const TOKEN = process.env.KOHLAB_TEAM_TOKEN || "";
const ROLE = process.env.KOHLAB_TEAM_ROLE || "";
const UNAVAILABLE = "The team is not available right now.";

const TASK = { type: "string", description: "A task id, such as T3." };
const ROLE_ID = { type: "string", description: "A role id: lead, builder-1 to builder-4, reviewer or tester." };
const TOOLS = [
  {
    name: "create_task",
    kinds: ["lead"],
    description: "Add a task to the team's board. Keep each task small, with its own area of the project. Tasks with overlapping areas run one at a time.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Up to 80 characters." },
        brief: { type: "string", description: "What to build and how to know it is done. Up to 1200 characters." },
        area: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8, description: "Paths the builder may change, such as src/auth/** or README.md." },
        deps: { type: "array", items: TASK, description: "Tasks that must be done first." },
        builder: ROLE_ID,
      },
      required: ["title", "brief", "area"],
    },
  },
  {
    name: "assign",
    kinds: ["lead"],
    description: "Give a todo or blocked task to a builder.",
    inputSchema: { type: "object", properties: { task: TASK, builder: ROLE_ID }, required: ["task", "builder"] },
  },
  {
    name: "message",
    kinds: ["lead", "builder", "reviewer", "tester"],
    description: "Send a short message. The Lead can write to any role or to \"you\" (the person). Other roles write to the Lead only. Up to 600 characters.",
    inputSchema: { type: "object", properties: { to: { type: "string", description: "A role id, or \"you\"." }, text: { type: "string" } }, required: ["to", "text"] },
  },
  {
    name: "poll",
    kinds: ["lead", "builder", "reviewer", "tester"],
    description: "Read the team's board, your task and your unread messages. Cheap: use it instead of guessing.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wait",
    kinds: ["lead", "builder"],
    description: "Park until someone writes to you. Call it when you are waiting on someone else, then end your turn.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "request_review",
    kinds: ["lead"],
    description: "Ask for a review of a task again, or for a review of the whole integrated work (task \"final\").",
    inputSchema: { type: "object", properties: { task: { type: "string", description: "A task id, or \"final\"." } }, required: ["task"] },
  },
  {
    name: "finish",
    kinds: ["lead"],
    description: "Say the goal is met. Every task must be done. The person then reviews the result before it comes into their project.",
    inputSchema: { type: "object", properties: { summary: { type: "string", description: "Up to 800 characters." } }, required: ["summary"] },
  },
  {
    name: "submit_result",
    kinds: ["builder", "reviewer", "tester"],
    description: "Report your result. Builders report a finished task (summary). Reviewers give approve or changes (notes). Testers give pass or fail (summary).",
    inputSchema: {
      type: "object",
      properties: {
        task: TASK,
        summary: { type: "string", description: "Up to 600 characters." },
        verdict: { type: "string", enum: ["approve", "changes", "pass", "fail"] },
        notes: { type: "string", description: "What to change, for a builder. Up to 1500 characters." },
      },
      required: ["summary"],
    },
  },
];
// The tools this role is offered: the server enforces the same table, this only keeps the list short.
const OFFERED = TOOLS.filter((t) => t.kinds.includes(ROLE)).map(({ kinds: _k, ...tool }) => tool);

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const text = (t, isError) => ({ content: [{ type: "text", text: t }], isError });

async function callTool(name, args) {
  if (!OFFERED.some((t) => t.name === name)) return text("This tool is not available to your role.", true);
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: { "content-type": "application/json", "x-kohlab-team": TOKEN, "x-kohlab-role": ROLE },
      body: JSON.stringify({ tool: name, args: args ?? {} }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    // The server explains its refusals in text (an area, a budget, a state): that is the answer. A bare failure is the same plain line for everyone.
    if (res.status === 404 || typeof body.text !== "string") return text(UNAVAILABLE, true);
    return text(body.text.slice(0, 1200), body.refused === true);
  } catch {
    return text(UNAVAILABLE, true);
  }
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return; // notifications (notifications/initialized and the rest) need no answer
  switch (m.method) {
    case "initialize":
      return reply(m.id, {
        protocolVersion: m.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "kohlab-team", version: "1" },
      });
    case "ping":
      return reply(m.id, {});
    case "tools/list":
      return reply(m.id, { tools: OFFERED });
    case "tools/call":
      return reply(m.id, await callTool(m.params?.name, m.params?.arguments));
    default:
      return fail(m.id, -32601, "Method not found");
  }
});
