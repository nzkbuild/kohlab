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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
/** The throwaway viewer this run creates to prove the role gates. Deleted in the
 *  finally block; on a root box creating it also provisions an OS account, which
 *  the delete removes again. */
let roleTestUser = null;

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

  // The install route takes user text and runs a process. These attempt the
  // exploit with a harmless canary: if the fix ever regresses, the canary file
  // appears and this fails loudly — instead of the box quietly being rootable
  // by any member.
  console.log("agent install hardening");
  const canary = join(repoDir, "pwned");
  const inject = await post("/api/agents/install", { name: "x", cmd: `npm i -g left-pad; touch ${canary}` });
  check("shell injection is rejected", inject.status === 400, `got ${inject.status} ${JSON.stringify(inject.body)}`);
  check("the injected command did not run", !existsSync(canary), canary);
  const ssrf = await post("/api/agents/install", { name: "x", cmd: "curl -fsSL http://169.254.169.254/latest/meta-data/" });
  check("curl is not an install command (SSRF)", ssrf.status === 400, `got ${ssrf.status}`);
  const flag = await post("/api/agents/install", { name: "x", cmd: "npm i -g --prefix /etc left-pad" });
  check("flags are not smuggled through", flag.status === 400, `got ${flag.status}`);
  const extra = await post("/api/agents/install", { name: "x", cmd: "npm i -g left-pad extra-arg" });
  check("extra arguments are rejected", extra.status === 400, `got ${extra.status}`);
  // positive control: a catalogue-shaped command passes validation and only then
  // fails on npm's own terms (an unreachable package), never "not allowed"
  const allowed = await post("/api/agents/install", { name: "x", cmd: "npm i -g kohlab-no-such-package-xyz" });
  check(
    "a well-formed install still reaches npm",
    !JSON.stringify(allowed.body).includes("only global package installs"),
    JSON.stringify(allowed.body).slice(0, 120),
  );

  // The role model, tested as a *set* rather than route by route.
  //
  // This is how two holes survived: `POST /api/users` had no gate at all (a
  // viewer could mint an owner) and `POST /api/agents` had only `denied`. Each
  // route was individually plausible; only the comparison showed them. No
  // handler checks roles itself — the route table is the single place
  // authorization happens — so a missing gate has no second line of defence.
  //
  // Bodies are empty on purpose: if a gate ever goes missing, the handler answers
  // 400 and this fails, without performing the mutation it was asked to.
  console.log("role gates (every mutating route)");
  const MUTATING = [
    ["POST", "/api/users"],
    ["DELETE", "/api/users/definitely-not-a-user"],
    ["POST", "/api/agents"],
    ["POST", "/api/agents/install"],
    ["POST", "/api/clone"],
    ["POST", "/api/workspaces"],
    ["POST", "/api/workspaces/nope/start"],
    ["POST", "/api/workspaces/nope/stop"],
    ["POST", "/api/workspaces/nope/restart"],
    ["POST", "/api/workspaces/nope/delete"],
    ["POST", "/api/workspaces/nope/commit"],
    ["POST", "/api/workspaces/nope/share"],
  ];
  const PRIVILEGED_READS = [
    ["GET", "/api/users"],
    ["GET", "/api/audit"],
  ];

  const viewerId = `smoke-viewer-${Date.now()}`;
  const made = await post("/api/users", { id: viewerId, name: "Smoke Viewer", role: "viewer" });
  if (made.status === 200 && made.body?.key) {
    roleTestUser = viewerId;
    const vkey = made.body.key;
    const asViewer = (method, path) =>
      fetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(vkey)}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

    for (const [method, path] of MUTATING) {
      const r = await asViewer(method, path);
      check(`viewer is refused: ${method} ${path}`, r.status === 403, `got ${r.status} ${JSON.stringify(r.body)}`);
    }
    for (const [method, path] of PRIVILEGED_READS) {
      const r = await asViewer(method, path);
      check(`viewer is refused: ${method} ${path}`, r.status === 403, `got ${r.status}`);
    }
    const readOnly = await asViewer("GET", "/api/workspaces");
    check("viewer can still read workspaces", readOnly.status === 200, `got ${readOnly.status}`);

    // Not in the loop above: an ungated update would run the real updater.
    const update = await asViewer("POST", "/api/release/update");
    check("viewer is refused: POST /api/release/update", update.status === 403, `got ${update.status}`);

    // Nor this one: it is the injection canary, tested below with real payloads.
    const launcher = await asViewer("POST", "/api/agents");
    check("viewer is refused a real launcher payload", launcher.status === 403, `got ${launcher.status}`);

    if (KEY) {
      const anonPosts = await Promise.all(
        MUTATING.map(([method, path]) =>
          fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined })
            .then((r) => ({ path, status: r.status })),
        ),
      );
      // Refused is the property that matters. 401 is the correct status for "no
      // credentials at all", but ten routes answer 403 because they test the role
      // first — which also refuses. That inconsistency is recorded in ROADMAP.md
      // rather than churned here; what must never happen is a 2xx.
      const leaked = anonPosts.filter((r) => r.status !== 401 && r.status !== 403);
      check("no mutating route accepts an anonymous caller", leaked.length === 0, JSON.stringify(leaked));
    }
  } else {
    check("the suite can create a viewer to test with", false, `got ${made.status} ${JSON.stringify(made.body)}`);
  }

  console.log("release / OTA");
  const rel = await req("/api/release");
  check(
    "GET /api/release -> {current,latest,available,upstream}",
    rel.status === 200 &&
      typeof rel.body.current === "string" &&
      typeof rel.body.latest === "string" &&
      typeof rel.body.available === "boolean" &&
      "upstream" in rel.body,
  );
  check("release reports the running commit", typeof rel.body.head === "string" && rel.body.head.length > 0);
  check("release reports whether a run is in flight", typeof rel.body.running === "boolean" && "log" in rel.body);
  if (KEY) {
    // Only the refused paths are asserted here. POSTing with a key would really
    // start an update of the checkout this suite is running from.
    const anonRead = await fetch(`${BASE}/api/release`);
    check("GET /api/release without a key -> 401", anonRead.status === 401, `got ${anonRead.status}`);
    const anonUpdate = await fetch(`${BASE}/api/release/update`, { method: "POST" });
    check("POST /api/release/update without a key -> 401", anonUpdate.status === 401, `got ${anonUpdate.status}`);
    const wrongMethod = await req("/api/release/update");
    check("GET /api/release/update -> 404/405", wrongMethod.status === 404 || wrongMethod.status === 405, `got ${wrongMethod.status}`);
  }

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

    // Terminal attach. Two behaviours live here and a single attach cannot
    // distinguish them, so the suite checks all three cases below.
    //
    // This first attach happens while the workspace has never run, which is the
    // create → open → running path: creating a workspace does not spawn, and
    // both the onboarding copy and the README promise that opening it does. It
    // is also what exercises markStarted, whose missing import used to kill the
    // server on the very first terminal open.
    const first = await attachOnce();
    check("terminal attach keeps the socket open", first.open === true, `closeCode=${first.closeCode} ${first.failed ?? ""}`);
    check("server survives a terminal attach", first.status === 200, `api returned ${first.status} — the process died`);
    const afterFirstAttach = await req("/api/workspaces");
    const rowAfterFirst = Array.isArray(afterFirstAttach.body) ? afterFirstAttach.body.find((w) => w.id === createdId) : null;
    check(
      "attaching to a never-run workspace starts it",
      rowAfterFirst?.running === true,
      `running=${rowAfterFirst?.running} started=${rowAfterFirst?.started}`,
    );

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
  if (roleTestUser) {
    try {
      const gone = await fetch(`${BASE}/api/users/${encodeURIComponent(roleTestUser)}${KEY ? `?key=${encodeURIComponent(KEY)}` : ""}`, {
        method: "DELETE",
      });
      check("the throwaway viewer is removed", gone.status === 200, `got ${gone.status}`);
    } catch (err) {
      failures.push(`could not remove the test viewer ${roleTestUser}: ${err.message}`);
    }
  }
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
