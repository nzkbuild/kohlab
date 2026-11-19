#!/usr/bin/env bun
/**
 * Shared browser, pure rules: which dev command a project gets, which port a dev
 * server announces, and which URLs the browser may open.
 *
 * Run:  bun scripts/check-browser-unit.mjs
 */
import { detectDevCommand, parseDevUrl } from "../devserver.ts";
import { browserToolPolicy, isStaleLocalUrl, normalizeBrowserUrl, tcpAlive } from "../browser.ts";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

check("dev script wins", detectDevCommand({ scripts: { dev: "vite", start: "node s.js" } }), ["npm", "run", "dev"]);
check("start script when no dev", detectDevCommand({ scripts: { start: "node s.js" } }), ["npm", "start"]);
check("no script is no command", detectDevCommand({ scripts: { build: "tsc" } }), null);
check("no package.json is no command", detectDevCommand(null), null);
check("own Kohlab checkout runs no dev command", detectDevCommand({ name: "kohlab", scripts: { dev: "bun run --watch server.ts" } }), null);
check("other project's dev script runs", detectDevCommand({ name: "my-app", scripts: { dev: "vite" } }), ["npm", "run", "dev"]);

const vite = "\x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m";
check("vite colour codes stripped", parseDevUrl(vite), 5173);
check("next plain line", parseDevUrl("  - Local: http://localhost:3000"), 3000);
check("loopback ip", parseDevUrl("ready on http://127.0.0.1:8080"), 8080);
check("junk is null", parseDevUrl("compiling... 42%"), null);
check("remote host is not ours", parseDevUrl("open http://example.com:80/"), null);

check("bare host gets https", normalizeBrowserUrl("example.com"), "https://example.com/");
check("https kept", normalizeBrowserUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
check("http kept", normalizeBrowserUrl("http://127.0.0.1:5173/"), "http://127.0.0.1:5173/");
check("host with port gets https", normalizeBrowserUrl("localhost:3000"), "https://localhost:3000/");
check("empty refused", normalizeBrowserUrl("  "), null);
for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "data:text/html,hi", "mailto:a@b.c", "https:example.com", "ftp://example.com/"]) {
  check(`refuses ${bad}`, normalizeBrowserUrl(bad), null);
}

