#!/usr/bin/env node
/**
 * The AI hub over HTTP (GET /api/providers, POST /api/providers/refresh): who sees what, what the
 * probes are allowed to do, and that no secret reaches a probe or a response.
 *
 * Its own throwaway server, with fake claude, codex, hermes and omp on PATH. The fake claude answers
 * initialize and get_usage, and FAILS (writes a marker, exits) if it is ever sent a user message. The
 * server is started with canary secrets in its environment: no fake may see them, no response may hold them.
 * No real AI, no network, no model call.
 *
 * Run:  node scripts/check-providers-http.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const KEY = "providers-check-owner-key";
const CANARY_API = "canary-anthropic-api-key-7731";
const OWNER_EMAIL = "owner-canary@example.test";
const CODEX_EMAIL = "codex-canary@example.test";
let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${!ok && detail ? `  ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return true;
    await sleep(120);
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
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Each fake is plain node, written to a file as `(fn)()`. They record how they were called in the folder they live in. */
function fakeClaude() {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.dirname(process.argv[1]);
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(dir, "env.log"), JSON.stringify({ who: "claude", args, env: process.env }) + "\n");
  if (args[0] === "--version") return console.log("2.1.305 (Claude Code)");
  if (args[0] === "auth") return console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "owner-canary@example.test" }));
  if (!args.includes("--input-format")) return;
  fs.appendFileSync(path.join(dir, "claude-spawns"), `${process.pid}\n`);
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  process.stdin.on("end", () => process.exit(0));
  let buf = "";
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
      if (m.type === "user") {
        fs.writeFileSync(path.join(dir, "got-user"), "a user message reached the probe");
        process.exit(3);
      }
      if (m.type !== "control_request") continue;
      const reply = (response) => out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
      if (m.request.subtype === "initialize") {
        setTimeout(
          () =>
            reply({
              account: { email: "owner-canary@example.test", subscriptionType: "Claude Pro", apiProvider: "firstParty" },
              models: [
                { value: "default", displayName: "Default (recommended)", description: "Sonnet 5.5", supportedEffortLevels: ["low", "high"] },
                { value: "haiku", displayName: "Haiku", description: "" },
              ],
              commands: [],
            }),
          300,
        );
      } else if (m.request.subtype === "get_usage") {
        reply({
          subscription_type: "pro",
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 38, resets_at: "2026-10-25T17:29:59.9+00:00" },
            seven_day: { utilization: 4, resets_at: "2026-10-29T22:59:59.9+00:00" },
            limits: [
              { kind: "session", percent: 38, severity: "normal" },
              { kind: "weekly_all", percent: 4, severity: "normal" },
            ],
          },
        });
      } else reply({});
    }
  });
}

function fakeCodex() {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.dirname(process.argv[1]);
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(dir, "env.log"), JSON.stringify({ who: "codex", args, env: process.env }) + "\n");
  if (args[0] === "--version") return console.log("codex-cli 0.163.0");
  if (args[0] === "login") {
    if (fs.existsSync(path.join(dir, "codex-in"))) return console.log("Logged in using ChatGPT");
    console.log("Not logged in");
    return process.exit(1);
  }
  if (args[0] !== "app-server") return;
  fs.appendFileSync(path.join(dir, "codex-spawns"), `${process.pid}\n`);
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  let buf = "";
  process.stdin.on("end", () => process.exit(0));
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
      if (m.method) fs.appendFileSync(path.join(dir, "codex-methods"), m.method + "\n");
      if (m.id === undefined) continue;
      const result =
        m.method === "initialize"
          ? { userAgent: "fake", codexHome: "/nowhere" }
          : m.method === "account/read"
            ? { account: { type: "chatgpt", email: "codex-canary@example.test", planType: "plus" }, requiresOpenaiAuth: false }
            : m.method === "account/rateLimits/read"
              ? { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1792932000 }, secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1793400000 }, credits: { hasCredits: true, unlimited: false, balance: "5" } } }
              : null;
      if (result) out({ jsonrpc: "2.0", id: m.id, result });
      else out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
    }
  });
}

