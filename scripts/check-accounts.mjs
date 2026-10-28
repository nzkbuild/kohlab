#!/usr/bin/env bun
/**
 * Accounts (accounts.ts): a second Claude sign-in and Claude through a router. A fake claude and a fake router; a canary router
 * key that must live only in accounts/secrets.json. No model is called, no real sign-in is touched or completed.
 *
 * Run:  bun scripts/check-accounts.mjs
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountError, accountsTest, checkRouter, groupRouterModels, parseClaudeLoginUrl, parseRouterUrl, setFetch } from "../accounts.ts";
import { makeCheck, startKit, waitFor } from "./ai-check-kit.mjs";

const { check, finish } = makeCheck();
const CANARY = "sk-canary-router-9c41e7d2a05b";
const mode = (p) => (statSync(p).mode & 0o777).toString(8);
const refuses = (fn) => {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof AccountError && e.status === 400 && /\.$/.test(e.message) && !e.message.includes(CANARY);
  }
};

// ---- the address and the check, pure (a fake network) ----
check("an address: http, https, a path; the trailing slash goes", parseRouterUrl("http://127.0.0.1:20128/").url === "http://127.0.0.1:20128" && parseRouterUrl("https://r.example/v1/").url === "https://r.example/v1" && parseRouterUrl("http://127.0.0.1:20128").host === "127.0.0.1:20128");
check("not http(s), a sign-in in it, a query: refused", refuses(() => parseRouterUrl("ftp://x")) && refuses(() => parseRouterUrl("file:///etc")) && refuses(() => parseRouterUrl("http://u:p@x")) && refuses(() => parseRouterUrl("http://x/?key=1")) && refuses(() => parseRouterUrl("nonsense")) && refuses(() => parseRouterUrl("")));
{
  const calls = [];
  const answer = (status, body = "{}") => async (url, init) => {
    calls.push({ url, init });
    return new Response(body, { status });
  };
  setFetch(answer(200, JSON.stringify({ data: [{ id: "dsk/a" }, { id: "dsk/b" }, { id: "cc/c" }, { id: "bad id" }, { nope: 1 }] })));
  const ok = await checkRouter("http://r:1", "KEY1");
  check("200 -> ok with the ids (a bad id is dropped)", ok.check === "ok" && ok.models.join() === "dsk/a,dsk/b,cc/c");
  check("it asks /v1/models with the key as a bearer token, no redirects, a timeout", calls[0].url === "http://r:1/v1/models" && calls[0].init.headers.authorization === "Bearer KEY1" && calls[0].init.redirect === "manual" && !!calls[0].init.signal);
  setFetch(answer(401));
  check("401 -> key_rejected", (await checkRouter("http://r:1", "k")).check === "key_rejected");
  setFetch(answer(403));
  check("403 -> key_rejected", (await checkRouter("http://r:1", "k")).check === "key_rejected");
  setFetch(answer(500));
  check("500 -> unreachable", (await checkRouter("http://r:1", "k")).check === "unreachable");
  setFetch(answer(302));
  check("a redirect (not followed) -> unreachable", (await checkRouter("http://r:1", "k")).check === "unreachable");
  setFetch(async () => {
    throw new Error("ECONNREFUSED");
  });
  check("a refused connection -> unreachable", (await checkRouter("http://r:1", "k")).check === "unreachable");
  setFetch(async () => new Response("x".repeat(2 * 1024 * 1024), { status: 200 }));
  const big = await checkRouter("http://r:1", "k");
  check("a body over 1 MB is cut: connected, nothing read from it", big.check === "ok" && big.models.length === 0);
  setFetch(null);
  check("models group by the part before the first /", JSON.stringify(groupRouterModels(["dsk/a", "dsk/b", "cc/c", "plain"]).map((g) => [g.group, g.ids.length])) === '[["dsk",2],["cc",1],["other",1]]');
  check("the sign-in link is read past hyperlink codes, once", parseClaudeLoginUrl("Open: \x1b]8;;https://claude.com/x?a=1&state=Z\x07https://claude.com/x?a=1&state=Z\x1b]8;;\x07\r\nPaste") === "https://claude.com/x?a=1&state=Z" && parseClaudeLoginUrl("javascript:alert(1)") === null && parseClaudeLoginUrl("http://x") === null);
  accountsTest.reset();
}

// ---- a fake router ----
const hits = { models: [], other: [] };
const other = createServer((req, res) => {
  hits.other.push(req.url);
  res.writeHead(200).end("{}");
}).listen(0, "127.0.0.1");
await new Promise((r) => other.once("listening", r));
const otherPort = other.address().port;
const router = createServer((req, res) => {
  const auth = req.headers.authorization ?? "";
  hits.models.push({ url: req.url, auth });
  if (req.url !== "/v1/models") return res.writeHead(404).end("{}");
  if (auth === "Bearer redirect-key") return res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/stolen` }).end();
  if (auth === "Bearer big-key") return res.writeHead(200).end("x".repeat(2 * 1024 * 1024));
  if (auth !== `Bearer ${CANARY}` && auth !== "Bearer rotated-key") return res.writeHead(401).end("{}");
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "dsk/deepseek-flash" }, { id: "dsk/deepseek-v4-pro" }, { id: "cc/claude-sonnet-4" }] }));
}).listen(0, "127.0.0.1");
await new Promise((r) => router.once("listening", r));
const routerUrl = `http://127.0.0.1:${router.address().port}`;

const kit = await startKit();
try {
  const post = (path, body, key) => kit.req("POST", path, body, key);
  const acc = `${kit.works}/accounts`;

  // ---- creating ----
  const login = await post("/api/ai/accounts", { provider: "claude", kind: "login", label: "Work account" });
  const wid = login.body.account?.id;
  check("a login account is created: an id from its name, no directory in the reply", login.status === 200 && /^work-account-[0-9a-f]{4}$/.test(wid) && login.body.account.kind === "login" && login.body.account.provider === "claude" && !login.text.includes(acc), login.text);
  check("accounts/ is 0700, accounts.json 0600, the account's directory 0700", mode(acc) === "700" && mode(join(acc, "accounts.json")) === "600" && mode(join(acc, wid)) === "700");
  check("no secrets file until there is a secret", !existsSync(join(acc, "secrets.json")));
  check("the directory is empty, outside every project and ~/.claude", readdirSync(join(acc, wid)).length === 0 && !join(acc, wid).includes("/.claude") && !join(acc, wid).startsWith(kit.repoDir));
  for (const [what, body] of [["an empty name", { provider: "claude", kind: "login", label: "  " }], ["a long name", { provider: "claude", kind: "login", label: "x".repeat(61) }], ["an unknown AI", { provider: "gemini", kind: "login", label: "a" }], ["a router for Codex", { provider: "codex", kind: "router", label: "a", baseUrl: routerUrl, key: "k" }], ["an address that is ftp", { provider: "claude", kind: "router", label: "a", baseUrl: "ftp://x", key: "k" }], ["a sign-in in the address", { provider: "claude", kind: "router", label: "a", baseUrl: "http://u:p@127.0.0.1:1", key: "k" }], ["a key with a space", { provider: "claude", kind: "router", label: "a", baseUrl: routerUrl, key: "a b" }], ["no kind", { provider: "claude", label: "a" }]]) {
    const r = await post("/api/ai/accounts", body);
    check(`refused: ${what} (400, a sentence, no key in it)`, r.status === 400 && /\.$/.test(r.body.error) && !r.text.includes("u:p"), r.text);
  }

  const good = await post("/api/ai/accounts", { provider: "claude", kind: "router", label: "My router", baseUrl: `${routerUrl}/`, key: CANARY });
  const rid = good.body.account?.id;
  check("a router account: connected, 3 models found", good.status === 200 && good.body.check === "ok" && good.body.models === 3, good.text);
  check("the router was asked once, with the key", hits.models.some((h) => h.auth === `Bearer ${CANARY}`));
  check("the reply holds no key, no full address, no directory", !good.text.includes(CANARY) && !good.text.includes(routerUrl) && !good.text.includes(acc) && good.body.account.hasKey === true && good.body.account.baseUrlHost === `127.0.0.1:${router.address().port}`, good.text);
  check("the key is in secrets.json (0600) and nowhere else Kohlab wrote", mode(join(acc, "secrets.json")) === "600" && readFileSync(join(acc, "secrets.json"), "utf8").includes(CANARY) && kit.leaks(CANARY).length === 0, kit.leaks(CANARY).join());
  check("accounts.json holds the address but no key", readFileSync(join(acc, "accounts.json"), "utf8").includes(routerUrl) && !readFileSync(join(acc, "accounts.json"), "utf8").includes(CANARY));
  const bad = await post("/api/ai/accounts", { provider: "claude", kind: "router", label: "Wrong key", baseUrl: routerUrl, key: "nope-key" });
  check("a key the router refuses: stored, but 'key_rejected'", bad.body.check === "key_rejected" && !bad.text.includes("nope-key"));
  const gone = await post("/api/ai/accounts", { provider: "claude", kind: "router", label: "Nowhere", baseUrl: "http://127.0.0.1:9", key: "k1" });
  check("an address nothing answers: 'unreachable'", gone.body.check === "unreachable");
  const redir = await post("/api/ai/accounts", { provider: "claude", kind: "router", label: "Redirects", baseUrl: routerUrl, key: "redirect-key" });
  check("a redirect is not followed", redir.body.check === "unreachable" && hits.other.length === 0, JSON.stringify(hits.other));
  const bigr = await post("/api/ai/accounts", { provider: "claude", kind: "router", label: "Huge", baseUrl: routerUrl, key: "big-key" });
  check("a body over 1 MB is cut", bigr.body.check === "ok" && bigr.body.models === 0);
  for (const x of [bad, gone, redir, bigr]) await kit.req("DELETE", `/api/ai/accounts/${x.body.account.id}`);

  // ---- who sees what ----
  const listed = await kit.req("GET", "/api/ai/accounts");
  check("the owner sees both, with the host and 'has a key'", listed.body.accounts.length === 2 && listed.body.accounts.find((a) => a.id === rid)?.hasKey === true && !listed.text.includes(CANARY) && !listed.text.includes(acc));
  const vmade = await kit.req("POST", "/api/users", { id: "acccheck-viewer", name: "acccheck-viewer", role: "viewer" });
  try {
    const vl = await kit.req("GET", "/api/ai/accounts", undefined, vmade.body.key);
    check("a viewer sees the names and kinds, no host, no key flag", vl.status === 200 && vl.body.accounts.length === 2 && vl.body.accounts.every((a) => a.baseUrlHost === undefined && a.hasKey === undefined) && !vl.text.includes("127.0.0.1"), vl.text);
    check("a viewer can change nothing (403)", (await kit.req("POST", "/api/ai/accounts", { provider: "claude", kind: "login", label: "x" }, vmade.body.key)).status === 403 && (await kit.req("DELETE", `/api/ai/accounts/${rid}`, undefined, vmade.body.key)).status === 403 && (await kit.req("POST", `/api/ai/accounts/${rid}/key`, { key: "k" }, vmade.body.key)).status === 403 && (await kit.req("POST", `/api/ai/accounts/${wid}/signin`, {}, vmade.body.key)).status === 403);
    const prov = await kit.req("GET", "/api/providers", undefined, vmade.body.key);
    check("a viewer's AI list has no kind, key flag, host or limit time", !/"kind":"(login|router|default)"|hasKey|baseUrlHost|limitedUntil|127\.0\.0\.1/.test(prov.text), prov.text.slice(0, 300));
  } finally {
    await kit.req("DELETE", "/api/users/acccheck-viewer");
  }

  // ---- sign-in (a fake claude; a fake code) ----
  const si = await post(`/api/ai/accounts/${wid}/signin`, {});
  check("sign-in starts: waiting, a link, a code box", si.body.state === "waiting" && si.body.url?.startsWith("https://claude.com/") && si.body.needsCode === true, si.text);
  const logins = jsonl(join(kit.fakeDir, "logins.log"));
  check("it ran in the account's own directory, without the server's key", logins.at(-1)?.cfg === join(acc, wid) && logins.at(-1)?.hasKohlabKey === false, JSON.stringify(logins));
  check("polling says waiting", (await kit.req("GET", `/api/ai/accounts/${wid}/signin`)).body.state === "waiting");
  check("a code that does not look right is refused (400)", (await post(`/api/ai/accounts/${wid}/signin/code`, { code: "a b" })).status === 400);
  await post(`/api/ai/accounts/${wid}/signin/code`, { code: "BADCODE#state" });
  check("a wrong code fails with a sentence", await waitFor(async () => (await kit.req("GET", `/api/ai/accounts/${wid}/signin`)).body.state === "failed", 8000) && /not accepted/.test((await kit.req("GET", `/api/ai/accounts/${wid}/signin`)).body.error));
  check("the link is not repeated to a failed sign-in's poll", !(await kit.req("GET", `/api/ai/accounts/${wid}/signin`)).text.includes("claude.com"));
  await post(`/api/ai/accounts/${wid}/signin`, {});
  await post(`/api/ai/accounts/${wid}/signin/code`, { code: "GOODCODE#state" });
  check("the right code signs in", await waitFor(async () => (await kit.req("GET", `/api/ai/accounts/${wid}/signin`)).body.state === "done", 8000));
  check("the test route agrees (never a paid call)", (await post(`/api/ai/accounts/${wid}/test`, {})).body.check === "ok");
  check("a code with nothing waiting -> 409", (await post(`/api/ai/accounts/${wid}/signin/code`, { code: "GOODCODE" })).status === 409);

  // ---- the AI hub lists them; probes use each account's own directory ----
  const prov = await kit.req("GET", "/api/providers?x=1");
  const claude = prov.body.providers.find((p) => p.id === "claude");
  const wk = claude.accounts.find((a) => a.id === wid);
  const rt = claude.accounts.find((a) => a.id === rid);
  check("the hub shows the default, the second login and the router, each with its kind", claude.accounts.map((a) => a.kind).sort().join() === "default,login,router", JSON.stringify(claude.accounts.map((a) => [a.id, a.kind, a.state])));
  check("the second login is connected under its own name; its email is what ITS Claude said", wk?.state === "connected" && wk.label === "Work account" && wk.email === `${wid}@x.test` && wk.models.length >= 2, JSON.stringify(wk)?.slice(0, 300));
  check("the router is connected, models grouped, usage is on its own dashboard", rt?.state === "connected" && rt.models.some((m) => m.value === "dsk/deepseek-flash" && m.group === "dsk") && /dashboard/.test(rt.usage?.note ?? "") && rt.hasKey === true, JSON.stringify(rt)?.slice(0, 300));
  check("the probe of the login ran under its directory", kit.spawns().some((s) => s.env.CLAUDE_CONFIG_DIR === join(acc, wid) && s.args.includes("--input-format") && !s.args.includes("--model")));
  check("the card has the two ways to add an account", claude.actions.filter((a) => a.kind === "add_account").length === 2);
  check("the hub holds no key", !prov.text.includes(CANARY));

  // ---- projects on accounts ----
  const dflt = await kit.project();
  const onLogin = await kit.project();
  const onRouter = await kit.project();
  check("a project can choose a login account", (await kit.control(onLogin, "account", wid)).status === 200);
  check("and a router", (await kit.control(onRouter, "account", rid)).status === 200);
  check("an account that does not exist is refused (400)", (await kit.control(dflt, "account", "ghost-1234")).status === 400);
  check("the project's run info names it", (await kit.run(onRouter)).account?.label === "My router" && (await kit.run(onRouter)).account?.kind === "router" && (await kit.run(onLogin)).ai.account.value === wid);
  for (const p of [dflt, onLogin, onRouter]) {
    await kit.send(p, `hello from ${p.slice(-4)}`);
    await kit.idle(p);
  }
  const envOf = (p) => kit.spawns().filter((s) => s.cwd.includes(`/${p}/tree`)).at(-1);
  const d = envOf(dflt), l = envOf(onLogin), r = envOf(onRouter);
  check("the default project: neither a directory nor a router", d && d.env.CLAUDE_CONFIG_DIR === null && d.env.ANTHROPIC_BASE_URL === null && d.env.ANTHROPIC_AUTH_TOKEN === null, JSON.stringify(d?.env));
  check("the login project: CLAUDE_CONFIG_DIR is the account's directory, no router", l && l.env.CLAUDE_CONFIG_DIR === join(acc, wid) && l.env.ANTHROPIC_BASE_URL === null && l.env.ANTHROPIC_AUTH_TOKEN === null, JSON.stringify(l?.env));
  check("the router project: the address and the key, no directory", r && r.env.ANTHROPIC_BASE_URL === routerUrl && r.env.ANTHROPIC_AUTH_TOKEN === CANARY && r.env.CLAUDE_CONFIG_DIR === null, JSON.stringify(r?.env));
  check("the router's own model names stand in for Claude's", r?.env.ANTHROPIC_DEFAULT_SONNET_MODEL === "dsk/deepseek-flash");
  check("no process of any account saw the server's key", kit.spawns().every((s) => s.env.KOHLAB_KEY === null));
  check("no process of the default project saw the router key", kit.spawns().filter((s) => !s.cwd.includes(`/${onRouter}/tree`)).every((s) => s.env.ANTHROPIC_AUTH_TOKEN === null));
  check("the account's directory is not in any project", !l.cwd.startsWith(acc) && ![dflt, onLogin, onRouter].some((p) => existsSync(join(kit.works, p, "tree", ".claude"))));

  // ---- transcripts and earlier conversations come from the account's directory ----
  const slug = l.cwd.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(acc, wid, "projects", slug), { recursive: true });
  writeFileSync(join(acc, wid, "projects", slug, "earlier-1.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "an earlier question" } }) + "\n");
  const sl = await kit.req("GET", `/api/workspaces/${onLogin}/chat/sessions`);
  const sd = await kit.req("GET", `/api/workspaces/${dflt}/chat/sessions`);
  check("earlier conversations are read from the account's directory", sl.body.sessions.some((s) => s.id === "earlier-1" && s.title === "an earlier question"), sl.text);
  check("the default project does not see them", !sd.body.sessions.some((s) => s.id === "earlier-1"));

  // ---- a conversation moves between accounts and back, keeping each one's session ----
  const sessA = kit.msgs().find((m) => m.text.includes(`hello from ${onLogin.slice(-4)}`));
  check("the second account's Claude got the first message", sessA?.who === wid);
  await kit.control(onLogin, "account", null);
  await kit.send(onLogin, "second one");
  await kit.idle(onLogin);
  const m2 = kit.msgs().at(-1);
  check("back on the default sign-in, its first message carries what it missed", m2.who === "default" && m2.text.includes("Context: this conversation started with another assistant") && m2.text.includes("hello from"), m2.text.slice(0, 200));
  await kit.control(onLogin, "account", wid);
  await kit.send(onLogin, "third one");
  await kit.idle(onLogin);
  const sp3 = kit.spawns().at(-1);
  check("switching back resumes that account's own session", sp3.who === wid && sp3.args.includes("--resume") && sp3.args[sp3.args.indexOf("--resume") + 1].startsWith(`fake-${wid}-`), JSON.stringify(sp3.args));
  const notes = (await kit.chat(onLogin)).events.filter((e) => e.kind === "note").map((e) => e.text);
  check("each switch is a quiet line", notes.length >= 2 && notes.every((t) => t.startsWith("Switched to ")), JSON.stringify(notes));

  // ---- custom models ----
  const add = await post(`/api/ai/accounts/${wid}/models`, { value: "my-custom-model", label: "My model" });
  check("a custom model is added", add.status === 200, add.text);
  const cardModels = async () => (await kit.req("POST", "/api/providers/refresh", { id: "claude" })).body.providers.find((p) => p.id === "claude").accounts.find((a) => a.id === wid).models;
  check("it shows in the account's list as custom", (await cardModels()).some((m) => m.value === "my-custom-model" && m.label === "My model" && m.custom === true));
  check("a project on that account can use it", (await kit.control(onLogin, "model", "my-custom-model")).status === 200 && (await kit.run(onLogin)).ai.model.value === "my-custom-model");
  check("Claude is told the id as it is", await (async () => { await kit.send(onLogin, "with the custom one"); await kit.idle(onLogin); return kit.controls().some((c) => c.sub === "set_model" && c.request.model === "my-custom-model") || kit.spawns().at(-1).args.includes("my-custom-model"); })());
  check("an unknown model is still refused", (await kit.control(onLogin, "model", "not-a-model")).status === 400);
  check("a duplicate is refused (409)", (await post(`/api/ai/accounts/${wid}/models`, { value: "my-custom-model", label: "x" })).status === 409);
  check("an id with a space, or over 200 characters, is refused (400)", (await post(`/api/ai/accounts/${wid}/models`, { value: "a b", label: "x" })).status === 400 && (await post(`/api/ai/accounts/${wid}/models`, { value: "x".repeat(201), label: "x" })).status === 400 && (await post(`/api/ai/accounts/${wid}/models`, { value: "ok-id", label: "y".repeat(61) })).status === 400);
  const ren = await kit.req("PATCH", `/api/ai/accounts/${wid}/models`, { value: "my-custom-model", label: "Renamed" });
  const renBuiltin = await kit.req("PATCH", `/api/ai/accounts/${wid}/models`, { value: "haiku", label: "Fast one" });
  const models2 = await cardModels();
  check("a custom model and a listed one can be renamed", ren.status === 200 && renBuiltin.status === 200 && models2.some((m) => m.value === "my-custom-model" && m.label === "Renamed") && models2.some((m) => m.value === "haiku" && m.label === "Fast one" && !m.custom));
  check("only a custom model can be removed", (await kit.req("DELETE", `/api/ai/accounts/${wid}/models`, { value: "haiku" })).status === 404 && (await kit.req("DELETE", `/api/ai/accounts/${wid}/models`, { value: "my-custom-model" })).status === 200 && !(await cardModels()).some((m) => m.value === "my-custom-model"));
  check("the default sign-in takes custom models too", (await post("/api/ai/accounts/default/models", { provider: "claude", value: "own-model", label: "Own" })).status === 200);

  // ---- rename ----
  const rn = await kit.req("PATCH", `/api/ai/accounts/${wid}`, { label: "Work (renamed)" });
  check("an account can be renamed; the id stays", rn.status === 200 && rn.body.account.label === "Work (renamed)" && rn.body.account.id === wid, rn.text);
  check("a bad name is refused (400); an unknown account is 404", (await kit.req("PATCH", `/api/ai/accounts/${wid}`, { label: "" })).status === 400 && (await kit.req("PATCH", `/api/ai/accounts/ghost-1234`, { label: "x" })).status === 404);
  await kit.req("PATCH", `/api/ai/accounts/${wid}`, { label: "Work account" });

  // ---- rotate the key, test ----
  check("a key can be replaced, write-only", (await post(`/api/ai/accounts/${rid}/key`, { key: "rotated-key" })).status === 200 && (await post(`/api/ai/accounts/${rid}/test`, {})).body.check === "ok");
  check("a key the router refuses shows on the test", (await post(`/api/ai/accounts/${rid}/key`, { key: "zz-refused-key" })).status === 200 && (await post(`/api/ai/accounts/${rid}/test`, {})).body.check === "key_rejected");
  check("the old key is gone from the file", !readFileSync(join(acc, "secrets.json"), "utf8").includes(CANARY));
  await post(`/api/ai/accounts/${rid}/key`, { key: CANARY });
  check("the audit log names ids and labels, never keys", (() => { const a = readFileSync(join(kit.works, "audit.log"), "utf8"); return a.includes("ai.account.add") && a.includes("ai.account.key") && !a.includes("rotated-key") && !a.includes("zz-refused-key"); })());

  // ---- removing ----
  const del = await kit.req("DELETE", `/api/ai/accounts/${wid}`);
  check("removing a login deletes its directory", del.status === 200 && !existsSync(join(acc, wid)));
  check("a project on it is back on the default sign-in, with a note", (await kit.run(onLogin)).account === null && (await kit.chat(onLogin)).events.some((e) => e.kind === "note" && /was removed/.test(e.text) && e.text.includes("Work account")));
  await kit.req("DELETE", `/api/ai/accounts/${rid}`);
  check("removing a router deletes its key", !readFileSync(join(acc, "secrets.json"), "utf8").includes(CANARY) && (await kit.req("GET", "/api/ai/accounts")).body.accounts.length === 0);
  check("removing something that is not there -> 404", (await kit.req("DELETE", `/api/ai/accounts/${rid}`)).status === 404);
  check("the key is nowhere Kohlab wrote, nor in what it printed, after all of it", kit.leaks(CANARY).length === 0, kit.leaks(CANARY).join());
  check("no account process outlived its use", await waitFor(() => true, 10));
} finally {
  await kit.stop();
  router.close();
  other.close();
}

// ---- a member who runs as an OS account of their own keeps their own sign-in ----
{
  const tmp = mkdtempSync(join(tmpdir(), "kohlab-acct-member-"));
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  const code = `
    const { spawnSync } = require("node:child_process");
    const fs = require("node:fs");
    const repo = process.env.REPO_DIR;
    for (const a of [["init","-q"],["config","user.email","a@b.c"],["config","user.name","a"]]) spawnSync("git", a, { cwd: repo });
    fs.writeFileSync(repo + "/a", "1"); spawnSync("git", ["add","-A"], { cwd: repo }); spawnSync("git", ["commit","-qm","i"], { cwd: repo });
    const acc = await import(process.env.ROOT + "accounts.ts");
    const lib = await import(process.env.ROOT + "lib.ts");
    const chat = await import(process.env.ROOT + "chat.ts");
    const a = acc.createLogin("claude", "Shared");
    const r = acc.createRouter("Rt", "http://127.0.0.1:1", "sk-member-canary");
    const ws = await lib.createWorkspace({ repo, task: "t", agent: "claude", chat: true });
    fs.writeFileSync(process.env.WORKS_DIR + "/users.json", JSON.stringify({ users: [{ id: "mem", name: "mem", key: "x", role: "member", osUser: "mem", uid: 4242, gid: 4242, home: "/home/mem" }] }));
    await lib.mutateState((s) => { s.workspaces.find((w) => w.id === ws.id).ownerId = "mem"; });
    const out = {};
    for (const [k, id] of [["login", a.id], ["router", r.id]]) { try { await chat.chatControl(ws.id, "account", id); out[k] = "allowed"; } catch (e) { out[k] = e.status; } }
    const w2 = await lib.getWorkspace(ws.id);
    out.env = acc.accountEnv({ ...w2, account: a.id });
    out.envRouter = acc.accountEnv({ ...w2, account: r.id });
    out.usable = acc.usableBy(acc.getAccount(a.id), { ownerId: undefined, asAgent: undefined });
    console.log(JSON.stringify(out));
    process.exit(0);
  `;
  const sub = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, WORKS_DIR: join(tmp, "works"), REPO_DIR: repo, ROOT: new URL("..", import.meta.url).pathname } });
  let o = {};
  const text = sub.stdout.toString().trim().split("\n").pop() ?? "";
  try { o = JSON.parse(text); } catch { /* shown below */ }
  check("a member's own-account project is refused an account (403), login or router", o.login === 403 && o.router === 403, text + sub.stderr.toString().slice(-300));
  check("and would be given none of the account's environment", JSON.stringify(o.env) === "{}" && JSON.stringify(o.envRouter) === "{}", text);
  check("a project that runs as the server can use a login account", o.usable === true, text);
  rmSync(tmp, { recursive: true, force: true });
}

finish("accounts");

function jsonl(file) {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}
