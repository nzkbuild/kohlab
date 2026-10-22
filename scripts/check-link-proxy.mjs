#!/usr/bin/env bun
// S3 (Vite 8, sandboxed page): module scripts from the sandbox (opaque origin) do not load without `access-control-allow-origin: *`; with it they run. Without a ws relay HMR does not reload-loop: Vite reloads only after a successful ping, so the page just stops updating live.
// S3: today's static preview sends the same sandbox CSP and no ACAO, so `<script type="module" src>` already fails there; the share proxy adds the header and the static share does not.
/**
 * Share links: expiry, the internal token never shared, both tokens dead after
 * "turn off", the app's own port only (a dev server announcing another port is not
 * proxied), credentials never sent to the app, no cookies back, the sandbox policy
 * on every answer, and the body and answer caps.
 *
 * Run: bun scripts/check-link-proxy.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 7957;
const DECOY_PORT = 7959; // a server Kohlab never gave the dev server: a request to it means the proxy went where it should not
const KEY = "link-check-key";
const DAY = 86_400_000;

const tmp = mkdtempSync(join(tmpdir(), "kohlab-link-"));
const works = join(tmp, "works");
mkdirSync(works, { recursive: true });
process.env.WORKS_DIR = works;
process.env.PTY_SOCKET = join(tmp, "pty.sock");
process.env.KOHLAB_KEY = KEY;

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`);
}

/** A project in its own folder. `dev` is its dev script; `vite` decides whether the stub is run as the app. */
function project(id, dev, shareLink) {
  const dir = join(tmp, `ws-${id}`);
  const tree = join(dir, "tree");
  mkdirSync(join(tree, "node_modules"), { recursive: true });
  writeFileSync(join(tree, "index.html"), "<p>static home</p>");
  if (dev) writeFileSync(join(tree, "package.json"), JSON.stringify({ scripts: { dev } }));
  return {
    id,
    repo: "",
    task: id,
    agent: "sh",
    created: 0,
    started: null,
    stopped: null,
    dir,
    previewToken: `ptok-${id}`,
    ...(shareLink ? { shareLink } : {}),
  };
}

// The app: a stub Vite. It listens on the port Kohlab gave it (--port), echoes what it got, sets a cookie, and answers a redirect and a big body.
const STUB = `const http = require("node:http");
const i = process.argv.indexOf("--port");
const port = i >= 0 ? Number(process.argv[i + 1]) : Number(process.env.PORT);
http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.endsWith("/big")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      let sent = 0;
      const chunk = Buffer.alloc(1024 * 1024, 120);
      const pump = () => { while (sent < 21 * 1024 * 1024) { sent += chunk.length; if (!res.write(chunk)) return res.once("drain", pump); } res.end(); };
      return pump();
    }
    if (u.pathname.endsWith("/go")) {
      res.writeHead(302, { location: "http://127.0.0.1:" + port + "/p/" + u.pathname.split("/")[2] + "/echo", "set-cookie": "sid=1; Path=/" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "sid=1; Path=/", "content-security-policy": "default-src *" });
    res.end(JSON.stringify({ method: req.method, path: u.pathname, headers: req.headers, length: Buffer.concat(chunks).length }));
  });
}).listen(port, "127.0.0.1", () => console.log("Local: http://127.0.0.1:" + port + "/"));
`;
// The decoy: a dev server that announces a port Kohlab did not give it.
const DECOY_SCRIPT = `console.log("Local: http://127.0.0.1:${DECOY_PORT}/"); setInterval(() => {}, 1000);`;

const future = Date.now() + DAY;
const past = Date.now() - 1000;
const workspaces = [
  project("app-ws", "node vite-stub.js vite", { token: "sharetok-app", expires: null }),
  project("static-ws", null, { token: "sharetok-static", expires: future }),
  project("expired-ws", null, { token: "sharetok-expired", expires: past }),
  project("decoy-ws", "node decoy.js vite", { token: "sharetok-decoy", expires: null }),
];
for (const w of workspaces) {
  const tree = join(w.dir, "tree");
  if (w.id === "app-ws") writeFileSync(join(tree, "vite-stub.js"), STUB);
  if (w.id === "decoy-ws") writeFileSync(join(tree, "decoy.js"), DECOY_SCRIPT);
}
writeFileSync(join(works, "state.json"), JSON.stringify({ schemaVersion: 1, agents: { sh: "sh" }, workspaces }));

// The decoy port: a stub that records any request. It must never get one.
let decoyHits = 0;
const decoy = createServer((req, res) => {
  decoyHits++;
  res.end("decoy");
}).listen(DECOY_PORT, "127.0.0.1");

