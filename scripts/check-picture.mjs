// Chat pictures: a POST keeps a page and returns a capability URL; the URL serves
// the page under its own sandbox CSP. Runs against a throwaway server on its own
// port, socket and data dir, so it never touches a live instance or its daemon.
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PORT = 7796;
const dir = mkdtempSync(join(tmpdir(), "kohlab-pic-"));
const KEY = "picture-check-key-0123456789";
const SOCKET = join(tmpdir(), `kohlab-pic-${process.pid}.sock`);
const base = `http://127.0.0.1:${PORT}`;
const as = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
let failures = 0;

function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${got}, wanted ${want})`}`);
}

const server = spawn("bun", ["run", "server.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: dir, PTY_SOCKET: SOCKET },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (b) => (log += b));
server.stderr.on("data", (b) => (log += b));

/** End the daemon this check started on its own socket, if it is there. */
function killDaemonOn(path) {
  const pid = spawnSync("sh", ["-c", `ss -xlp 2>/dev/null | grep -F '${path}' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2`], { encoding: "utf8" }).stdout.trim();
  if (pid) spawnSync("kill", ["-9", pid], { encoding: "utf8" });
  rmSync(path, { force: true });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`${base}/api/auth/required`)).ok) break;
  } catch {
    await wait(250);
  }
}

const post = (html, headers = as) =>
  fetch(`${base}/api/workspaces/demo/picture`, { method: "POST", headers, body: JSON.stringify({ html }) });

try {
  check("POST without credentials -> 401", (await post("<p>x</p>", { "content-type": "application/json" })).status, 401);

  const page = "<!doctype html><p>chart</p><script>window.ok = 1</script>";
  const made = await post(page);
  check("POST with a key -> 200", made.status, 200);
  const { url } = await made.json();
  check("POST returns a /pic/ URL", /^\/pic\/[A-Za-z0-9_-]{20,}$/.test(url ?? ""), true);

  const again = await (await post(page)).json();
  check("the same page gets the same URL", again.url, url);

  const got = await fetch(`${base}${url}`);
  check("GET the URL needs no credentials -> 200", got.status, 200);
  check("GET returns the page itself", await got.text(), page);
  check("GET has the picture's sandbox CSP", got.headers.get("content-security-policy"),
    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'");
  check("GET is html, not cached, no referrer", `${got.headers.get("content-type")}|${got.headers.get("cache-control")}|${got.headers.get("referrer-policy")}`,
    "text/html; charset=utf-8|no-store|no-referrer");

  check("an unknown token -> 404", (await fetch(`${base}/pic/unknowntokenunknowntoken`)).status, 404);

  const big = await post("x".repeat(300 * 1024));
  check("a body over 256 KB -> 413", big.status, 413);
} finally {
  server.kill("SIGKILL");
  killDaemonOn(SOCKET);
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} failed. server log:\n${log.slice(-2000)}`);
  process.exit(1);
}
console.log("\nall picture checks passed");
