/**
 * Shared by the AI-control checks (check-defaults, check-policy, check-accounts, check-fallback, check-omp-model):
 * a throwaway Kohlab server on its own port, socket and state directory, with FAKE claude, codex, codex-acp, hermes and omp
 * on PATH. Nothing here calls a model or touches a real sign-in; the server it starts is never the live one.
 *
 * The fake claude (see fakeClaude) speaks stream-json like the real one and does what a file in its own directory says:
 *   behave-<who>      "limit" = answer every message with a usage-limit error (and "limit-once" = only the next one); "exit-limit" = print it on stderr and exit
 *   usage-<who>       the five-hour percent get_usage reports (default 10)
 * where <who> is the basename of CLAUDE_CONFIG_DIR, or "default". It records every start (spawns.log: args and the
 * environment keys of interest), every message (msgs.log) and every answer it was sent (answers.log).
 * A message that starts with "ASK Bash <command>" or "ASKQ" makes it ask for a permission / put a question.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = new URL("..", import.meta.url).pathname;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeCheck() {
  let failures = 0;
  return {
    check(name, ok, detail = "") {
      if (!ok) failures++;
      console.log(`${ok ? "ok  " : "FAIL"}  ${name}${!ok && detail ? `  ${String(detail).slice(0, 400)}` : ""}`);
    },
    finish(label) {
      if (failures) {
        console.log(`\n${failures} failed`);
        process.exit(1);
      }
      console.log(`\nall ${label} checks passed`);
    },
  };
}

export async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await Promise.resolve(fn()).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}

async function freePort() {
  const srv = createServer();
  const { promise, resolve } = Promise.withResolvers();
  srv.listen(0, "127.0.0.1", () => resolve(srv.address().port));
  const port = await promise;
  const closed = Promise.withResolvers();
  srv.close(closed.resolve);
  await closed.promise;
  return port;
}

export const jsonLines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

export function killDaemon(socketPath) {
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("pty-daemon.cjs")) continue;
      if (!readFileSync(`/proc/${pid}/environ`, "utf8").includes(`PTY_SOCKET=${socketPath}`)) continue;
      process.kill(Number(pid), "SIGTERM");
    } catch {
      /* gone, or not ours */
    }
  }
}

