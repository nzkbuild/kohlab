#!/usr/bin/env bun
/**
 * OpenCode in Settings → AI, without a terminal: the install (argv and state), the browser-code sign-in (the link and code
 * from real-shaped output, done only after the exit and a listed connection, expiry, replacement), API keys (the exact
 * five-field JSON on stdin; the key never in argv, the audit, a log or a reply), switch and sign out, the profile of each
 * account (create, environment, remove), the card, the member's view, and the chat's "not signed in" line.
 *
 * Nothing here calls a model or touches a real sign-in. A throwaway server with a FAKE npm (installs a fake opencode into
 * the tools folder) and a FAKE opencode (the output shapes from the real one, kept in a store file in the profile folder).
 * HOME and WORKS_DIR are throwaway directories. The real opencode is never run here.
 */
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ROOT, makeCheck, startKit, waitFor } from "./ai-check-kit.mjs";

const { check, finish } = makeCheck();
const works = mkdtempSync(join(tmpdir(), "kohlab-oc-works-"));
const home = mkdtempSync(join(tmpdir(), "kohlab-oc-home-"));
const logFile = join(mkdtempSync(join(tmpdir(), "kohlab-oc-log-")), "calls.log");
const KEY = "sk-fake-OCKEY-0123456789abcdef";
const SIGNIN_MS = 6000;

// ---- the pure part first (no server): this process points its own state at a throwaway folder ----
process.env.WORKS_DIR = works;
const oc = await import("../opencode.ts");
const prov = await import("../providers.ts");
const acp = await import("../acp.ts");
const acc = await import("../accounts.ts");

const DEVICE_OUT =
  "\x1b[?25l\x1b[1m┌\x1b[0m  Connect an integration\n◇  Authorization started\n\x1b[32m●\x1b[0m  Enter code: \x1b[1mGLTD-GCQN\x1b[0m\n" +
  "\x1b[32m●\x1b[0m  \x1b]8;;https://opencode.ai/console/device?user_code=GLTD-GCQN&client_id=opencode-cli\x07https://opencode.ai/console/device?user_code=GLTD-GCQN&client_id=opencode-cli\x1b]8;;\x07\n" +
  "\r\x1b[2K\x1b[36m◒\x1b[0m  Waiting for authorization...\r\x1b[2K◐  Waiting for authorization...";

check("sign-in: the link and code are read from real-shaped output (colour, link and spinner codes)", JSON.stringify(oc.parseDeviceAuth(DEVICE_OUT)) === JSON.stringify({ url: "https://opencode.ai/console/device?user_code=GLTD-GCQN&client_id=opencode-cli", code: "GLTD-GCQN" }), JSON.stringify(oc.parseDeviceAuth(DEVICE_OUT)));
check("sign-in: an OpenAI code line is read too", oc.parseDeviceAuth("Enter code: MW7G-9QPD4\nhttps://auth.openai.com/codex/device\n")?.code === "MW7G-9QPD4");
check("sign-in: no link yet, no code yet, or a plain http link -> nothing", oc.parseDeviceAuth("Enter code: GLTD-GCQN") === null && oc.parseDeviceAuth("https://x.example/a") === null && oc.parseDeviceAuth("Enter code: GLTD-GCQN\nhttp://opencode.ai/x") === null);

const METHODS_OUT = "\x1b[31m■\x1b[0m  Authentication method not found: zzz. Available: chatgpt-token-sharing, chatgpt-browser, chatgpt-headless, key\n";
check("methods: the list after Available: is parsed", JSON.stringify(oc.parseMethods(METHODS_OUT)) === JSON.stringify(["chatgpt-token-sharing", "chatgpt-browser", "chatgpt-headless", "key"]), JSON.stringify(oc.parseMethods(METHODS_OUT)));
check("methods: a line with no Available list -> none", oc.parseMethods("■  Integration not found\n").length === 0);
check("methods: friendly names; browser and legacy hidden; unknown shown raw", oc.methodName("device") === "Browser code" && oc.methodName("chatgpt-headless") === "Sign in with ChatGPT (code)" && oc.methodName("key") === "API key" && oc.methodName("chatgpt-browser") === null && oc.methodName("weird") === "weird");