const srvs = [];
try {
  // In-process: expiry arithmetic and which token matches.
  const lib = await import("../lib.ts");
  const now = Date.now();
  check("expiry: one day", lib.shareExpiry("1d", now) === now + DAY);
  check("expiry: seven days", lib.shareExpiry("7d", now) === now + 7 * DAY);
  check("expiry: never", lib.shareExpiry("never", now) === null);
  check("expiry: anything else is refused", lib.shareExpiry("1y", now) === undefined);
  check("an expired share token matches nothing", (await lib.workspaceByPreview("sharetok-expired")) === null);
  const live = await lib.workspaceByPreview("sharetok-app");
  check("a live share token matches, as a share", live?.share === true && live.ws.id === "app-ws");
  const internal = await lib.workspaceByPreview("ptok-app-ws");
  check("the owner's token matches, not as a share", internal?.share === false);

  // Server: the routes and the proxy.
  const env = { ...process.env, PORT: String(PORT), KOHLAB_KEY: KEY, WORKS_DIR: works, PTY_SOCKET: join(tmp, "pty.sock") };
  const srv = spawn("bun", ["run", "server.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  srvs.push(srv);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${PORT}/api/auth/required`).then((r) => r.ok).catch(() => false);
    if (!up) await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) throw new Error("throwaway server did not start");
  const base = `http://127.0.0.1:${PORT}`;
  const auth = { authorization: `Bearer ${KEY}` };

  // Static share: the files, with the sandbox policy.
  const st = await fetch(`${base}/p/sharetok-static/`);
  check("static share serves its files", st.status === 200 && (await st.text()).includes("static home"));
  check("static share has the sandbox policy", (st.headers.get("content-security-policy") ?? "").startsWith("sandbox"));

  check("static share lets sandboxed module scripts load (access-control-allow-origin *)", st.headers.get("access-control-allow-origin") === "*");
  check("static share refuses POST", (await fetch(`${base}/p/sharetok-static/`, { method: "POST", body: "x" })).status === 405);

  // Expired share: 404, and the owner's own token is not affected.
  check("expired share is 404", (await fetch(`${base}/p/sharetok-expired/`)).status === 404);

  // The app: the dev server starts under the link, and the proxy reaches only its port.
  const echoUrl = `${base}/p/sharetok-app/echo?x=1`;
  const echo = await fetch(echoUrl, { method: "POST", headers: { cookie: "kohlab=secret", ...auth, "content-type": "text/plain", "x-kohlab-thing": "nope", accept: "application/json" }, body: "hello" });
  const got = await echo.json().catch(() => null);
  check("the app answers through the link", echo.status === 200 && got?.method === "POST" && got?.length === 5, `${echo.status} ${JSON.stringify(got)?.slice(0, 120)}`);
  check("no cookie reaches the app", got && got.headers.cookie === undefined);
  check("no authorization reaches the app", got && got.headers.authorization === undefined);
  check("no kohlab header reaches the app", got && got.headers["x-kohlab-thing"] === undefined);
  check("the app's cookie is not passed back", echo.headers.get("set-cookie") === null);
  check("the app's own policy is replaced by the sandbox policy", (echo.headers.get("content-security-policy") ?? "").startsWith("sandbox"));
  check("module scripts may load (CORS for the opaque origin)", echo.headers.get("access-control-allow-origin") === "*");

  const go = await fetch(`${base}/p/sharetok-app/go`, { redirect: "manual" });
  check("a redirect to the app stays on the link", go.status === 302 && (go.headers.get("location") ?? "").startsWith("/p/sharetok-app/"), go.headers.get("location") ?? "");

  const big = await fetch(`${base}/p/sharetok-app/big`).then((r) => r.arrayBuffer()).catch(() => null);
  check("an answer over 20 MB is cut off", big === null || big.byteLength <= 20 * 1024 * 1024, String(big?.byteLength));

  const huge = await fetch(`${base}/p/sharetok-app/upload`, { method: "POST", body: Buffer.alloc(1024 * 1024 + 1) });
  check("a body over 1 MB is refused (413)", huge.status === 413, String(huge.status));

  const dotted = await fetch(`${base}/p/sharetok-app/%2e%2e/echo`);
  check("a path that climbs out is refused (404)", dotted.status === 404, String(dotted.status));

  // The decoy: the dev server announces another port, so there is no proxy and nothing is sent to it.
  const decoyRes = await fetch(`${base}/p/sharetok-decoy/anything`);
  check("a dev server on another port is never proxied (503)", decoyRes.status === 503, String(decoyRes.status));
  check("the decoy port was never hit", decoyHits === 0, String(decoyHits));

  // The owner's token never shows the share token, and the share is turned off: both old tokens die.
  const linkGet = await fetch(`${base}/api/workspaces/app-ws/link`, { headers: auth });
  const linkBody = await linkGet.json();
  check("link info shows the relative address and kind", linkBody.url === "/p/sharetok-app/" && linkBody.kind === "app", JSON.stringify(linkBody));
  const off = await fetch(`${base}/api/workspaces/app-ws/link`, { method: "DELETE", headers: auth });
  const offBody = await off.json().catch(() => ({}));
  check("turning off gives a new owner address", off.status === 200 && offBody.previewUrl !== "/p/ptok-app-ws/" && /^\/p\/[^/]+\/$/.test(offBody.previewUrl), JSON.stringify(offBody));
  check("after off: the share token is 404", (await fetch(`${base}/p/sharetok-app/`)).status === 404);
  check("after off: the old owner token is 404", (await fetch(`${base}/p/ptok-app-ws/`)).status === 404);
  check("after off: the new owner token works", (await fetch(`${base}${offBody.previewUrl}`)).status !== 404);
  const again = await fetch(`${base}/api/workspaces/app-ws/link`, { headers: auth });
  check("after off: no link", (await again.json()).url === null);
} finally {
  for (const s of srvs) s.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  decoy.close();
  // dev servers and the PTY daemon this run started: match on our own folder and socket only
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const cwd = realpathSync(`/proc/${pid}/cwd`);
      const daemon = cmd.includes("pty-daemon.cjs") && readFileSync(`/proc/${pid}/environ`, "utf8").includes(`PTY_SOCKET=${join(tmp, "pty.sock")}`);
      if (daemon || cwd.startsWith(realpathSync(tmp))) process.kill(Number(pid), "SIGTERM");
    } catch {
      /* gone */
    }
  }
  rmSync(tmp, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall link proxy checks passed");
