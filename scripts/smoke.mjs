#!/usr/bin/env node
/**
 * Backend smoke test — proves the HTTP + WebSocket contract the frontend depends
 * on still works. Run against a live server:
 *
 *   PORT=7699 WORKS_DIR=/tmp/kohlab-smoke/.works bun run server.ts &
 *   node scripts/smoke.mjs 7699
 *
 * Exits non-zero on the first failed assertion. No test framework on purpose.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.argv[2] ?? 7699);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;
/**
 * This script CREATES, starts, commits, shares and DELETES a workspace, so
 * pointing it at a live server mutates real state. 7676 is the documented
 * production port — refuse it unless the operator says so explicitly.
 */
const PRODUCTION_PORTS = new Set([7676]);
if (PRODUCTION_PORTS.has(PORT) && !process.argv.includes("--force")) {
  console.error(
    `\nrefusing to run against port ${PORT} — that is the documented production port.\n` +
      `This suite creates and deletes a real workspace. Start a throwaway server:\n\n` +
      `  PORT=7699 WORKS_DIR=/tmp/kohlab-smoke/.works PTY_SOCKET=/tmp/kohlab-smoke.sock bun run server.ts\n` +
      `  node scripts/smoke.mjs 7699\n\n` +
      `Pass --force if you really mean to target this instance.\n`,
  );
  process.exit(1);
}
/** Optional access key. Run against a KOHLAB_KEY server to exercise auth:
 *    node scripts/smoke.mjs 7700 --key=secret */
const KEY = (process.argv.find((a) => a.startsWith("--key=")) ?? "").replace("--key=", "");
const withKey = (path) => (KEY ? `${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(KEY)}` : path);
const wsUrl = () => `${WS_BASE}/${KEY ? `?key=${encodeURIComponent(KEY)}` : ""}`;