const AUTH_JSON = '[{"id":"anthropic","name":"Anthropic","connections":[{"type":"credential","id":"cred_1","label":"Anthropic","method":"key"}]}]';
check("auth list: one connection per credential, with its service", JSON.stringify(oc.parseAuthList(AUTH_JSON)) === JSON.stringify([{ integration: "anthropic", name: "Anthropic", id: "cred_1", label: "Anthropic", method: "key", active: false }]), JSON.stringify(oc.parseAuthList(AUTH_JSON)));
check("auth list: [] is signed out; not JSON is unreadable (null)", JSON.stringify(oc.parseAuthList("[]")) === "[]" && oc.parseAuthList("not json") === null && oc.parseAuthList("{}") === null);

check("export: only the ids in use are kept (the keys are dropped); not JSON -> null", (() => { const on = oc.parseActiveIds('[{"id":"a","active":true,"value":{"type":"key","key":"SECRET"}},{"id":"b","active":false,"value":{"key":"SECRET2"}}]'); return on && on.size === 1 && on.has("a") && !JSON.stringify([...on]).includes("SECRET"); })() && oc.parseActiveIds("nope") === null);

const models = oc.parseModels("opencode/zen-model\n\x1b[2mopenai/gpt-x\x1b[0m\nnot a model\nanthropic/claude-x/extra\n");
check("models: provider/model lines, grouped by the provider; other lines dropped", models.length === 3 && models[0].group === "opencode" && models[1].label === "gpt-x" && models[2].label === "claude-x/extra", JSON.stringify(models));

const payload = JSON.parse(oc.importPayload("cred_kohlab_abc", "anthropic", "Work", KEY));
check("import: exactly the five fields, the key only as value.key", Array.isArray(payload) && payload.length === 1 && JSON.stringify(Object.keys(payload[0]).sort()) === JSON.stringify(["active", "id", "integrationID", "label", "value"]) && payload[0].active === false && payload[0].value.type === "key" && payload[0].value.key === KEY, JSON.stringify(payload).slice(0, 200));

const PURE_TOOLS = "/x/tools/opencode";
check("install: the pinned package, scripts approved, then rebuilt", JSON.stringify(oc.installArgs(PURE_TOOLS)) === JSON.stringify([["install", "--prefix", PURE_TOOLS, "@opencode/cli@2.3.0", "--ignore-scripts=false"], ["install-scripts", "approve", "@opencode/cli"], ["rebuild", "--prefix", PURE_TOOLS, "@opencode/cli"]]));
{
  const calls = [];
  const done = await oc.runInstall(PURE_TOOLS, async (args, cwd) => (calls.push({ args, cwd }), true));
  check("install state: every step run in order, in the install folder, ends done", done === "done" && calls.length === 3 && calls[1].cwd === PURE_TOOLS && calls[2].args[0] === "rebuild", JSON.stringify(calls));
  const seen = [];
  const failed = await oc.runInstall(PURE_TOOLS, async (args) => (seen.push(args[0]), args[0] !== "install-scripts"));
  check("install state: the first failed step ends it as failed", failed === "failed" && JSON.stringify(seen) === '["install","install-scripts"]', JSON.stringify(seen));
}

// cards from what the probes read (pure)
const notInstalled = prov.opencodeNotInstalledCard(1);
check("card: not installed shows one Install action", notInstalled.installed === false && notInstalled.state === "not_installed" && notInstalled.actions[0].kind === "install", JSON.stringify(notInstalled.actions));
const conns2 = oc.parseAuthList(
  '[{"id":"opencode","name":"OpenCode Console","connections":[{"type":"credential","id":"cred_a","label":"OpenCode Console","method":"device"}]},' +
    '{"id":"anthropic","name":"Anthropic","connections":[{"type":"credential","id":"cred_b","label":"Work","method":"key"}]}]',
);
const SAMPLE_MODELS = [{ value: "anthropic/claude-x", label: "claude-x", group: "anthropic" }];
const rowOn = prov.opencodeRowFrom({ id: "main:opencode", label: "Main account", kind: "default", now: 5, conns: conns2, models: SAMPLE_MODELS });
check("card row: connected, summarised by service and how, with its connections and models", rowOn.state === "connected" && rowOn.plan === "OpenCode Console, Anthropic (API key)" && rowOn.connections.length === 2 && rowOn.models.length === 1 && rowOn.usage === null, JSON.stringify(rowOn).slice(0, 300));
const rowOff = prov.opencodeRowFrom({ id: "main:opencode", label: "Main account", kind: "default", now: 5, conns: [], models: SAMPLE_MODELS });
check("card row: signed out has no models or plan", rowOff.state === "signed_out" && rowOff.plan === null && rowOff.models.length === 0 && rowOff.connections.length === 0);
check("card row: a profile that could not be read is an error row", prov.opencodeRowFrom({ id: "x", label: "X", kind: "login", now: 5, conns: null, models: [] }).state === "error");
{
  const card = prov.combineAccounts("opencode", 5, "2.3.0", [rowOn], { kind: "sign_in", label: "Sign in", via: "device_code" }, []);
  const member = JSON.stringify(prov.redactCard(card));
  check("redaction: a member's card has no connections, service names or labels", card.state === "connected" && !member.includes("connections") && !member.includes("Work") && !member.includes("Anthropic (API key)"), member.slice(0, 300));
}

