#!/usr/bin/env node
// The project brain's MCP server: two tools (recall, remember) for the chat's Claude. Started per chat by Claude, from the
// MCP config Kohlab writes (see chat.ts). It only forwards to the server's /api/brain-tool/<id> endpoint with the
// workspace's token; it never reads the vault itself. Node built-ins and the global fetch only.
// Never print the URL or the token: stdout carries JSON-RPC lines only.

const readline = require("node:readline");

const URL_ = process.env.KOHLAB_BRAIN_URL || "";
const TOKEN = process.env.KOHLAB_BRAIN_TOKEN || "";
const UNAVAILABLE = "Memory is not available right now.";

const TOOLS = [
  {
    name: "recall",
    description: "Search this project's saved memory (goals, decisions, handoffs, facts) and read the best matches. Use before re-deriving something that may have been decided.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "What to look for, in a few words." } }, required: ["query"] },
  },
  {
    name: "remember",
    description: "Save one lasting fact, decision, task or the goal. Same title replaces. Keep it under 2000 characters. Do not save secrets.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["goal", "decision", "task", "fact"] },
        title: { type: "string" },
        body: { type: "string" },
        links: { type: "array", items: { type: "string" }, description: "Titles of other notes this one relates to." },
        status: { type: "string", enum: ["open", "doing", "done"], description: "Tasks only." },
      },
      required: ["type", "title", "body"],
    },
  },
];

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const text = (t, isError) => ({ content: [{ type: "text", text: t }], isError });

async function callTool(name, args) {
  if (!TOOLS.some((t) => t.name === name)) return text("Unknown memory tool.", true);
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: { "content-type": "application/json", "x-kohlab-brain": TOKEN },
      body: JSON.stringify({ tool: name, args: args ?? {} }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return text(UNAVAILABLE, true);
    const body = await res.json();
    return text(String(body.text ?? ""), false);
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
        serverInfo: { name: "kohlab-brain", version: "1" },
      });
    case "ping":
      return reply(m.id, {});
    case "tools/list":
      return reply(m.id, { tools: TOOLS });
    case "tools/call":
      return reply(m.id, await callTool(m.params?.name, m.params?.arguments));
    default:
      return fail(m.id, -32601, "Method not found");
  }
});
