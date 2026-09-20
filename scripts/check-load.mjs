#!/usr/bin/env node
// Performance budgets.
//
// Nothing in this repository measured latency before this. Every claim that the
// dashboard stays responsive was an impression. These are budgets with numbers
// attached, measured against a throwaway server holding a non-trivial fleet, and
// they fail the suite when a change makes the API slower than the budget allows.
//
// The budgets are deliberately loose. This runs on whatever machine you are on,
// from a laptop to a shared CI box, so the point is catching a change that makes
// a list endpoint ten times slower - not microbenchmarking. Tighten per machine
// with PERF_P95_MS / PERF_WORKSPACES if you want them to bite.
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 7831;
const N = Number(process.env.PERF_WORKSPACES ?? 50);
const P95_BUDGET_MS = Number(process.env.PERF_P95_MS ?? 250);
const P50_BUDGET_MS = Number(process.env.PERF_P50_MS ?? 60);
const CONCURRENCY = Number(process.env.PERF_CONCURRENCY ?? 20);
const KEY = "load-check-key";

const dir = mkdtempSync(join(tmpdir(), "kohlab-load-"));
const SOCKET = join(tmpdir(), `kohlab-load-${process.pid}.sock`);
let failures = 0;

function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

// A fleet that looks like a working one: mixed ages, agents, some finished.
const now = Date.now();
const workspaces = Array.from({ length: N }, (_, i) => ({
  id: `ws-${i}`,
  repo: `/srv/repos/project-${i % 5}`,
  task: `task ${i}: a realistic description of the work`,
  agent: ["claude", "omp", "codex", "sh"][i % 4],
  created: now - i * 3_600_000,
  started: i % 3 === 0 ? now - i * 60_000 : null,
  stopped: i % 3 === 1 ? now - i * 30_000 : null,
  lastCommitAt: i % 3 === 1 ? now - i * 20_000 : undefined,
}));
writeFileSync(join(dir, "state.json"), JSON.stringify({ schemaVersion: 1, workspaces, agents: { sh: "sh" } }, null, 2));

const proc = spawn("bun", ["run", "server.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: dir, PTY_SOCKET: SOCKET },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (b) => (log += b));
proc.stderr.on("data", (b) => (log += b));

const base = `http://127.0.0.1:${PORT}`;
const auth = { authorization: `Bearer ${KEY}` };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The p-th percentile of a sample. */
function pct(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** The daemon bound to our socket, so we end ours and nobody else's. */
function killOurDaemon() {
  try {
    const pid = execSync(
      `ss -xlp 2>/dev/null | grep -F '${SOCKET}' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2`,
      { encoding: "utf8" },
    ).trim();
    if (pid) execSync(`kill -9 ${pid}`);
  } catch {
    /* nothing was listening */
  }
  rmSync(SOCKET, { force: true });
}

try {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {
      await wait(250);
    }
  }

  // Warm, then measure: the first request pays for the state file's first read.
  await (await fetch(`${base}/api/workspaces`, { headers: auth })).arrayBuffer();
  await (await fetch(`${base}/api/workspaces`, { headers: auth })).arrayBuffer();

  const sequential = [];
  let errors = 0;
  const ROUNDS = 100;
  for (let i = 0; i < ROUNDS; i++) {
    const t = performance.now();
    const res = await fetch(`${base}/api/workspaces`, { headers: auth });
    sequential.push(performance.now() - t);
    if (res.status !== 200) errors++;
    await res.arrayBuffer();
  }
  const p50 = pct(sequential, 50);
  const p95 = pct(sequential, 95);
  const p99 = pct(sequential, 99);
  console.log(`\n  GET /api/workspaces with ${N} workspaces, sequential (${ROUNDS} rounds)`);
  console.log(`    p50 ${p50.toFixed(1)}ms   p95 ${p95.toFixed(1)}ms   p99 ${p99.toFixed(1)}ms   max ${Math.max(...sequential).toFixed(1)}ms`);

  check("no failed requests under sequential load", errors === 0, `${errors} errors`);
  check(`p50 within ${P50_BUDGET_MS}ms`, p50 < P50_BUDGET_MS, `p50 ${p50.toFixed(1)}ms`);
  check(`p95 within ${P95_BUDGET_MS}ms`, p95 < P95_BUDGET_MS, `p95 ${p95.toFixed(1)}ms`);

  // Concurrent mixed load. The state file is read-modify-write behind a mutex, so
  // this is where a lock that serialises everything shows up.
  const concurrent = [];
  let concurrentErrors = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async (_, i) => {
      const path = i % 3 === 0 ? "/api/workspaces" : i % 3 === 1 ? "/api/health" : "/api/audit";
      const t = performance.now();
      const res = await fetch(`${base}${path}`, { headers: auth });
      concurrent.push(performance.now() - t);
      if (res.status >= 500) concurrentErrors++;
      await res.arrayBuffer();
    }),
  );
  const burst = performance.now() - t0;
  console.log(`  ${CONCURRENCY} concurrent mixed requests: ${burst.toFixed(1)}ms total, p95 ${pct(concurrent, 95).toFixed(1)}ms`);
  check("no 5xx under concurrent load", concurrentErrors === 0, `${concurrentErrors} errors`);

  const auditBytes = statSync(join(dir, "audit.log")).size;
  console.log(`  audit.log after ${ROUNDS + CONCURRENCY + 4} requests: ${auditBytes} bytes`);
  check("reads do not write to the audit trail", auditBytes < 4096, `${auditBytes} bytes`);
} finally {
  proc.kill("SIGKILL");
  killOurDaemon();
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} failed. server log:\n${log.slice(-1500)}`);
  process.exit(1);
}
console.log("\nall performance budgets met");