check("chat: an OpenCode lane that is not signed in gets the OpenCode sentence", acp.acpStartFailure("opencode", { code: -32000 }) === "OpenCode isn't signed in yet. Ask the owner to sign in from Settings → AI.");
check("chat: the other lanes keep their sentences", acp.acpStartFailure("codex", { code: -32000 }) === "Codex isn't signed in yet. Ask the owner to sign in from Settings → AI.");

// the profile of an OpenCode account (its own folders, in the chat's environment; removed with it)
{
  const made = acc.createLogin("opencode", "Pure check");
  const dir = acc.dirOf(made.id);
  const env = acc.accountEnv({ account: made.id, agent: "opencode" });
  check("profile: create makes its data, config, state and cache folders", ["data", "config", "state", "cache"].every((d) => existsSync(join(dir, d))));
  check("profile: the chat's environment points OpenCode at them (XDG_*)", env.XDG_DATA_HOME === join(dir, "data") && env.XDG_CONFIG_HOME === join(dir, "config") && env.XDG_STATE_HOME === join(dir, "state") && env.XDG_CACHE_HOME === join(dir, "cache"), JSON.stringify(env));
  const child = acc.childEnv("/h", env);
  check("profile: the child gets those and only the allowlist (no secret keys)", child.XDG_DATA_HOME === join(dir, "data") && child.HOME === "/h" && !("KOHLAB_KEY" in child), JSON.stringify(Object.keys(child)));
  acc.remove(made.id);
  check("profile: remove deletes the profile folder", !existsSync(dir));
}

// ---- the throwaway server, with a FAKE opencode and a FAKE npm ----

const OC_SRC = (logPath) =>
  `#!/usr/bin/env node\nconst LOG = ${JSON.stringify(logPath)};\n(${fakeOpencode.toString()})();\n`;

