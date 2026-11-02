/**
 * Sign in without a terminal: the AI's own Claude and Codex logins, extra Claude accounts, sign-out, the timeout, and
 * whether the agent identity can reach its accounts. A throwaway server with FAKE claude and codex on PATH (no model, no
 * real sign-in). HOME is a throwaway directory, so the main logins never touch the real ~/.claude or ~/.codex.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, makeCheck, startKit, waitFor } from "./ai-check-kit.mjs";

const { check, finish } = makeCheck();
const home = mkdtempSync(join(tmpdir(), "kohlab-signin-home-"));
const TIMEOUT_MS = 8000;

// The fake claude: `auth status` reads a flag file in its config dir (CLAUDE_CONFIG_DIR, or ~/.claude for the main login);
// `auth login` prints a link, then waits for a pasted code; a code with GOOD in it signs in.
const FAKE_CLAUDE = `#!/bin/sh
DIR="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$DIR"
case "$1 $2" in
  "--version "*) echo "claude 9.9.9"; exit 0;;
  "auth status") if [ -f "$DIR/signed-in" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; else echo '{"loggedIn":false}'; fi; exit 0;;
  "auth logout") rm -f "$DIR/signed-in"; echo "Logged out"; exit 0;;
  "auth login")
    echo "Opening browser to sign in..."
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc123"
    printf "Paste code here if prompted > "
    read -r line
    case "$line" in *GOOD*) touch "$DIR/signed-in"; exit 0;; esac
    echo "Login failed: Request failed with status code 400" >&2
    exit 1;;
esac
exit 0
`;

// The fake codex: a device-code login that waits until the test writes an "approve" file (the browser approval).
const FAKE_CODEX = `#!/bin/sh
DIR="\${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$DIR"
case "$1 $2" in
  "--version "*) echo "codex 9.9.9"; exit 0;;
  "login status") if [ -f "$DIR/signed-in" ]; then echo "Logged in using ChatGPT"; exit 0; fi; echo "Not logged in"; exit 1;;
  "login --device-auth")
    echo "Welcome to Codex"
    echo "Open this link in your browser:"
    echo "https://auth.openai.com/codex/device"
    echo "and enter this one-time code:"
    echo "ABCD-1234"
    while [ ! -f "$DIR/approve" ]; do sleep 0.2; done
    rm -f "$DIR/approve"; touch "$DIR/signed-in"; exit 0;;
  "logout "*) rm -f "$DIR/signed-in"; echo "Logged out"; exit 0;;
esac
exit 0
`;

const kit = await startKit({ env: { HOME: home, KOHLAB_SIGNIN_TIMEOUT_MS: String(TIMEOUT_MS) } });
kit.put("claude", FAKE_CLAUDE);
kit.put("codex", FAKE_CODEX);

/** Polls a route until its body satisfies want (or ms passes). Returns the last body. */
async function until(path, want, ms = TIMEOUT_MS + 7000) {
  let last;
  await waitFor(async () => {
    last = (await kit.req("GET", path)).body;
    return want(last);
  }, ms);
  return last;
}

const isLink = (s) => typeof s?.url === "string" && s.url.startsWith("https://");