// Claude's browser tools: read-only ones always, interaction ones only on the workspace's own pages
const CLICK = "mcp__browser__agent_browser_click";
const SNAP = "mcp__browser__agent_browser_snapshot";
const OWN = { previewPrefix: "http://127.0.0.1:7676/p/tok/", devOrigin: "http://127.0.0.1:5173" };
const NONE = { previewPrefix: null, devOrigin: null };
check("read-only on a website: allow", browserToolPolicy(SNAP, "https://example.com/", OWN), "allow");
check("read-only with no page: allow", browserToolPolicy(SNAP, null, OWN), "allow");
check("read-only on another localhost port: allow", browserToolPolicy(SNAP, "http://127.0.0.1:3000/", OWN), "allow");
check("navigate on a website: allow", browserToolPolicy("mcp__browser__agent_browser_open", "https://example.com/", OWN), "allow");
check("click on a website: ask", browserToolPolicy(CLICK, "https://example.com/", OWN), "ask");
check("click on own preview: allow", browserToolPolicy(CLICK, "http://127.0.0.1:7676/p/tok/", OWN), "allow");
check("click on a page of own preview: allow", browserToolPolicy(CLICK, "http://127.0.0.1:7676/p/tok/about.html", OWN), "allow");
check("click on another /p/ token: ask", browserToolPolicy(CLICK, "http://127.0.0.1:7676/p/other/", OWN), "ask");
check("click on a token that starts the same: ask", browserToolPolicy(CLICK, "http://127.0.0.1:7676/p/tok2/", OWN), "ask");
check("click on Kohlab root, not a preview: ask", browserToolPolicy(CLICK, "http://127.0.0.1:7676/", OWN), "ask");
check("own preview on another origin: ask", browserToolPolicy(CLICK, "https://127.0.0.1:7676/p/tok/", OWN), "ask");
check("click on the dev server: allow", browserToolPolicy(CLICK, "http://127.0.0.1:5173/", OWN), "allow");
check("click on localhost dev server: allow", browserToolPolicy(CLICK, "http://localhost:5173/", OWN), "allow");
check("click on another localhost port: ask", browserToolPolicy(CLICK, "http://127.0.0.1:3000/", OWN), "ask");
check("click on a dev port when no dev server: ask", browserToolPolicy(CLICK, "http://127.0.0.1:5173/", NONE), "ask");
check("click on ipv6 loopback: ask", browserToolPolicy(CLICK, "http://[::1]:5173/", OWN), "ask");
check("click with no page: ask", browserToolPolicy(CLICK, null, OWN), "ask");
check("click on a file page: ask", browserToolPolicy(CLICK, "file:///etc/passwd", OWN), "ask");
check("a host that only starts with localhost: ask", browserToolPolicy(CLICK, "https://localhost.example.com/", OWN), "ask");
check("unknown browser tool on a website: ask", browserToolPolicy("mcp__browser__agent_browser_frobnicate", "https://example.com/", OWN), "ask");
check("unknown browser tool on own page: ask", browserToolPolicy("mcp__browser__agent_browser_frobnicate", "http://127.0.0.1:5173/", OWN), "ask");
const P = "http://127.0.0.1:7676/p/tok/";
for (const [name, u] of [
  ["userinfo host swap", "http://127.0.0.1:7676@evil.com/p/tok/"],
  ["userinfo password host swap", "http://127.0.0.1:7676:x@evil.com/p/tok/"],
  ["dot-dot out of token", "http://127.0.0.1:7676/p/tok/../other/"],
  ["encoded dot-dot out of token", "http://127.0.0.1:7676/p/tok/%2e%2e/other/"],
  ["token prefix extension", "http://127.0.0.1:7676/p/tokx/"],
  ["token without slash", "http://127.0.0.1:7676/p/tok"],
  ["uppercase path", "http://127.0.0.1:7676/P/tok/"],
  ["encoded token", "http://127.0.0.1:7676/p/%74ok/x"],
  ["encoded angle token", "http://127.0.0.1:7676/p/%3Ctok%3E/"],
  ["trailing-dot localhost dev", "http://localhost.:5173/"],
  ["nip.io dev", "http://127.0.0.1.nip.io:5173/"],
  ["ipv6 mapped", "http://[::ffff:127.0.0.1]:5173/"],
  ["https dev port", "https://127.0.0.1:5173/"],
  ["omitted port vs 5173", "http://127.0.0.1/"],
  ["other port preview", "http://127.0.0.1:7677/p/tok/"],
  ["localhost preview host", "http://localhost:7676/p/tok/"],
  ["double slash", "http://127.0.0.1:7676//p/tok/"],
]) check(`click: ${name}: ask`, browserToolPolicy(CLICK, u, OWN), "ask");
check("click on own preview with query and fragment: allow", browserToolPolicy(CLICK, P + "a.html?x=1#y", OWN), "allow");
check("click on own dev server with userinfo-free query: allow", browserToolPolicy(CLICK, "http://127.0.0.1:5173/a?b#c", OWN), "allow");
check("dev port 80 written without port: allow", browserToolPolicy(CLICK, "http://127.0.0.1/", { previewPrefix: null, devOrigin: "http://127.0.0.1:80" }), "allow");
check("dev port 80, https: ask", browserToolPolicy(CLICK, "https://127.0.0.1/", { previewPrefix: null, devOrigin: "http://127.0.0.1:80" }), "ask");
check("no preview token, 'undefined' path: ask", browserToolPolicy(CLICK, "http://127.0.0.1:7676/p/undefined/", NONE), "ask");
check("garbage own pages do not allow or throw", browserToolPolicy(CLICK, P, { previewPrefix: "not a url", devOrigin: null }), "ask");
check("a non-browser tool is not handled", browserToolPolicy("Bash", "https://example.com/", OWN), null);