function fakeHermes() {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.dirname(process.argv[1]);
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(dir, "env.log"), JSON.stringify({ who: "hermes", args, env: process.env }) + "\n");
  if (args[0] === "auth" && args[1] === "list") {
    console.log("rtk: hermes plugin warning: harmless");
    console.log("custom:vps (1 credentials):");
    console.log("  #1  VPS  api_key id=zzfakekey9 priority=0 config:VPS");
    return;
  }
  fs.writeFileSync(path.join(dir, "hermes-bad"), args.join(" "));
}

function fakeOmp() {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.dirname(process.argv[1]);
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(dir, "env.log"), JSON.stringify({ who: "omp", args, env: process.env }) + "\n");
  if (args[0] === "--version") return console.log("omp/18.4.1");
  if (args[0] === "models" && args[1] === "--json")
    return console.log(JSON.stringify({ models: [{ provider: "openrouter", id: "a/b", selector: "openrouter/a/b", name: "A B", cost: { in: 1 } }, { provider: "commandcode", id: "c", selector: "commandcode/c", name: "C" }] }));
  if (args[0] === "usage" && args[1] === "--json") return console.log(JSON.stringify({ reports: [], accountsWithoutUsage: [] }));
  fs.writeFileSync(path.join(dir, "omp-bad"), args.join(" "));
}

const tmp = mkdtempSync(join(tmpdir(), "kohlab-provcheck-"));
const fakeDir = join(tmp, "fake-bin");
const works = join(tmp, "works");
const socket = join(tmp, "pty.sock");
const repoDir = join(tmp, "repo");
mkdirSync(fakeDir);
mkdirSync(repoDir);
for (const [name, fn] of [["claude", fakeClaude], ["codex", fakeCodex], ["hermes", fakeHermes], ["omp", fakeOmp]]) {
  writeFileSync(join(fakeDir, name), `#!/usr/bin/env node\n(${fn.toString()})();\n`);
  chmodSync(join(fakeDir, name), 0o755);
}
writeFileSync(join(fakeDir, "codex-acp"), "#!/bin/sh\nexit 0\n");
chmodSync(join(fakeDir, "codex-acp"), 0o755);
for (const args of [["init", "-q"], ["config", "user.email", "check@kohlab.local"], ["config", "user.name", "check"]]) spawnSync("git", args, { cwd: repoDir });
writeFileSync(join(repoDir, "README.md"), "# check\n");
spawnSync("git", ["add", "-A"], { cwd: repoDir });
spawnSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

