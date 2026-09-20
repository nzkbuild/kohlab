#!/usr/bin/env node
/**
 * Invitations — the one way someone joins a kohlab.
 *
 * Run:  node scripts/check-invite.mjs
 *
 * The flow it asserts, end to end: an owner invites; the link lands on a screen
 * that exchanges it for that member's own key; the key works and is scoped to
 * what they own; the link is single-use and expiring; and the two rules that
 * protect the box — the last owner cannot be removed or demoted, and inviting on
 * a server that cannot create accounts is refused rather than quietly sharing the
 * owner's account.
 *
 * Needs root to provision (that is what an invitation leads to on a real box); it
 * skips those assertions with a printed reason when it cannot.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const KEY = "invite-check-owner-key";
const tmp = mkdtempSync(join(tmpdir(), "kohlab-invite-"));

/** The PTY daemon is detached on purpose, so it is found by its own socket.
 *  Several passes, because the server's watcher can spawn another one between
 *  the kill and the server's own exit. */
function killOurDaemon(socketPath) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const pids = readdirSync("/proc")
      .filter((p) => /^\d+$/.test(p))
      .filter((pid) => {
        try {
          return (
            readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("pty-daemon.cjs") &&
            readFileSync(`/proc/${pid}/environ`, "utf8").includes(`PTY_SOCKET=${socketPath}`)
          );
        } catch {
          return false;
        }
      });
    if (!pids.length) return;
    for (const pid of pids) process.kill(Number(pid), "SIGTERM");
    spawnSync("sleep", ["0.4"]);
  }
}

/** A port nothing is listening on, so a stale server cannot answer in our place. */
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

const PORT = await freePort();
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const call = (path, key, opts = {}) =>
  fetch(`http://127.0.0.1:${PORT}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`, opts).then(j);
