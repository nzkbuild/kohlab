#!/usr/bin/env bun
// S1 (agent-browser 0.39.1, --json): console gives data.messages[{type,text}] (no URL, no time); errors gives data.errors[{text,line,column,url}], and `errors --clear` returns the list but keeps it.
// S1: network requests gives data.requests[{method,url,status}] with tracking on by default (a failed request has no status); `console --clear` and `network requests --clear` empty their lists, and no entry carries the page URL.
/**
 * Problems, pure rules and routes: a dev server that does not start is reported
 * with its output (capped), a browser is never started to look for problems, the
 * own-page rule matches the browser's, and the share link is refused on the route.
 *
 * Run: bun scripts/check-problems.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 7944;
const KEY = "problems-check-key";

const tmp = mkdtempSync(join(tmpdir(), "kohlab-problems-"));
const works = join(tmp, "works");
mkdirSync(works, { recursive: true });
process.env.WORKS_DIR = works;
process.env.PTY_SOCKET = join(tmp, "pty.sock");

const { devServerProblem, ensureDevServer, clearDevServerProblem } = await import("../devserver.ts");
const { browserProblems, browserToolPolicy, clearBrowserProblems } = await import("../browser.ts");

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`);
}

/** A workspace whose tree has a package.json with the given dev script and an (empty) node_modules, so the dev server is tried. */
function project(id, devScript) {
  const dir = join(tmp, `ws-${id}`);
  const tree = join(dir, "tree");
  mkdirSync(join(tree, "node_modules"), { recursive: true });
  writeFileSync(join(tree, "package.json"), JSON.stringify({ scripts: { dev: devScript } }));
  return { id, repo: "", task: id, agent: "sh", created: 0, started: null, stopped: null, dir };
}

try {
  // A dev script that fails at once, with its own message on stderr.
  const boom = project("pr-boom", "node -e \"console.error('boom');process.exit(1)\"");
  const url = await ensureDevServer(boom);
  const p = devServerProblem(boom);
  check("a dev server that exits is no URL", url === null);
  check("start failure is reported as a devserver problem", p?.kind === "devserver" && /didn't start \(exit code 1\)/.test(p.text), JSON.stringify(p));
  check("start failure keeps the command output", /boom/.test(p?.detail ?? ""), p?.detail);
  check("start failure text is one line, at most 300", (p?.text ?? "").length <= 300 && !/\n/.test(p?.text ?? ""));

  // Output is capped: a huge message cannot exceed the limits.
  const loud = project("pr-loud", "node -e \"process.stderr.write('x'.repeat(9000));process.exit(1)\"");
  await ensureDevServer(loud);
  const lp = devServerProblem(loud);
  check("detail is capped at 4000", (lp?.detail ?? "").length <= 4000, String((lp?.detail ?? "").length));
  check("text stays at most 300", (lp?.text ?? "").length <= 300);

  // With no browser running, problems never start one: only the dev server problem comes back.
  const list = await browserProblems(boom);
  check("no browser running: only the dev server problem", list.length === 1 && list[0].kind === "devserver", JSON.stringify(list));
  const none = await browserProblems(project("pr-none", "node -e \"process.exit(0)\""));
  check("no problems when nothing failed and no browser runs", none.length === 0, JSON.stringify(none));

  // Clearing drops the dev server problem.
  await clearBrowserProblems(boom);
  check("clear drops the dev server problem", devServerProblem(boom) === null);
  clearDevServerProblem(loud);

  // Own-page rule: the same policy the agent's browser tools use (browser.ts isOwnPage).
  const own = { previewPrefix: "http://127.0.0.1:9/p/tok/", devOrigin: "http://127.0.0.1:5173" };
  check("own preview page: interaction allowed", browserToolPolicy("mcp__browser__agent_browser_click", "http://127.0.0.1:9/p/tok/v/x/", own) === "allow");
  check("another site: not own", browserToolPolicy("mcp__browser__agent_browser_click", "https://example.com/", own) === "ask");

  // Routes: a share link is refused, and a request without the key is refused.
  const port = PORT;
  writeFileSync(
    join(works, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      agents: { sh: "sh" },
      workspaces: [{ ...project("share-ws", "node -e \"process.exit(0)\""), share: "sharetok-check" }],
    }),
  );
  const server = spawn("bun", ["run", "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), KOHLAB_KEY: KEY, WORKS_DIR: works, PTY_SOCKET: join(tmp, "pty.sock") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/api/auth/required`).then((r) => r.ok).catch(() => false);
    if (!up) await new Promise((r) => setTimeout(r, 150));
  }
  try {
    if (!up) throw new Error("throwaway server did not start");
    const base = `http://127.0.0.1:${port}/api/workspaces/share-ws`;
    const shared = await fetch(`${base}/problems?share=sharetok-check`);
    check("share link refused on problems (401 or 403)", shared.status === 403 || shared.status === 401, String(shared.status));
    const shareLink = await fetch(`${base}/link?share=sharetok-check`);
    check("share link refused on link settings (401 or 403)", shareLink.status === 403 || shareLink.status === 401, String(shareLink.status));
    const anon = await fetch(`${base}/problems`);
    check("no key refused (401)", anon.status === 401, String(anon.status));
    const keyed = await fetch(`${base}/problems`, { headers: { authorization: `Bearer ${KEY}` } });
    check("keyed owner reads problems (200)", keyed.status === 200, String(keyed.status));
    const body = await keyed.json().catch(() => ({}));
    check("problems answer has a list and a key", Array.isArray(body.problems) && typeof body.key === "string", JSON.stringify(body).slice(0, 200));
  } finally {
    server.kill("SIGKILL");
  }
} finally {
  // the PTY daemon the throwaway server may have started: match on our own socket only
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("pty-daemon.cjs")) continue;
      if (!readFileSync(`/proc/${pid}/environ`, "utf8").includes(`PTY_SOCKET=${join(tmp, "pty.sock")}`)) continue;
      process.kill(Number(pid), "SIGTERM");
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
console.log("\nall problem checks passed");
