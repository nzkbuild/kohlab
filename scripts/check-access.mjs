#!/usr/bin/env node
/**
 * Access bootstrap — the two rules that decide who can reach a kohlab at all.
 *
 * Run:  node scripts/check-access.mjs
 *
 *   1. A server bound beyond loopback, with no key and no users, must generate
 *      itself one. Without it an anonymous caller is the owner — the first person
 *      to find the port owns the box — and leaving that to a firewall the
 *      operator may not know they need is not a safety net.
 *   2. That convenience is kept on loopback, where the only caller is already on
 *      the machine.
 *
 * `kohlab key` is the way back in when the key is lost, so it is checked too: it
 * must find a key that was generated at startup, and rotate it.
 *
 * Each server runs on its own port with its own state directory and socket, so
 * this never touches a running deployment.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const tmp = mkdtempSync(join(tmpdir(), "kohlab-access-"));

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
    return;
  }
  failures.push(name);
  console.log(`  FAIL ${name} ${detail}`);
}

/**
 * A port nothing is listening on. With a fixed port, a server left behind by an
 * earlier run answers in place of the one this check starts, and the check tests
 * the wrong process — which is exactly how a stale server once reported success
 * for a deletion it never performed.
 */
async function freePort() {
  const srv = createServer();
  const { promise, resolve } = Promise.withResolvers();
  srv.listen(0, "127.0.0.1", () => resolve(srv.address().port));
  const port = await promise;
  const closed = Promise.withResolvers();
  srv.close(closed.resolve);
  await closed.promise;
  return port;
}

/** Start the server and wait for it to answer, or give up. */
async function startServer({ port, works, host, extraEnv = {} }) {
  const dir = join(tmp, works);
  mkdirSync(dir, { recursive: true });
  const child = spawn("bun", ["run", "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: host, WORKS_DIR: join(dir, "state"), PTY_SOCKET: join(dir, "pty.sock"), KOHLAB_KEY: "", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 60; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/api/auth/required`).then((r) => r.ok).catch(() => false);
    if (up) {
      // A port answering is not proof that *this* server is answering: a stale
      // process from an earlier run can hold the port. Our own startup line is.
      for (let j = 0; j < 20 && !/works server on /.test(log); j++) await new Promise((r) => setTimeout(r, 50));
      if (!/works server on /.test(log)) throw new Error(`${host}:${port} answered, but not from the server this check started:\n${log}`);
      return { child, dir, port, log: () => log };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill("SIGKILL");
  throw new Error(`server on ${host}:${port} never came up\n${log}`);
}
function stopServer(s) {
  try {
    s.child.kill("SIGKILL");
  } catch {
    /* gone */
  }
  // the daemon is detached on purpose, so it needs finding by its own socket
  const socket = join(s.dir, "pty.sock");
  const ours = () =>
    readdirOfProc().filter((pid) => {
      try {
        return (
          readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("pty-daemon.cjs") &&
          readFileSync(`/proc/${pid}/environ`, "utf8").includes(`PTY_SOCKET=${socket}`)
        );
      } catch {
        return false;
      }
    });
  // The server's watcher polls for finished agents, so a daemon can be spawned
  // again between our kill and its exit. Three passes is enough for that to stop.
  for (let attempt = 0; attempt < 3; attempt++) {
    const pids = ours();
    if (!pids.length) return;
    for (const pid of pids) process.kill(Number(pid), "SIGTERM");
    spawnSync("sleep", ["0.4"]);
  }
}

function readdirOfProc() {
  return spawnSync("ls", ["/proc"], { encoding: "utf8" }).stdout.split("\n").filter((p) => /^\d+$/.test(p));
}

/** The CLI, reading the same state directory as the server under test. */
function cli(stateDir, args) {
  const r = spawnSync("bun", ["run", join(ROOT, "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, WORKS_DIR: stateDir, KOHLAB_UNIT: "kohlab-not-here", KOHLAB_KEY: "" },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

try {
  console.log("\nkohlab — access bootstrap\n");

  // ── bound beyond loopback, keyless: it must generate a key ────────────────
  const exposed = await startServer({ port: await freePort(), works: "exposed", host: "0.0.0.0" });
  try {
    const stateDir = join(exposed.dir, "state");
    const keyPath = join(stateDir, "key");
    check("a key was generated and stored", existsSync(keyPath), keyPath);
    if (existsSync(keyPath)) {
      const key = readFileSync(keyPath, "utf8").trim();
      check("the key looks like a key", /^[0-9a-f]{48}$/.test(key), key.slice(0, 12));
      check("it is not world-readable", (statSync(keyPath).mode & 0o077) === 0, (statSync(keyPath).mode & 0o777).toString(8));
      const anon = await fetch(`http://127.0.0.1:${exposed.port}/api/workspaces`);
      check("anonymous callers are refused", anon.status === 401, `got ${anon.status}`);
      const withKey = await fetch(`http://127.0.0.1:${exposed.port}/api/workspaces?key=${key}`);
      check("the generated key works", withKey.status === 200, `got ${withKey.status}`);
    }
    check("it says so in the log", /generated one/.test(exposed.log()), exposed.log().slice(-200));

    const found = cli(stateDir, ["key"]);
    check("kohlab key finds the stored key", found.out.includes("kohlab — generated by install.sh") === false && /^[0-9a-f]{48}$/m.test(found.out), found.out.slice(0, 120));

    const before = readFileSync(keyPath, "utf8").trim();
    const rotated = cli(stateDir, ["key", "rotate"]);
    const next = /^[0-9a-f]{48}$/m.exec(rotated.out)?.[0];
    check("kohlab key rotate issues a new one", !!next && next !== before, `before ${before.slice(0, 8)}…, printed ${String(next).slice(0, 8)}…`);
    check("the new key is what gets stored", readFileSync(keyPath, "utf8").trim() === next, "stored value differs from the printed one");
    check("rotate explains how to apply it", /systemctl restart/.test(rotated.out), rotated.out.slice(0, 200));
  } finally {
    stopServer(exposed);
  }

  // ── bound to loopback: the convenience stays ──────────────────────────────
  const local = await startServer({ port: await freePort(), works: "local", host: "127.0.0.1" });
  try {
    check("no key is generated on loopback", !existsSync(join(local.dir, "state", "key")));
    const anon = await fetch(`http://127.0.0.1:${local.port}/api/workspaces`);
    check("a loopback-only server stays open, as documented", anon.status === 200, `got ${anon.status}`);
    check("and says which it is", /no key — loopback only/.test(local.log()), local.log().slice(-200));
  } finally {
    stopServer(local);
  }

  // ── a configured key still wins ───────────────────────────────────────────
  const keyed = await startServer({ port: await freePort(), works: "keyed", host: "0.0.0.0", extraEnv: { KOHLAB_KEY: "a-configured-key" } });
  try {
    check("a configured key is not overridden by a generated one", !existsSync(join(keyed.dir, "state", "key")));
    const anon = await fetch(`http://127.0.0.1:${keyed.port}/api/workspaces`);
    check("the configured key is enforced", anon.status === 401, `got ${anon.status}`);
  } finally {
    stopServer(keyed);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("failed:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("access bootstrap intact\n");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