// A page left on a dead local port is stale; a live one, our own, or a non-loopback one is not
const STALE_OWN = { ownOrigin: "http://127.0.0.1:7676", devOrigin: "http://127.0.0.1:5173", previewPrefix: "http://127.0.0.1:7676/p/tok/" };
const DEAD = "http://127.0.0.1:40489/";
check("stale dead loopback port: stale", isStaleLocalUrl(DEAD, STALE_OWN, false), true);
check("same URL but alive: not stale", isStaleLocalUrl(DEAD, STALE_OWN, true), false);
check("own server origin: not stale", isStaleLocalUrl("http://127.0.0.1:7676/", STALE_OWN, false), false);
check("own server origin, other path: not stale", isStaleLocalUrl("http://127.0.0.1:7676/w/x", STALE_OWN, false), false);
check("dev server origin: not stale", isStaleLocalUrl("http://127.0.0.1:5173/", STALE_OWN, false), false);
check("dev server on localhost: not stale", isStaleLocalUrl("http://localhost:5173/", STALE_OWN, false), false);
check("preview prefix: not stale", isStaleLocalUrl("http://127.0.0.1:7676/p/tok/x.html", STALE_OWN, false), false);
check("example.com dead: not stale", isStaleLocalUrl("https://example.com/", STALE_OWN, false), false);
check("10.0.0.5 dead: not stale", isStaleLocalUrl("http://10.0.0.5:40489/", STALE_OWN, false), false);
check("192.168 dead: not stale", isStaleLocalUrl("http://192.168.1.20:40489/", STALE_OWN, false), false);
check("https localhost dead: stale", isStaleLocalUrl("https://localhost:40489/", STALE_OWN, false), true);
check("ipv6 loopback dead: stale", isStaleLocalUrl("http://[::1]:40489/", STALE_OWN, false), true);
check("0.0.0.0 dead: stale", isStaleLocalUrl("http://0.0.0.0:40489/", STALE_OWN, false), true);
check("default port dead: stale", isStaleLocalUrl("http://localhost/", STALE_OWN, false), true);
check("garbage: not stale", isStaleLocalUrl("not a url", STALE_OWN, false), false);
check("null: not stale", isStaleLocalUrl(null, STALE_OWN, false), false);
check("about:blank: not stale", isStaleLocalUrl("about:blank", STALE_OWN, false), false);
check("chrome://: not stale", isStaleLocalUrl("chrome://settings/", STALE_OWN, false), false);
check("file: not stale", isStaleLocalUrl("file:///etc/passwd", STALE_OWN, false), false);
check("userinfo is not loopback: not stale", isStaleLocalUrl("http://127.0.0.1:1@evil.com:80/", STALE_OWN, false), false);
check("unset server base: loopback still stale", isStaleLocalUrl(DEAD, { ownOrigin: "", devOrigin: null, previewPrefix: null }, false), true);

// tcpAlive: a bare connect. Closed port: false. Listener: true, and it receives no bytes.
{
  const { createServer } = await import("node:net");
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const closedPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  check("tcpAlive: closed port is not alive", await tcpAlive("127.0.0.1", closedPort, 1500), false);

  let received = 0;
  let closedSeen;
  const closed = new Promise((r) => (closedSeen = r));
  const listener = createServer((s) => {
    s.on("data", (d) => (received += d.length));
    s.on("close", closedSeen);
    s.on("error", () => {});
  });
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  const livePort = listener.address().port;
  check("tcpAlive: listening port is alive", await tcpAlive("127.0.0.1", livePort, 1500), true);
  await Promise.race([closed, new Promise((r) => setTimeout(r, 1000))]);
  check("tcpAlive: sends no bytes", received, 0);
  await new Promise((r) => listener.close(r));

  // a blackholed address (TEST-NET-style, not routed here): must resolve false quickly, never throw
  const t0 = Date.now();
  const blackhole = await tcpAlive("10.255.255.1", 9, 300).catch(() => "threw");
  const took = Date.now() - t0;
  check("tcpAlive: blackhole resolves false", blackhole, false);
  check(`tcpAlive: blackhole resolves within 2 s (${took} ms)`, took < 2000, true);
  check("tcpAlive: invalid port resolves false, no throw", await tcpAlive("127.0.0.1", 70000, 300).catch(() => "threw"), false);
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall browser unit checks passed");