let passed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name} ${detail}`);
  }
}

async function req(path, opts) {
  const res = await fetch(BASE + withKey(path), opts);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

const post = (path, payload) =>
  req(path, {
    method: "POST",
    headers: payload ? { "content-type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });

// A throwaway git repo so workspace creation has something real to clone from.
const repoDir = mkdtempSync(join(tmpdir(), "kohlab-smoke-repo-"));
execFileSync("git", ["init", "-q"], { cwd: repoDir });
execFileSync("git", ["config", "user.email", "smoke@kohlab.local"], { cwd: repoDir });
execFileSync("git", ["config", "user.name", "smoke"], { cwd: repoDir });
writeFileSync(join(repoDir, "README.md"), "# smoke\n");
execFileSync("git", ["add", "-A"], { cwd: repoDir });
execFileSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

let createdId = null;

try {
  console.log(`\nkohlab backend smoke -> ${BASE}\n`);

  console.log("static app");
  const root = await req("/");
  check("GET / returns 200", root.status === 200, `got ${root.status}`);
  const entry = typeof root.body === "string" ? (root.body.match(/src="([^"]+)"/) ?? [])[1] : null;
  check("index.html references a built asset", !!entry, `body: ${String(root.body).slice(0, 80)}`);
  if (entry) {
    const asset = await req(entry);
    check(`GET ${entry} serves JS`, asset.status === 200 && /javascript/.test(asset.headers.get("content-type") ?? ""));
  }

  // SPA history fallback: a deep link or refresh on a client route must render
  // the shell, while a genuinely missing asset must still 404.
  const HTML = { headers: { accept: "text/html" } };
  for (const route of ["/workspaces", "/settings", "/w/some-workspace-id"]) {
    const res = await req(route, HTML);
    check(
      `GET ${route} (document) serves the app shell`,
      res.status === 200 && typeof res.body === "string" && res.body.includes('id="root"'),
      `got ${res.status}`,
    );
  }
  const missingAsset = await req("/assets/does-not-exist.js");
  check("missing asset still 404s", missingAsset.status === 404, `got ${missingAsset.status}`);
  const missingApi = await req("/api/definitely-not-a-route", HTML);
  check("unknown /api route still 404s", missingApi.status === 404, `got ${missingApi.status}`);

  console.log("auth + read endpoints");
  const authReq = await req("/api/auth/required");
  check("GET /api/auth/required -> {required}", authReq.status === 200 && typeof authReq.body.required === "boolean");
  const list = await req("/api/workspaces");
  check("GET /api/workspaces -> array", list.status === 200 && Array.isArray(list.body));
  const agents = await req("/api/agents-status");
  check("GET /api/agents-status -> record", agents.status === 200 && agents.body && typeof agents.body === "object");
  const gh = await req("/api/gh/repos");
  check("GET /api/gh/repos -> {ok,repos,authed}", gh.status === 200 && "ok" in gh.body && Array.isArray(gh.body.repos));

  console.log("workspace lifecycle");
  const bad = await req("/api/workspaces/does-not-exist/log");
  check("unknown workspace -> error status", bad.status >= 400, `got ${bad.status}`);

  const created = await post("/api/workspaces", { task: "smoke test task", repo: repoDir, agent: "sh" });
  check("POST /api/workspaces -> created", created.status === 200 && created.body?.id, `${created.status} ${JSON.stringify(created.body).slice(0, 120)}`);
  createdId = created.body?.id ?? null;
  check("created workspace has id + path", !!created.body?.id && !!created.body?.path);

  if (createdId) {
    const files = await req(`/api/workspaces/${createdId}/files`);
    check("GET .../files -> array", files.status === 200 && Array.isArray(files.body));
    const log = await req(`/api/workspaces/${createdId}/log`);
    check("GET .../log -> {log}", log.status === 200 && typeof log.body.log === "string");

    // Regression guard: /diff used to 404 on the normal (non-share) path because
    // the main action switch had no `case "diff"`.
    const cleanDiff = await req(`/api/workspaces/${createdId}/diff`);
    check(
      "GET .../diff (no share token) -> array",
      cleanDiff.status === 200 && Array.isArray(cleanDiff.body),
      `got ${cleanDiff.status} ${JSON.stringify(cleanDiff.body).slice(0, 80)}`,
    );

    // Introduce a real change so diff and commit have something to act on.
    // One modified tracked file AND one new file: `git diff` alone would only
    // report the first, letting the second be committed unreviewed.
    writeFileSync(join(created.body.path, "README.md"), "# smoke\nedited by smoke test\n");
    writeFileSync(join(created.body.path, "smoke-change.txt"), "new file from smoke test\n");

    const diff = await req(`/api/workspaces/${createdId}/diff`);
    const names = Array.isArray(diff.body) ? diff.body.map((f) => f.name) : [];
    check(
      "GET .../diff reports modified tracked file",
      diff.status === 200 && names.includes("README.md"),
      `got ${diff.status} ${JSON.stringify(names)}`,
    );
    check(
      "GET .../diff reports NEW untracked file",
      diff.status === 200 && names.includes("smoke-change.txt"),
      `got ${diff.status} ${JSON.stringify(names)}`,
    );
    const newFileEntry = Array.isArray(diff.body) ? diff.body.find((f) => f.name === "smoke-change.txt") : null;
    check(
      "new file diff is a valid unified diff",
      !!newFileEntry && /^\+\+\+ b\/smoke-change\.txt$/m.test(newFileEntry.diff),
      `diff was: ${JSON.stringify(newFileEntry?.diff ?? "").slice(0, 120)}`,
    );

    const share = await post(`/api/workspaces/${createdId}/share`);
    check("POST .../share -> {share}", share.status === 200 && !!share.body?.share);

    const commit = await post(`/api/workspaces/${createdId}/commit`, { message: "smoke commit" });
    check("POST .../commit -> ok", commit.status === 200 && commit.body?.ok === true, JSON.stringify(commit.body).slice(0, 120));

    const afterCommit = await req(`/api/workspaces/${createdId}/diff`);
    check("GET .../diff empty after commit", afterCommit.status === 200 && Array.isArray(afterCommit.body) && afterCommit.body.length === 0);

    // Committing an already-clean workspace must succeed. It used to run
    // `git commit` on an empty index, which exits 1 and surfaced as a raw
    // "git commit -m … exited 1" — and since commit is the ONLY way a stopped
    // workspace leaves the review queue, a workspace with no changes could
    // never be cleared.
    const cleanCommit = await post(`/api/workspaces/${createdId}/commit`, { message: "accept clean tree" });
    check(
      "POST .../commit on a clean tree succeeds",
      cleanCommit.status === 200 && cleanCommit.body?.ok === true,
      `got ${cleanCommit.status} ${JSON.stringify(cleanCommit.body).slice(0, 100)}`,
    );

    const attachOnce = () =>
      new Promise((resolve) => {
        const ws = new WebSocket(wsUrl());
        let closeCode = null;
        let failed = null;
        ws.addEventListener("close", (ev) => {
          closeCode = ev.code;
        });
        ws.addEventListener("error", () => {
          failed = "socket error";
        });
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ type: "attach", id: createdId, terminalId: "main" }));
        });
        setTimeout(async () => {
          // Must be the keyed URL, or a keyed server answers 401 for the probe
          // itself and the check cannot tell "denied" from "process died".
          const status = await fetch(BASE + withKey("/api/workspaces"))
            .then((r) => r.status)
            .catch(() => 0);
          // Capture state BEFORE closing: close() moves readyState to CLOSING.
          const open = ws.readyState === 1;
          try {
            ws.close();
          } catch {
            /* already gone */
          }
          resolve({ open, closeCode, failed, status });
        }, 2500);
      });

    // Only a workspace that is *meant* to be running is spawned on attach (see
    // ensurePtySession), so start it first — this is what makes the attach below
    // exercise the spawn path, whose missing import used to kill the server on
    // the very first terminal open.
    const startBeforeAttach = await post(`/api/workspaces/${createdId}/start`);
    check("POST .../start -> ok", startBeforeAttach.status === 200);
    await new Promise((r) => setTimeout(r, 900));

    // Terminal attach. ensurePtySession() records a browser-attach as a real
    // run; the call existed without its import for several releases, so the
    // first terminal open threw ReferenceError and killed the whole server.
    const first = await attachOnce();
    check("terminal attach keeps the socket open", first.open === true, `closeCode=${first.closeCode} ${first.failed ?? ""}`);
    check("server survives a terminal attach", first.status === 200, `api returned ${first.status} — the process died`);

    // Re-attach. The session already exists by now, which the daemon reports as
    // an error; treating that as fatal killed the server on every browser
    // reload or second tab. A single attach can never surface this, so the
    // suite must attach twice.
    const second = await attachOnce();
    check("terminal re-attach keeps the socket open", second.open === true, `closeCode=${second.closeCode} ${second.failed ?? ""}`);
    check("server survives a terminal re-attach", second.status === 200, `api returned ${second.status} — the process died`);

    const stop = await post(`/api/workspaces/${createdId}/stop`);
    check("POST .../stop -> ok", stop.status === 200);

    // Opening a finished workspace must not relaunch its agent. It used to: the
    // attach spawned a fresh run, and when that run ended the workspace went
    // straight back into the review queue — so accepting it never stuck.
    const stoppedAttach = await attachOnce();
    const rowsAfterStop = await req("/api/workspaces");
    const rowAfterStop = Array.isArray(rowsAfterStop.body) ? rowsAfterStop.body.find((w) => w.id === createdId) : null;
    check(
      "attaching to a stopped workspace does not restart it",
      stoppedAttach.status === 200 && rowAfterStop?.running === false,
      `api=${stoppedAttach.status} running=${rowAfterStop?.running}`,
    );
  }

  console.log("websocket push channel");
  const openSocket = (url) =>
    new Promise((resolve) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        resolve({ ok: false, why: "no open/close within 5s" });
      }, 5000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        ws.close();
        resolve({ ok: true });
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        resolve({ ok: false, why: "errored" });
      });
    });

  const wsCheck = await openSocket(wsUrl());
  check("WS / accepts an authenticated push subscriber", wsCheck.ok, wsCheck.why ?? "");

  // The sockets connect to `/`, not `/api`. When an access key is configured the
  // upgrade path must authenticate them — for several releases it did not, so
  // the terminal and the done-ping were dead in the documented deployment while
  // the key-less test suite stayed green.
  if (KEY) {
    const unkeyed = await openSocket(`${WS_BASE}/`);
    check("WS / rejects an unauthenticated subscriber", unkeyed.ok === false, "upgrade succeeded without a key");

    const bare = await fetch(`${BASE}/api/workspaces`).then((r) => r.status).catch(() => 0);
    check("unkeyed API request is rejected", bare === 401, `got ${bare}`);
    const keyed = await req("/api/workspaces");
    check("keyed API request is accepted", keyed.status === 200, `got ${keyed.status}`);
  }

  console.log("audit");
  const audit = await req("/api/audit");
  check("GET /api/audit -> {events}", audit.status === 200 && Array.isArray(audit.body.events));
} catch (err) {
  failures.push(`threw: ${err.message}`);
  console.log(`  FAIL unexpected error: ${err.stack}`);
} finally {
  if (createdId) {
    try {
      await post(`/api/workspaces/${createdId}/delete`);
      const after = await req("/api/workspaces");
      check("DELETE cleans up workspace", !after.body.some((w) => w.id === createdId));
    } catch (err) {
      failures.push(`cleanup failed: ${err.message}`);
    }
  }
  rmSync(repoDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("failed:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("backend contract intact\n");
}