function killDaemon(socketPath) {
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

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let server = null;
let serverLog = "";
const made = [];

async function req(method, path, { key = KEY, body, query = "" } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const auth = key ? `${sep}key=${encodeURIComponent(key)}` : "";
  const res = await fetch(`${BASE}${path}${auth}${query ? (path.includes("?") || auth ? "&" : "?") + query : ""}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, text };
}
const card = (r, id) => r.body?.providers?.find((p) => p.id === id);
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

try {
  server = spawn("bun", ["run", "server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      KOHLAB_KEY: KEY,
      ANTHROPIC_API_KEY: CANARY_API,
      WORKS_DIR: works,
      PTY_SOCKET: socket,
      KOHLAB_OS_USER_PREFIX: "kohpv",
      PATH: `${fakeDir}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  const up = await waitFor(() => fetch(`${BASE}/api/auth/required`).then((r) => r.ok), 20000);
  if (!up) throw new Error(`throwaway server did not start:\n${serverLog.slice(-800)}`);

  // nothing runs before somebody asks
  await sleep(1200);
  check("no AI is started before a request", lines(join(fakeDir, "env.log")).length === 0, lines(join(fakeDir, "env.log")).join(" | ").slice(0, 200));

  // no credentials, and two people at the same moment
  check("no credentials -> 401", (await req("GET", "/api/providers", { key: "" })).status === 401);
  const [a, b] = await Promise.all([req("GET", "/api/providers"), req("GET", "/api/providers")]);
  check("owner GET -> 200 with four AIs", a.status === 200 && b.status === 200 && a.body.providers?.map((p) => p.id).join() === "claude,codex,hermes,omp", `${a.status} ${a.text.slice(0, 200)}`);
  check("two requests at once start claude once", lines(join(fakeDir, "claude-spawns")).length === 1, String(lines(join(fakeDir, "claude-spawns")).length));

  const claude = card(a, "claude");
  const acct = claude?.accounts?.[0];
  check("owner: Claude is connected with the account email, plan and version", claude?.state === "connected" && acct?.email === OWNER_EMAIL && acct?.plan === "Claude Pro" && claude?.version === "2.1.305", JSON.stringify(claude)?.slice(0, 300));
  check("owner: two plan windows with a reset time", acct?.usage?.windows?.length === 2 && acct.usage.windows[0].label === "Next few hours" && acct.usage.windows[0].percent === 38 && /2026-10-25/.test(acct.usage.windows[0].resetsAt));
  check("owner: Claude's models come from its own list", acct?.models?.map((m) => m.value).join() === "default,haiku");
  check("owner: a refresh action is offered", claude?.actions?.some((x) => x.kind === "refresh"));
  const codexSignedOut = card(a, "codex");
  check("signed-out Codex: signed_out, no account, a device-code sign-in", codexSignedOut?.state === "signed_out" && codexSignedOut.accounts.length === 0 && codexSignedOut.actions.some((x) => x.kind === "sign_in" && x.via === "device_code"), JSON.stringify(codexSignedOut)?.slice(0, 300));
  check("signed-out Codex: nothing was asked of its app server", !existsSync(join(fakeDir, "codex-spawns")));
  const hermes = card(a, "hermes");
  check("Hermes: connected, labelled with the provider name only", hermes?.state === "connected" && hermes.accounts[0].label === "vps" && !a.text.includes("zzfakekey9"), JSON.stringify(hermes)?.slice(0, 200));
  const omp = card(a, "omp");
  check("omp: connected, models trimmed and grouped by provider", omp?.state === "connected" && omp.accounts[0].models.some((m) => m.value === "openrouter/a/b" && m.group === "openrouter") && !a.text.includes('"cost"'));

  // people who are not the owner
  for (const role of ["member", "viewer"]) {
    const id = `provcheck-${role}`;
    const made1 = await req("POST", "/api/users", { body: { id, name: id, role } });
    made.push(id); // removed in finally even if the answer was odd
    check(`a ${role} can be created`, made1.status === 200 && !!made1.body?.key, `${made1.status} ${made1.text.slice(0, 200)}`);
    const got = await req("GET", "/api/providers", { key: made1.body?.key });
    const text = got.text;
    check(`${role}: GET -> 200`, got.status === 200, String(got.status));
    for (const secret of [OWNER_EMAIL, "Claude Pro", "2.1.305", "resetsAt", "percent", '"windows"', "0.163.0", "18.4.1", tmp, CANARY_API, KEY]) check(`${role}: the response holds no "${secret.slice(0, 24)}"`, !text.includes(secret));
    const c = card(got, "claude");
    check(`${role}: state and models are there, nothing else`, c?.state === "connected" && c.accounts[0].models.length === 2 && c.accounts[0].usage === null && c.accounts[0].email === null && c.accounts[0].label === "Claude" && c.actions.length === 0 && c.version === null);
    check(`${role}: refresh -> 403`, (await req("POST", "/api/providers/refresh", { key: made1.body?.key, body: {} })).status === 403);
  }

  // share links see nothing
  const created = await req("POST", "/api/workspaces", { body: { repo: repoDir, agent: "claude", chat: true } });
  const wid = created.body?.id;
  check("a chat project can be created", typeof wid === "string", created.text.slice(0, 200));
  const shared = await req("POST", `/api/workspaces/${wid}/share`);
  const token = shared.body?.share;
  check("a share token exists", typeof token === "string");
  const viaShare = await req("GET", "/api/providers", { key: "", query: `share=${token}` });
  check("share link: GET /api/providers -> 403", viaShare.status === 403, `${viaShare.status} ${viaShare.text.slice(0, 100)}`);

  // refresh: owner only, rate limited, audited
  check("refresh: an unknown AI -> 400", (await req("POST", "/api/providers/refresh", { body: { id: "../x" } })).status === 400);
  writeFileSync(join(fakeDir, "codex-in"), "");
  const first = await req("POST", "/api/providers/refresh", { body: { id: "codex" } });
  check("refresh: owner -> 200 and Codex is now read", first.status === 200 && card(first, "codex")?.state === "connected" && card(first, "codex").accounts[0].email === CODEX_EMAIL, `${first.status} ${first.text.slice(0, 300)}`);
  const cx = card(first, "codex")?.accounts?.[0];
  check("Codex usage: 42% and 7%, labelled by length, reset times as ISO", cx?.usage?.windows?.map((w) => `${w.label} ${w.percent}`).join(" | ") === "Next few hours 42 | This week 7" && /^2026-/.test(cx.usage.windows[0].resetsAt), JSON.stringify(cx?.usage));
  const methods = new Set(lines(join(fakeDir, "codex-methods")));
  check("Codex was only asked to start, read the account and read the limits", [...methods].every((m) => ["initialize", "initialized", "account/read", "account/rateLimits/read"].includes(m)) && methods.has("account/read"), [...methods].join());
  const again = await req("POST", "/api/providers/refresh", { body: { id: "codex" } });
  check("refresh: a second one within 10 s answers the cached card marked stale", again.status === 200 && card(again, "codex")?.stale === true && lines(join(fakeDir, "codex-spawns")).length === 1, `spawns ${lines(join(fakeDir, "codex-spawns")).length}`);
  const audit = await req("GET", "/api/audit?limit=100");
  check("refresh is in the audit log", JSON.stringify(audit.body).includes("providers.refresh"));

  // what the probes were allowed to do
  check("no message ever reached claude", !existsSync(join(fakeDir, "got-user")));
  check("hermes and omp were only asked what they should be", !existsSync(join(fakeDir, "hermes-bad")) && !existsSync(join(fakeDir, "omp-bad")), existsSync(join(fakeDir, "hermes-bad")) ? readFileSync(join(fakeDir, "hermes-bad"), "utf8") : "");
  const calls = lines(join(fakeDir, "env.log")).map((l) => JSON.parse(l));
  check("every AI was called by its probe", ["claude", "codex", "hermes", "omp"].every((w) => calls.some((c) => c.who === w)));
  const leak = calls.filter((c) => JSON.stringify(c.env).includes(KEY) || JSON.stringify(c.env).includes(CANARY_API) || "KOHLAB_KEY" in c.env || "ANTHROPIC_API_KEY" in c.env);
  check("no probe saw the server's key or the Anthropic key", leak.length === 0, leak.map((c) => c.who).join());
  const everything = [a.text, b.text, first.text, again.text, audit.text].join("\n");
  check("no response holds a canary secret", !everything.includes(CANARY_API) && !everything.includes(KEY));
  const spawned = ["claude-spawns", "codex-spawns"].flatMap((f) => lines(join(fakeDir, f))).map(Number);
  check("no probe process is left running", await waitFor(async () => spawned.every((p) => !alive(p)), 5000), spawned.filter(alive).join());
} catch (e) {
  failures++;
  console.log(`FAIL  ${e.message}`);
} finally {
  // members made for this check go again, with their OS accounts
  for (const id of made) await fetch(`${BASE}/api/users/${id}?key=${encodeURIComponent(KEY)}`, { method: "DELETE" }).catch(() => {});
  try {
    server?.kill("SIGKILL");
  } catch {
    /* gone */
  }
  killDaemon(socket);
  await sleep(300); // killed fakes may still be closing files
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a leftover temp folder is not a failure */
  }
}

console.log(failures ? `\n${failures} failed` : "\nall AI hub checks passed");
process.exit(failures ? 1 : 0);