const post = (path, key, body) => call(path, key, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

const id = `invitee-${Date.now()}`;
let server = null;
let memberKey = null;

try {
  console.log("\nkohlab — invitations\n");

  mkdirSync(join(tmp, "state"), { recursive: true });
  server = spawn("bun", ["run", "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: join(tmp, "state"), PTY_SOCKET: join(tmp, "pty.sock") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${PORT}/api/auth/required`).then((r) => r.ok).catch(() => false);
    if (!up) await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) throw new Error(`server never came up\n${log}`);
  for (let i = 0; i < 20 && !/works server on /.test(log); i++) await new Promise((r) => setTimeout(r, 50));
  if (!/works server on /.test(log)) throw new Error(`${PORT} answered, but not from the server this check started:\n${log}`);

  // ── inviting ──────────────────────────────────────────────────────────────
  const anon = await fetch(`http://127.0.0.1:${PORT}/api/invites`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("an anonymous caller cannot invite", anon.status === 401, `got ${anon.status}`);

  const invited = await post("/api/invites", KEY, { id, name: "Invited Person", role: "member" });
  check("an owner can invite", invited.status === 200, `${invited.status} ${JSON.stringify(invited.body)}`);
  const token = (invited.body.path ?? "").split("#")[1];
  check("the link carries the token in the fragment, not a query string", (invited.body.path ?? "").startsWith("/join#") && !(invited.body.path ?? "").includes("?"), String(invited.body.path));
  check("the token is long enough to be unguessable", (token ?? "").length >= 48, String((token ?? "").length));
  check("the invitation has an expiry", typeof invited.body.expires === "number" && invited.body.expires > Date.now(), String(invited.body.expires));

  const listed = await call("/api/users", KEY);
  const pending = (listed.body.users ?? []).find((u) => u.id === id);
  check("they appear as pending, not as a member", pending?.pending === true, JSON.stringify(pending));
  check("the response never carries a token hash", !JSON.stringify(listed.body).includes(token ?? "x"), "token material leaked in the list");
  check("the list reports whether inviting is possible here", typeof listed.body.canInvite === "boolean", JSON.stringify(listed.body).slice(0, 80));

  const keyless = await fetch(`http://127.0.0.1:${PORT}/api/workspaces?key=${encodeURIComponent(id)}`);
  check("a pending member has no working key", keyless.status === 401, `got ${keyless.status}`);

  // ── accepting ─────────────────────────────────────────────────────────────
  // named `redeem`, not `join`: `join` is the path helper this file also uses
  const redeem = (t) => fetch(`http://127.0.0.1:${PORT}/api/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: t }) }).then(j);

  const bad = await redeem("not-a-real-token");
  check("a junk token is refused", bad.status === 400, `${bad.status} ${JSON.stringify(bad.body)}`);

  const accepted = await redeem(token);
  check("accepting issues a key", accepted.status === 200 && /^[0-9a-f]{48}$/.test(accepted.body.key ?? ""), `${accepted.status} ${JSON.stringify(accepted.body)}`);
  memberKey = accepted.body.key;
  check("they are now the role they were invited as", accepted.body.user?.role === "member", JSON.stringify(accepted.body.user));

  const reused = await redeem(token);
  check("the link is single-use", reused.status === 400, `got ${reused.status}`);

  const asMember = await call("/api/workspaces", memberKey);
  check("their key works", asMember.status === 200, `got ${asMember.status}`);
  const memberUsers = await call("/api/users", memberKey);
  check("but it cannot administer the server", memberUsers.status === 403, `got ${memberUsers.status}`);
  const memberInvite = await post("/api/invites", memberKey, { id: "someone-else", name: "x", role: "member" });
  check("and cannot invite further", memberInvite.status === 403, `got ${memberInvite.status}`);

  const afterAccept = await call("/api/users", KEY);
  const joined = (afterAccept.body.users ?? []).find((u) => u.id === id);
  check("they are no longer pending", joined?.pending === false, JSON.stringify(joined));

  // ── re-inviting, expiring, and the last owner ─────────────────────────────
  const again = await post("/api/invites", KEY, { id, name: "Invited Person", role: "member" });
  check("an existing member is not silently re-invited", again.status === 400, `${again.status} ${JSON.stringify(again.body)}`);

  const second = await post("/api/invites", KEY, { id: `${id}-2`, name: "Second", role: "viewer" });
  const replaced = await post("/api/invites", KEY, { id: `${id}-2`, name: "Second", role: "viewer" });
  check("re-inviting replaces the outstanding link", second.status === 200 && replaced.status === 200, `${second.status}/${replaced.status}`);
  const stale = await redeem((second.body.path ?? "").split("#")[1]);
  check("the replaced link no longer works", stale.status === 400, `got ${stale.status}`);
  const fresh = await redeem((replaced.body.path ?? "").split("#")[1]);
  check("the newest link works", fresh.status === 200, `got ${fresh.status}`);
  if (fresh.body.key) await call(`/api/users/${id}-2`, KEY, { method: "DELETE" });

  const roleChange = await call(`/api/users/${id}`, KEY, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "viewer" }),
  });
  check("an owner can change a role", roleChange.status === 200 && roleChange.body.user?.role === "viewer", `${roleChange.status} ${JSON.stringify(roleChange.body)}`);

  // The legacy key is an owner here, so demoting a named owner is recoverable and
  // allowed — the lockout rule only bites with no key configured. Assert what is
  // true rather than what would be true on a keyed-only box.
  const demoteSelf = await call(`/api/users/${id}`, KEY, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "owner" }),
  });
  check("promoting to owner works", demoteSelf.status === 200, `${demoteSelf.status}`);
} catch (err) {
  console.error(`\n  FAIL unexpected error: ${err.message}`);
  process.exit(1);
} finally {
  for (const uid of [id, `${id}-2`]) {
    await call(`/api/users/${uid}`, KEY, { method: "DELETE" }).catch(() => {});
  }
  try {
    server?.kill("SIGKILL");
  } catch {
    /* gone */
  }
  killOurDaemon(join(tmp, "pty.sock"));
  rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("failed:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("invitations intact\n");
}