/** The fake opencode: the output shapes of the real one; a credential store in the profile's data folder; approval by a file. */
function fakeOpencode() {
  const fs = require("node:fs");
  const path = require("node:path");
  const argv = process.argv.slice(2);
  const data = process.env.XDG_DATA_HOME || path.join(process.env.HOME || "/", ".local", "share");
  const dir = path.join(data, "opencode");
  const store = path.join(dir, "store.json");
  const NAMES = { opencode: "OpenCode Console", openai: "OpenAI", anthropic: "Anthropic", "github-copilot": "GitHub Copilot" };
  const METHODS = {
    opencode: ["device", "key"],
    openai: ["chatgpt-token-sharing", "chatgpt-browser", "chatgpt-headless", "key"],
    anthropic: ["key"],
    "github-copilot": ["device", "key"],
  };
  const MODELS = { opencode: ["opencode/zen-model"], openai: ["openai/gpt-test"], anthropic: ["anthropic/claude-test"] };
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(store, "utf8"));
    } catch {
      return [];
    }
  };
  const write = (s) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(store, JSON.stringify(s));
  };
  const out = (s) => process.stdout.write(s);
  const finish = (code) => process.exit(code);
  fs.mkdirSync(dir, { recursive: true });
  if (argv[0] === "--version") {
    out("opencode v2.3.0\n");
    finish(0);
  }
  fs.appendFileSync(LOG, JSON.stringify({ argv, profile: data, browser: process.env.BROWSER ?? null, home: process.env.HOME ?? null, cwd: process.cwd() }) + "\n");
  const [a, b] = argv;
  if (a === "auth" && b === "list") {
    const groups = new Map();
    for (const c of read()) {
      if (!groups.has(c.integrationID)) groups.set(c.integrationID, { id: c.integrationID, name: NAMES[c.integrationID] || c.integrationID, connections: [] });
      groups.get(c.integrationID).connections.push({ type: "credential", id: c.id, label: c.label, method: c.method }); // the real list has no "active"
    }
    out(JSON.stringify([...groups.values()]));
    finish(0);
  }
  if (a === "auth" && b === "login") {
    const int = argv[2];
    const method = argv[argv.indexOf("--method") + 1];
    const list = METHODS[int] || [];
    if (!list.includes(method)) {
      out(`\x1b[31m■\x1b[0m  Authentication method not found: ${method}. Available: ${list.join(", ")}\n`);
      finish(1);
    }
    if (method === "key") {
      out("■  API key input requires an interactive terminal\n");
      finish(1);
    }
    if (int === "github-copilot" && method === "device") {
      out("■  Authentication form input requires an interactive terminal\n");
      finish(1);
    }
    const code = method === "device" ? "GLTD-GCQN" : "MW7G-9QPD4";
    const url = method === "device" ? `https://opencode.ai/console/device?user_code=${code}&client_id=opencode-cli` : "https://auth.openai.com/codex/device";
    out("\x1b[?25l\x1b[1m┌\x1b[0m  Connect an integration\n◇  Authorization started\n");
    out(`\x1b[32m●\x1b[0m  Enter code: \x1b[1m${code}\x1b[0m\n`);
    out(`\x1b[32m●\x1b[0m  \x1b]8;;${url}\x07${url}\x1b]8;;\x07\n`);
    for (const f of ["◒", "◐", "◓", "◑"]) out(`\r\x1b[2K\x1b[36m${f}\x1b[0m  Waiting for authorization...`);
    out("\n");
    const approve = path.join(dir, "approve");
    const timer = setInterval(() => {
      if (!fs.existsSync(approve)) return;
      fs.unlinkSync(approve);
      clearInterval(timer);
      const s = read();
      s.push({ id: `cred_login_${s.length + 1}`, integrationID: int, label: NAMES[int], method, active: !s.some((c) => c.integrationID === int) });
      write(s);
      out(`◇  Connected to ${NAMES[int]}\n└  Done\n`);
      finish(0);
    }, 100);
    setTimeout(() => finish(1), 40_000); // a sign-in nobody approves is not left running
    return;
  }
  if (a === "auth" && b === "export") {
    // the real export: five fields, the key included, the only place "active" is
    out(JSON.stringify(read().map((c) => ({ id: c.id, integrationID: c.integrationID, label: c.label, active: !!c.active, value: { type: "key", key: c.key || "sk-fake" } })), null, 2) + "\n");
    finish(0);
  }
  if (a === "auth" && b === "import") {
    let input = "";
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      let items = null;
      try {
        items = JSON.parse(input);
      } catch {
        items = null;
      }
      const fields = ["id", "integrationID", "label", "active", "value"];
      const ok = Array.isArray(items) && items.length > 0 && items.every((it) => fields.every((f) => f in it));
      fs.appendFileSync(LOG, JSON.stringify({ argv, stdin: input, imported: ok }) + "\n");
      if (!ok) {
        out("└  Failed\n");
        finish(1);
      }
      const s = read();
      for (const it of items) s.push({ id: it.id, integrationID: it.integrationID, label: it.label, method: "key", active: !!it.active || !s.some((c) => c.integrationID === it.integrationID), key: it.value.key }); // the real import makes the first of a service active
      write(s);
      out(`Imported ${items.length} credential\n`);
      finish(0);
    });
    return;
  }
  if (a === "auth" && (b === "switch" || b === "logout")) {
    const int = argv[2];
    const label = argv[3];
    let s = read();
    if (!s.some((c) => c.integrationID === int && c.label === label)) {
      out("└  Failed\n");
      finish(1);
    }
    if (b === "switch") s = s.map((c) => (c.integrationID === int ? { ...c, active: c.label === label } : c));
    else s = s.filter((c) => !(c.integrationID === int && c.label === label));
    write(s);
    out("└  Done\n");
    finish(0);
  }
  if (a === "models") {
    for (const i of new Set(read().map((c) => c.integrationID))) for (const m of MODELS[i] || []) out(`${m}\n`);
    finish(0);
  }
  out("unknown command\n");
  finish(1);
}