/** The fake claude. Runs under node. */
function fakeClaude() {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.dirname(process.argv[1]);
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  const who = cfg ? path.basename(cfg) : "default";
  const flag = (name) => {
    try {
      return fs.readFileSync(path.join(dir, `${name}-${who}`), "utf8").trim();
    } catch {
      return "";
    }
  };
  const argv = process.argv.slice(2);
  // claude auth status / claude auth login
  if (argv[0] === "auth" && argv[1] === "status") {
    const signedOut = cfg ? !fs.existsSync(path.join(cfg, "signed-in")) : fs.existsSync(path.join(dir, "default-signed-out"));
    process.stdout.write(JSON.stringify(signedOut ? { loggedIn: false } : { loggedIn: true, authMethod: "claude.ai" }) + "\n");
    process.exit(0);
  }
  if (argv[0] === "auth" && argv[1] === "login") {
    fs.appendFileSync(path.join(dir, "logins.log"), JSON.stringify({ cfg, hasKohlabKey: "KOHLAB_KEY" in process.env }) + "\n");
    process.stdout.write("Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc123\nPaste code here if prompted > ");
    process.stdin.on("data", (d) => {
      if (String(d).includes("GOOD")) {
        fs.writeFileSync(path.join(cfg, "signed-in"), "1");
        process.exit(0);
      }
      process.stderr.write("Login failed: Request failed with status code 400\n");
      process.exit(1);
    });
    return;
  }
  if (!argv.includes("--input-format")) process.exit(0);
  const sid = `fake-${who}-${process.pid}`;
  const modelArg = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : null;
  let model = modelArg ?? "default";
  const rulesGiven = argv.includes("--allowedTools") ? argv[argv.indexOf("--allowedTools") + 1].split(",") : [];
  fs.appendFileSync(
    path.join(dir, "spawns.log"),
    JSON.stringify({
      pid: process.pid,
      who,
      args: argv,
      cwd: process.cwd(),
      env: {
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
        ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null,
        KOHLAB_KEY: process.env.KOHLAB_KEY ?? null,
        HOME: process.env.HOME ?? null,
      },
    }) + "\n",
  );
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  let mode = argv.includes("--permission-mode") ? argv[argv.indexOf("--permission-mode") + 1] : "default";
  let buf = "";
  const asking = new Map();
  process.stdin.on("end", () => process.exit(0));
  const finishTurn = (text) => {
    out({ type: "assistant", message: { content: [{ type: "text", text: `Done: ${text.slice(0, 40)}` }] } });
    out({ type: "result", subtype: "success", result: "ok", session_id: sid });
  };
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type === "control_request") {
        const reply = (response) => out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
        const sub = m.request.subtype;
        fs.appendFileSync(path.join(dir, "controls.log"), JSON.stringify({ pid: process.pid, who, sub, request: m.request }) + "\n");
        if (sub === "get_context_usage") reply({ totalTokens: 1000, maxTokens: 200000 });
        else if (sub === "get_usage") {
          const pct = Number(flag("usage") || 10);
          reply({ rate_limits_available: true, subscription_type: "pro", rate_limits: { five_hour: { utilization: pct, resets_at: new Date(Date.now() + 3600e3).toISOString() }, seven_day: { utilization: 3, resets_at: new Date(Date.now() + 86400e3).toISOString() } } });
        } else if (sub === "set_model") {
          model = m.request.model;
          reply({});
        } else if (sub === "set_permission_mode") {
          mode = m.request.mode;
          reply({});
        } else if (sub === "list_permission_rules") {
          reply({ state: { rules: [...rulesGiven.map((r) => ({ behavior: "allow", source: "cliArg", rule: r, editability: "session" })), { behavior: "allow", source: "projectSettings", rule: "Read", editability: "readonly" }], workspaceDirectories: [], managedOnly: false } });
        } else
          reply({
            commands: [],
            models: [
              { value: "default", displayName: "Default", description: "", supportedEffortLevels: ["low", "high"] },
              { value: "haiku", displayName: "Haiku 4.5", description: "", supportedEffortLevels: [] },
              { value: "sonnet", displayName: "Sonnet 5", description: "", supportedEffortLevels: [] },
            ],
            account: { email: `${who}@x.test`, subscriptionType: "pro" },
          });
      } else if (m.type === "control_response") {
        const r = m.response ?? {};
        fs.appendFileSync(path.join(dir, "answers.log"), JSON.stringify({ pid: process.pid, who, request_id: r.request_id, response: r.response }) + "\n");
        if (asking.has(r.request_id)) {
          const text = asking.get(r.request_id);
          asking.delete(r.request_id);
          finishTurn(text);
        }
      } else if (m.type === "user") {
        const text = typeof m.message?.content === "string" ? m.message.content : "";
        fs.appendFileSync(path.join(dir, "msgs.log"), JSON.stringify({ pid: process.pid, who, model, mode, text }) + "\n");
        out({ type: "system", subtype: "init", session_id: sid, model, permissionMode: mode });
        const behave = flag("behave");
        if (behave === "exit-limit") {
          process.stderr.write("Error: usage limit reached\n");
          process.exit(1);
        }
        if (behave === "limit" || behave === "limit-once") {
          if (behave === "limit-once") fs.unlinkSync(path.join(dir, `behave-${who}`));
          out({ type: "result", subtype: "error_during_execution", result: "You've hit your usage limit. Your limit resets 2:49pm", session_id: sid });
          continue;
        }
        const ask = /ASK Bash (.+)/.exec(text.split("\nThe person's new message:\n").pop());
        if (ask || text.includes("ASKQ")) {
          const id = `req-${Date.now()}-${asking.size}`;
          asking.set(id, text);
          if (ask) out({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: ask[1], description: "run it" } } });
          else out({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }] }] } } });
          continue;
        }
        finishTurn(text);
      }
    }
  });
}