try {
  // ---- the AI's own Claude login ----
  const s1 = await kit.req("POST", "/api/ai/providers/claude/signin");
  check("main Claude: start gives a waiting sign-in with a link", s1.status === 200 && s1.body.state === "waiting" && isLink(s1.body) && s1.body.needsCode === true, s1.text);
  const s1b = await kit.req("POST", "/api/ai/providers/claude/signin");
  check("main Claude: a second start while waiting gives the same link", s1b.body.url === s1.body.url, s1b.text);

  const c1 = await kit.req("POST", "/api/ai/providers/claude/signin/code", { code: "GOOD-1234" });
  check("main Claude: the code is accepted", c1.status === 200, c1.text);
  const d1 = await until("/api/ai/providers/claude/signin", (s) => s.state === "done");
  check("main Claude: code then done", d1?.state === "done", JSON.stringify(d1));
  check("main Claude: the login is in the throwaway home", existsSync(join(home, ".claude", "signed-in")));

  // ---- an extra Claude account, signed in and signed out again ----
  const made = await kit.req("POST", "/api/ai/accounts", { provider: "claude", kind: "login", label: "Second" });
  const acct = made.body?.account?.id;
  check("an extra account is created", typeof acct === "string", made.text);
  const a1 = await kit.req("POST", `/api/ai/accounts/${acct}/signin`);
  check("account: start gives a waiting sign-in with a link", a1.body.state === "waiting" && isLink(a1.body), a1.text);
  await kit.req("POST", `/api/ai/accounts/${acct}/signin/code`, { code: "GOOD-5678" });
  const ad = await until(`/api/ai/accounts/${acct}/signin`, (s) => s.state === "done");
  check("account: code then done", ad?.state === "done", JSON.stringify(ad));
  const listed1 = (await kit.req("GET", "/api/ai/accounts")).body.accounts;
  check("account: shows as signed in", listed1.find((a) => a.id === acct)?.signedIn === true, JSON.stringify(listed1));

  const so = await kit.req("POST", `/api/ai/accounts/${acct}/signout`);
  check("account signout: ok", so.status === 200 && so.body.ok === true, so.text);
  const listed2 = (await kit.req("GET", "/api/ai/accounts")).body.accounts;
  check("account signout keeps the account, signed out", listed2.some((a) => a.id === acct && a.signedIn === false), JSON.stringify(listed2));

  // ---- main Claude signed out: the card says Sign in on the page ----
  const mo = await kit.req("POST", "/api/ai/providers/claude/signout");
  check("main Claude signout: ok", mo.status === 200 && mo.body.ok === true, mo.text);
  check("main Claude signout: the login is gone", !existsSync(join(home, ".claude", "signed-in")));
  const hub = await kit.req("GET", "/api/providers");
  const claude = hub.body?.providers?.find((p) => p.id === "claude");
  check("main Claude signed out: the card is signed_out", claude?.state === "signed_out", hub.text.slice(0, 300));
  check(
    "main Claude signed out: Sign in opens the page (via url), no terminal hint",
    !!claude?.actions?.some((a) => a.kind === "sign_in" && a.via === "url") && !hub.text.includes("run claude auth login"),
    JSON.stringify(claude?.actions),
  );

  // ---- the AI's own Codex login ----
  const cs = await kit.req("POST", "/api/ai/providers/codex/signin");
  check("main Codex: start gives a link and a one-time code", cs.body.state === "waiting" && isLink(cs.body) && cs.body.code === "ABCD-1234", cs.text);
  writeFileSync(join(home, ".codex", "approve"), "1"); // the browser approval
  const cd = await until("/api/ai/providers/codex/signin", (s) => s.state === "done");
  check("main Codex: approved then done", cd?.state === "done", JSON.stringify(cd));
  const cso = await kit.req("POST", "/api/ai/providers/codex/signout");
  check("main Codex signout: ok, login gone", cso.status === 200 && cso.body.ok === true && !existsSync(join(home, ".codex", "signed-in")), cso.text);

  // ---- routes that do not exist, and who may not use them ----
  const hermes = await kit.req("POST", "/api/ai/providers/hermes/signin");
  check("provider hermes is 404 with an error", hermes.status === 404 && typeof hermes.body?.error === "string", hermes.text);
  const hermesOut = await kit.req("POST", "/api/ai/providers/hermes/signout");
  check("provider hermes signout is 404 too", hermesOut.status === 404, hermesOut.text);

  const viewer = await kit.req("POST", "/api/users", { id: "signin-viewer", name: "signin-viewer", role: "viewer" });
  if (typeof viewer.body?.key === "string") {
    const vk = viewer.body.key;
    const outs = [
      await kit.req("POST", "/api/ai/providers/claude/signin", undefined, vk),
      await kit.req("GET", "/api/ai/providers/claude/signin", undefined, vk),
      await kit.req("POST", "/api/ai/providers/claude/signout", undefined, vk),
      await kit.req("POST", `/api/ai/accounts/${acct}/signout`, undefined, vk),
    ];
    check("a non-owner is refused every sign-in and sign-out (403)", outs.every((r) => r.status === 403), outs.map((r) => r.status).join(","));
    await kit.req("DELETE", "/api/users/signin-viewer");
  } else check("a non-owner is refused (403)", false, viewer.text);

  // ---- a sign-in nobody finishes expires, and starting again replaces it ----
  const made2 = await kit.req("POST", "/api/ai/accounts", { provider: "claude", kind: "login", label: "Timeout" });
  const slow = made2.body?.account?.id;
  const t1 = await kit.req("POST", `/api/ai/accounts/${slow}/signin`);
  check("timeout: a sign-in waits for its code", t1.body.state === "waiting" && isLink(t1.body), t1.text);
  const expired = await until(`/api/ai/accounts/${slow}/signin`, (s) => s.state === "failed", TIMEOUT_MS + 10000);
  check("timeout: it fails with the plain sentence", expired?.state === "failed" && expired.error === "Sign-in timed out. Start again.", JSON.stringify(expired));
  const t2 = await kit.req("POST", `/api/ai/accounts/${slow}/signin`);
  check("timeout: starting again gives a new waiting sign-in", t2.body.state === "waiting" && isLink(t2.body), t2.text);

  // ---- the agent identity can walk to its accounts (only when this machine has the agent account) ----
  const agentUp = process.getuid?.() === 0 && spawnSync("id", ["kohlab-agent"]).status === 0;
  if (agentUp) {
    const works = mkdtempSync(join(tmpdir(), "kohlab-signin-agent-"));
    const probe = `const a = await import(${JSON.stringify(join(ROOT, "accounts.ts"))});
const acc = a.createLogin("claude", "Agent reach");
const fs = await import("node:fs");
console.log(JSON.stringify({ id: acc.id, dir: a.dirOf(acc.id), root: a.dirOf(acc.id).replace(/\\/[^/]+$/, ""), owner: fs.statSync(a.dirOf(acc.id)).uid, uid: acc.uid }));`;
    const r = spawnSync("bun", ["-e", probe], { cwd: ROOT, encoding: "utf8", env: { ...process.env, WORKS_DIR: works, KOHLAB_AGENT_USER: "kohlab-agent" } });
    let got = null;
    try {
      got = JSON.parse(r.stdout.trim().split("\n").pop());
    } catch {
      /* reported below */
    }
    check("agent: an account is created for the agent identity", !!got && got.owner === got.uid, (r.stdout + r.stderr).slice(-400));
    if (got) {
      const reach = spawnSync("su", ["-s", "/bin/sh", "kohlab-agent", "-c", `test -x '${got.root}' && ! ls '${got.root}' >/dev/null 2>&1 && test -x '${got.dir}'`], { encoding: "utf8" });
      check("agent: it can walk into the accounts root and its own account, but not list the root", reach.status === 0, (reach.stderr || "").slice(0, 300));
    }
    rmSync(works, { recursive: true, force: true });
  } else console.log("skip  agent reach: no kohlab-agent account (or not root) on this machine");
  // ---- with an agent identity, the AI's own login runs as it (the login new projects use), not as the server ----
  if (agentUp) {
    const agentUid = Number(spawnSync("id", ["-u", "kohlab-agent"], { encoding: "utf8" }).stdout.trim());
    const logDir = mkdtempSync(join(tmpdir(), "kohlab-signin-uid-"));
    chmodSync(logDir, 0o777); // the agent writes its uid here
    const whoLog = join(logDir, "uid.log");
    const agentKit = await startKit({ env: { KOHLAB_AGENT_USER: "kohlab-agent", KOHLAB_SIGNIN_TIMEOUT_MS: String(TIMEOUT_MS) } });
    try {
      spawnSync("setfacl", ["-m", "u:kohlab-agent:x", agentKit.tmp]); // the agent walks to the fake binaries, cannot list them
      agentKit.put("claude", FAKE_CLAUDE.replace('mkdir -p "$DIR"', `id -u >> '${whoLog}'\nmkdir -p "$DIR"`));
      const ag = await agentKit.req("POST", "/api/ai/providers/claude/signin");
      check("main sign-in as the agent: a link", ag.body.state === "waiting" && isLink(ag.body), ag.text);
      await waitFor(() => existsSync(whoLog) && readFileSync(whoLog, "utf8").trim().length > 0, 8000);
      const ids = existsSync(whoLog) ? readFileSync(whoLog, "utf8").trim().split("\n") : [];
      check("main sign-in runs as the agent uid (every claude it starts)", ids.length > 0 && ids.every((x) => Number(x) === agentUid), `want ${agentUid}, got ${ids.join(",")}`);
    } finally {
      await agentKit.stop();
      rmSync(logDir, { recursive: true, force: true });
    }
  }
} finally {
  await kit.stop();
  rmSync(home, { recursive: true, force: true });
}

finish("sign-in");