/** The fake npm: records each call, and an install copies the fake opencode into the folder's node_modules/.bin. */
function fakeNpm() {
  const fs = require("node:fs");
  const path = require("node:path");
  const argv = process.argv.slice(2);
  fs.appendFileSync(LOG, JSON.stringify({ npm: true, argv, cwd: process.cwd(), home: process.env.HOME ?? null }) + "\n");
  if (argv[0] === "install") {
    const bin = path.join(argv[argv.indexOf("--prefix") + 1], "node_modules", ".bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "opencode"), SRC, { mode: 0o755 });
    fs.chmodSync(path.join(bin, "opencode"), 0o755);
  }
  process.exit(0);
}
const NPM_SRC = (text) => `#!/usr/bin/env node\nconst LOG = ${JSON.stringify(logFile)};\nconst SRC = ${JSON.stringify(text)};\n(${fakeNpm.toString()})();\n`;

const kit = await startKit({ env: { HOME: home, KOHLAB_SIGNIN_TIMEOUT_MS: String(SIGNIN_MS) } });
kit.put("npm", NPM_SRC(OC_SRC(logFile)));
const calls = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const TOOLS = join(kit.works, "tools", "opencode");
const MAIN_DATA_HOME = join(home, ".local", "share");
const MAIN_DATA = join(MAIN_DATA_HOME, "opencode");

/** Polls a route until its body satisfies want (or ms passes). */
async function until(path, want, ms = 30_000, asKey) {
  let last;
  await waitFor(async () => {
    last = (await kit.req("GET", path, undefined, asKey)).body;
    return want(last);
  }, ms);
  return last;
}
const connsOf = (b) => (Array.isArray(b?.connections) ? b.connections : []);

try {
  // ---- the card before any install ----
  const before = await kit.req("GET", "/api/providers");
  const ocBefore = before.body?.providers?.find((p) => p.id === "opencode");
  check("the AI hub has an OpenCode card", !!ocBefore, before.text.slice(0, 200));
  check("not installed: the card says so and offers Install", ocBefore?.installed === false && ocBefore?.state === "not_installed" && ocBefore?.actions?.[0]?.kind === "install", JSON.stringify(ocBefore?.actions));
  check("install state starts idle", (await kit.req("GET", "/api/ai/providers/opencode/install")).body?.state === "idle");

  // ---- install (owner only, as the fake npm records) ----
  const ins = await kit.req("POST", "/api/ai/providers/opencode/install");
  check("install starts (installing, or done at once)", ins.status === 200 && ["installing", "done"].includes(ins.body?.state), ins.text);
  const doneIns = await until("/api/ai/providers/opencode/install", (b) => b?.state === "done" || b?.state === "failed");
  check("install ends done", doneIns?.state === "done", JSON.stringify(doneIns));
  const npmCalls = calls().filter((c) => c.npm);
  check("install: the pinned package, then approve, then rebuild, in the tools folder", npmCalls.length === 3 && JSON.stringify(npmCalls[0].argv) === JSON.stringify(["install", "--prefix", TOOLS, "@opencode/cli@2.3.0", "--ignore-scripts=false"]) && npmCalls[1].argv.join(" ") === "install-scripts approve @opencode/cli" && npmCalls[1].cwd === TOOLS && npmCalls[2].argv[0] === "rebuild", JSON.stringify(npmCalls));
  check("install: the copy is on the tools folder's bin, not the server's PATH", existsSync(join(TOOLS, "node_modules", ".bin", "opencode")));
  const audit1 = await waitFor(() => existsSync(join(kit.works, "audit.log")) && readFileSync(join(kit.works, "audit.log"), "utf8").includes("ai.opencode.install"), 5000);
  check("install is audited", audit1);

  const viewerPost = await kit.req("POST", "/api/users", { id: "oc-viewer", name: "oc-viewer", role: "viewer" });
  const vk = typeof viewerPost.body?.key === "string" ? viewerPost.body.key : null;
  if (vk) {
    check("a viewer cannot install (403)", (await kit.req("POST", "/api/ai/providers/opencode/install", undefined, vk)).status === 403);
    check("a viewer cannot sign in or add a key (403)", (await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/signin", { integration: "opencode", method: "device" }, vk)).status === 403 && (await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/key", { integration: "anthropic", key: KEY }, vk)).status === 403);
    const vprov = await kit.req("GET", "/api/providers", undefined, vk);
    const vcard = vprov.body?.providers?.find((p) => p.id === "opencode");
    check("a viewer sees the OpenCode card without connections or plan text", vprov.status === 200 && !!vcard && !vprov.text.includes("connections"), vprov.text.slice(0, 200));
    await kit.req("DELETE", "/api/users/oc-viewer");
  } else check("a viewer can be made for the check", false, viewerPost.text);

  // ---- what the picker offers ----
  const pop = await kit.req("GET", "/api/ai/opencode/integrations");
  check("the picker lists the popular services", pop.status === 200 && pop.body.popular.some((p) => p.id === "opencode") && pop.body.popular.some((p) => p.id === "openai"), pop.text.slice(0, 200));
  const om = await kit.req("GET", "/api/ai/opencode/integrations?integration=openai");
  check("methods for OpenAI: ChatGPT (code) and API key; browser and legacy hidden", JSON.stringify(om.body.methods) === JSON.stringify([{ id: "chatgpt-headless", name: "Sign in with ChatGPT (code)" }, { id: "key", name: "API key" }]), om.text);
  const gm = await kit.req("GET", "/api/ai/opencode/integrations?integration=github-copilot");
  check("methods for GitHub Copilot: Browser code and API key", JSON.stringify(gm.body.methods) === JSON.stringify([{ id: "device", name: "Browser code" }, { id: "key", name: "API key" }]), gm.text);
  check("a service id that is not valid is refused (400)", (await kit.req("GET", "/api/ai/opencode/integrations?integration=Bad%20Id!")).status === 400);

  // ---- the AI's own profile: signed out, then a browser-code sign-in ----
  const main0 = await until("/api/providers", (b) => b?.providers?.find((p) => p.id === "opencode")?.state === "signed_out", 15_000);
  check("main account signed out: the card says so with Sign in", main0?.providers?.find((p) => p.id === "opencode")?.accounts?.[0]?.state === "signed_out", JSON.stringify(main0?.providers?.find((p) => p.id === "opencode")?.actions));

  const d1 = await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/signin", { integration: "opencode", method: "device" });
  check("browser code: the sign-in waits with the link and the code", d1.status === 200 && d1.body.state === "waiting" && d1.body.code === "GLTD-GCQN" && d1.body.url === "https://opencode.ai/console/device?user_code=GLTD-GCQN&client_id=opencode-cli", d1.text);
  const d2 = await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/signin", { integration: "openai", method: "chatgpt-headless" });
  check("a new sign-in replaces the one waiting", d2.body.state === "waiting" && d2.body.code === "MW7G-9QPD4", d2.text);
  const d3 = await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/signin", { integration: "openai", method: "chatgpt-headless" });
  check("the same sign-in asked again gives the same code", d3.body.code === "MW7G-9QPD4", d3.text);
  const polled = await kit.req("GET", "/api/ai/accounts/main:opencode/opencode/signin");
  check("polling a waiting sign-in says waiting", polled.body.state === "waiting", polled.text);
  check("the main account's sign-in runs in the AI's own profile (no XDG override)", calls().some((c) => c.argv?.[1] === "login" && c.profile === MAIN_DATA_HOME && c.browser === "none"), JSON.stringify(calls().filter((c) => c.argv?.[1] === "login").slice(-1)));
  // approve in the browser (the fake sees the file)
  writeFileSync(join(MAIN_DATA, "approve"), "1");
  const done1 = await until("/api/ai/accounts/main:opencode/opencode/signin", (b) => b?.state === "done" || b?.state === "failed", 20_000);
  check("approved: the sign-in is done (after the exit and a listed connection)", done1?.state === "done", JSON.stringify(done1));
  const card1 = (await kit.req("GET", "/api/providers")).body.providers.find((p) => p.id === "opencode");
  const main1 = card1?.accounts?.find((a) => a.id === "main:opencode");
  check("connected: the card lists the connection and its models", card1?.state === "connected" && main1?.state === "connected" && connsOf(main1).some((c) => c.integration === "openai" && c.label === "OpenAI") && main1.models.some((m) => m.value === "openai/gpt-test" && m.group === "openai"), JSON.stringify(main1).slice(0, 400));

  const dev = await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/signin", { integration: "opencode", method: "device" });
  check("a second service signs in the same way", dev.body.code === "GLTD-GCQN", dev.text);
  writeFileSync(join(MAIN_DATA, "approve"), "1");
  await until("/api/ai/accounts/main:opencode/opencode/signin", (b) => b?.state === "done" || b?.state === "failed", 20_000);
  const cop = await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/signin", { integration: "github-copilot", method: "device" });
  check("a service that needs a form says it is not available here", cop.body.state === "failed" && cop.body.error === "Not available here yet.", cop.text);

  // ---- API keys: the five fields on stdin, the key nowhere else ----
  const k1 = await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/key", { integration: "anthropic", key: KEY, label: "Work" });
  check("a key is saved: the connection lists, and the first for a service is used", k1.status === 200 && connsOf(k1.body).some((c) => c.integration === "anthropic" && c.label === "Work" && c.active === true), k1.text);
  const imp = calls().find((c) => typeof c.stdin === "string");
  const impItem = imp ? JSON.parse(imp.stdin)[0] : null;
  check("the key goes to auth import on stdin: exactly the five fields", !!impItem && JSON.stringify(Object.keys(impItem).sort()) === JSON.stringify(["active", "id", "integrationID", "label", "value"]) && impItem.integrationID === "anthropic" && impItem.label === "Work" && impItem.active === false && impItem.value.type === "key" && impItem.value.key === KEY && /^cred_kohlab_[0-9a-f]{18}$/.test(impItem.id), JSON.stringify(imp)?.slice(0, 300));
  check("the key is not in any command's argv", calls().every((c) => !JSON.stringify(c.argv ?? []).includes(KEY)));
  check("the import is run as the login's argv (fixed) with --standalone", calls().some((c) => JSON.stringify(c.argv) === JSON.stringify(["auth", "import", "--standalone"])));
  check("the key is not in the reply", !k1.text.includes(KEY));
  const dupe = await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/key", { integration: "anthropic", key: "sk-fake-OTHERKEY-0123456789", label: "Work" });
  check("the same name for the same service is refused (409)", dupe.status === 409, dupe.text);
  const k2 = await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/key", { integration: "anthropic", key: "sk-fake-SECOND-0123456789", label: "Home", useNow: true });
  check("a second key is saved; chosen to use now, it becomes the one used", k2.status === 200 && connsOf(k2.body).find((c) => c.label === "Home")?.active === true && connsOf(k2.body).find((c) => c.label === "Work")?.active === false, k2.text);
  check("bad input is refused (400): service id, short key, control character, long name, leading dash", (await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/key", { integration: "Bad Id", key: KEY })).status === 400 && (await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/key", { integration: "anthropic", key: "short" })).status === 400 && (await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/key", { integration: "anthropic", key: "sk-fake-\n-0123456789" })).status === 400 && (await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/key", { integration: "anthropic", key: KEY, label: "x".repeat(61) })).status === 400 && (await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/key", { integration: "anthropic", key: KEY, label: "-rm" })).status === 400);

  const sw = await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/switch", { integration: "anthropic", label: "Work" });
  check("use this one: switches, and argv is fixed", sw.status === 200 && connsOf(sw.body).find((c) => c.label === "Work")?.active === true && calls().some((c) => JSON.stringify(c.argv) === JSON.stringify(["auth", "switch", "anthropic", "Work", "--standalone"])), sw.text);
  const badSw = await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/switch", { integration: "anthropic", label: "Nope" });
  check("a connection that is not there -> 400", badSw.status === 400, badSw.text);
  const lo = await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/logout", { integration: "anthropic", label: "Home" });
  check("sign out of one connection removes only that one", lo.status === 200 && !connsOf(lo.body).some((c) => c.label === "Home") && connsOf(lo.body).some((c) => c.label === "Work"), lo.text);

  const audit2 = await waitFor(() => readFileSync(join(kit.works, "audit.log"), "utf8").includes("ai.opencode.key"), 5000);
  check("keys, switches and sign-ins are audited", audit2 && readFileSync(join(kit.works, "audit.log"), "utf8").includes("ai.opencode.signin"));

  // ---- an extra account: its own profile, its own sign-in and keys ----
  const made = await kit.req("POST", "/api/ai/accounts", { provider: "opencode", kind: "login" });
  const extra = made.body?.account;
  check("another OpenCode account is created with a name (Account 1)", made.status === 200 && extra?.provider === "opencode" && extra?.label === "Account 1", made.text);
  const xdir = join(kit.works, "accounts", extra?.id ?? "none");
  check("the account has its own profile folders", ["data", "config", "state", "cache"].every((d) => existsSync(join(xdir, d))));
  const xsign = await kit.req("POST", `/api/ai/accounts/${extra.id}/opencode/signin`, { integration: "openai", method: "chatgpt-headless" });
  check("the extra account signs in inside its own profile", xsign.body.state === "waiting" && xsign.body.code === "MW7G-9QPD4" && calls().some((c) => c.argv?.[1] === "login" && c.profile === join(xdir, "data")), xsign.text);
  writeFileSync(join(xdir, "data", "opencode", "approve"), "1");
  const xdone = await until(`/api/ai/accounts/${extra.id}/opencode/signin`, (b) => b?.state === "done" || b?.state === "failed", 20_000);
  check("the extra account's sign-in is done", xdone?.state === "done", JSON.stringify(xdone));
  const xk = await kit.req("POST", `/api/ai/accounts/${extra.id}/opencode/key`, { integration: "anthropic", key: "sk-fake-EXTRA-0123456789", label: "Second" });
  check("a key on the extra account stays in its own profile", xk.status === 200 && connsOf(xk.body).some((c) => c.label === "Second") && !connsOf(xk.body).some((c) => c.label === "Work"), xk.text);
  const card2 = (await kit.req("GET", "/api/providers")).body.providers.find((p) => p.id === "opencode");
  check("the card has the main account and the extra one, each with its own connections", card2?.accounts?.length === 2 && card2.accounts.some((a) => a.id === extra.id && connsOf(a).some((c) => c.label === "Second")) && card2.accounts.some((a) => a.id === "main:opencode" && connsOf(a).some((c) => c.label === "Work")), JSON.stringify(card2?.accounts?.map((a) => [a.id, a.state])));
  check("OpenCode accounts sign in per connection on the generic routes (400)", (await kit.req("POST", `/api/ai/accounts/${extra.id}/signin`, {})).status === 400 && (await kit.req("POST", `/api/ai/accounts/${extra.id}/signout`, {})).status === 400);

  // a sign-in nobody finishes expires
  const ex = await kit.req("POST", `/api/ai/accounts/${extra.id}/opencode/signin`, { integration: "opencode", method: "device" });
  check("an unfinished sign-in is waiting first", ex.body.state === "waiting", ex.text);
  const exp = await until(`/api/ai/accounts/${extra.id}/opencode/signin`, (b) => b?.state === "expired", SIGNIN_MS + 15_000);
  check("an unfinished sign-in expires", exp?.state === "expired", JSON.stringify(exp));

  // removing the extra account removes its folder
  const del = await kit.req("DELETE", `/api/ai/accounts/${extra.id}`);
  check("removing the extra account deletes its profile folder", del.status === 200 && !existsSync(xdir), del.text);

  // ---- nothing the server wrote holds the key (the fake's own store, in the profile, is the one place it lives) ----
  const leaks = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (!(p.endsWith(join("opencode", "store.json")))) {
        try {
          if (readFileSync(p, "utf8").includes(KEY)) leaks.push(p);
        } catch {
          /* binary or gone */
        }
      }
    }
  };
  walk(kit.works);
  check("the key is in no file Kohlab wrote (state, accounts, audit), outside OpenCode's own store", leaks.length === 0, leaks.join(", "));
  check("the key is not in the server's log", !kit.log().includes(KEY));
  check("the key is not in the audit", !readFileSync(join(kit.works, "audit.log"), "utf8").includes(KEY));
  check("the key is not in an error reply either", !(await kit.req("POST", "/api/ai/accounts/main:opencode/opencode/key", { integration: "anthropic", key: KEY, label: "Work" })).text.includes(KEY));

  // a sign-in that could not be read, and the card that shows it
  check("the agents status knows whether OpenCode is there", (await kit.req("GET", "/api/agents-status")).body?.opencode === true);
} finally {
  await kit.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(works, { recursive: true, force: true });
  rmSync(dirname(logFile), { recursive: true, force: true });
}

finish("OpenCode");