/** Tiny stand-ins for the other AIs, so no probe reaches a real one. */
const STUBS = {
  codex: `#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Not logged in"; exit 1; fi\nif [ "$1" = "--version" ]; then echo "codex 0.0.0"; exit 0; fi\nexit 1\n`,
  "codex-acp": `#!/bin/sh\nexit 1\n`,
  hermes: `#!/bin/sh\nexit 1\n`,
  omp: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "omp 0.0.0"; exit 0; fi\nif [ "$1" = "models" ]; then echo '{"models":[]}'; exit 0; fi\nexit 1\n`,
};

/** Starts a throwaway server. `bins` adds or replaces programs on PATH: {name: script text}. */
export async function startKit({ key = "ai-check-key", bins = {}, env = {} } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "kohlab-aicheck-"));
  const fakeDir = join(tmp, "fake-bin");
  const works = join(tmp, "works");
  const socket = join(tmp, "pty.sock");
  const repoDir = join(tmp, "repo");
  mkdirSync(fakeDir);
  mkdirSync(repoDir);
  const put = (name, text) => {
    writeFileSync(join(fakeDir, name), text);
    chmodSync(join(fakeDir, name), 0o755);
  };
  for (const [name, text] of Object.entries({ ...STUBS, ...bins })) put(name, text);
  put("claude", `#!/usr/bin/env node\n(${fakeClaude.toString()})();\n`);
  for (const args of [["init", "-q"], ["config", "user.email", "check@kohlab.local"], ["config", "user.name", "check"]]) spawnSync("git", args, { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "# check\n");
  spawnSync("git", ["add", "-A"], { cwd: repoDir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = "";
  const server = spawn("bun", ["run", "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", KOHLAB_KEY: key, WORKS_DIR: works, PTY_SOCKET: socket, PATH: `${fakeDir}:${process.env.PATH}`, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const up = await waitFor(() => fetch(`${base}/api/auth/required`).then((r) => r.ok), 20000);
  if (!up) {
    server.kill("SIGKILL");
    throw new Error(`throwaway server did not start:\n${log.slice(-800)}`);
  }
  const req = async (method, path, body, asKey = key) => {
    const res = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(asKey)}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, text };
  };
  return {
    tmp,
    fakeDir,
    works,
    repoDir,
    base,
    req,
    put,
    log: () => log,
    flag: (name, value) => writeFileSync(join(fakeDir, name), String(value)),
    spawns: () => jsonLines(join(fakeDir, "spawns.log")),
    msgs: () => jsonLines(join(fakeDir, "msgs.log")),
    answers: () => jsonLines(join(fakeDir, "answers.log")),
    controls: () => jsonLines(join(fakeDir, "controls.log")),
    /** a chat project on the fake claude */
    async project(extra = {}) {
      const made = await req("POST", "/api/workspaces", { repo: repoDir, agent: "claude", chat: true, ...extra });
      if (typeof made.body?.id !== "string") throw new Error(`no project: ${made.text}`);
      return made.body.id;
    },
    chat: async (id, after = 0) => (await req("GET", `/api/workspaces/${id}/chat?after=${after}`)).body,
    run: async (id) => (await req("GET", `/api/workspaces/${id}/chat/run`)).body,
    send: (id, text, withModel) => req("POST", `/api/workspaces/${id}/chat`, { text, ...(withModel ? { with: { model: withModel } } : {}) }),
    control: (id, action, value) => req("POST", `/api/workspaces/${id}/chat/control`, { action, value }),
    idle: (id, ms = 20000) => waitFor(async () => (await req("GET", `/api/workspaces/${id}/chat?after=0`)).body?.busy === false, ms),
    /** everything the server wrote that a secret must not be in */
    leaks(secret) {
      const found = [];
      const walk = (d) => {
        for (const n of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, n.name);
          if (n.isDirectory()) walk(p);
          else if (!p.endsWith("/secrets.json") && readFileSync(p, "utf8").includes(secret)) found.push(p.replace(works, "<works>"));
        }
      };
      if (existsSync(works)) walk(works);
      if (log.includes(secret)) found.push("<server output>");
      return found;
    },
    async stop() {
      server.kill("SIGKILL");
      killDaemon(socket);
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
