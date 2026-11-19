#!/usr/bin/env node
// Lists what the test runs left on this machine. Read-only by default.
//
//   node scripts/leftovers.mjs                 list (changes nothing)
//   node scripts/leftovers.mjs --apply         list, then remove exactly what was listed, one at a time, printing each
//
// What it looks for:
//   - folders in WORKS_DIR named like a test run (kohlab-test-*, kohlab-pty-test-*, ...) that no workspace in
//     state.json references. Never a symlink (listed, never followed or removed), never a path outside WORKS_DIR.
//   - ACL entries on /root and /root/.kohlab for numeric or named users that no longer exist.
//   - OS accounts named kohlab-chk-*, koh-smoke-*, koh-viewer-* that users.json does not own. Other koh-* accounts
//     may be real members: they are listed, never removed here.
//   - stray pty-daemon.cjs processes whose PTY_SOCKET is not the live socket.
//
// Refuses to remove folders when state.json cannot be read: without it nothing can be proven unreferenced.
// --dirs-only (folders and stray daemons only) and --sockets-under <dir> (daemons whose socket is under <dir>)
// are for the check that exercises --apply in a throwaway WORKS_DIR. Do not use them on the real machine.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DIRS_ONLY = args.includes("--dirs-only");
const SOCKETS_UNDER = args.includes("--sockets-under") ? resolve(args[args.indexOf("--sockets-under") + 1] ?? "") : null;

/** The folder name prefixes the test runs use. */
const TEST_FOLDERS = [
  "kohlab-pty-test-",
  "kohlab-cutover-test-",
  "kohlab-dump-",
  "kohlab-completion-test-",
  "kohlab-e2e-",
  "kohlab-final-e2e",
  "kohlab-finish-test",
  "kohlab-notif-test",
  "kohlab-stop-",
  "kohlab-stopped-check",
  "kohlab-test-",
  "kohlab-treekill-",
  "kohlab-keep-improving-kohlab",
  "kohlab-pty-fresh",
];
/** Accounts the checks create and never own a real member. Only these are removed by --apply. */
const TEST_ACCOUNTS = /^(kohlab-chk-|koh-smoke-|koh-viewer-)/;
/** Every account a check could have made, listed for a person to look at. */
const ANY_TEST_ACCOUNT = /^(koh-|kohlab-chk-)/;

const say = (s = "") => console.log(s);

/** Read a systemd unit's Environment (the live server's WORKS_DIR and PTY_SOCKET) without failing when there is none. */
function unitEnv(key) {
  const out = spawnSync("systemctl", ["show", process.env.KOHLAB_UNIT ?? "kohlab", "-p", "Environment"], { encoding: "utf8" }).stdout ?? "";
  return new RegExp(`.*${key}=([^ ]+)`).exec(out)?.[1];
}

const WORKS = resolve(process.env.WORKS_DIR || unitEnv("WORKS_DIR") || "/root/.kohlab");
const LIVE_SOCKET = process.env.PTY_SOCKET || unitEnv("PTY_SOCKET") || "/tmp/kohlab-pty.sock";

/* ------------------------------------------------------------ state and users -- */
function readState() {
  const file = join(WORKS, "state.json");
  if (!existsSync(file)) return { ok: true, names: new Set(), dirs: new Set() };
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    const names = new Set();
    const dirs = new Set();
    for (const w of s.workspaces ?? []) {
      if (w.id) names.add(w.id);
      if (typeof w.dir === "string" && w.dir) {
        dirs.add(resolve(w.dir));
        names.add(basename(w.dir));
      }
    }
    return { ok: true, names, dirs };
  } catch {
    return { ok: false, names: new Set(), dirs: new Set() };
  }
}

function usersJsonIds() {
  const file = join(WORKS, "users.json");
  if (!existsSync(file)) return new Set();
  try {
    return new Set((JSON.parse(readFileSync(file, "utf8")).users ?? []).map((u) => u.osUser ?? u.id));
  } catch {
    return null; // unknown: treat every account as possibly a member
  }
}

const homes = new Map();
function passwdNames() {
  const names = new Map();
  for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
    const [name, , uid, , , home] = line.split(":");
    if (name) names.set(name, Number(uid));
    if (name) homes.set(name, home ?? "");
  }
  return names;
}

/* ------------------------------------------------------------------ listing -- */
/** True when any process runs as the account (or the check cannot tell): it is then never removed. */
function inUse(name) {
  const r = spawnSync("pgrep", ["-u", name], { encoding: "utf8" });
  return r.status !== 1;
}

const state = readState();
const folders = [];
const daemons = [];
const aclStale = [];
const accounts = [];

if (existsSync(WORKS)) {
  for (const e of readdirSync(WORKS, { withFileTypes: true })) {
    if (!TEST_FOLDERS.some((p) => e.name.startsWith(p))) continue;
    const p = join(WORKS, e.name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      folders.push({ path: p, why: "a symlink: listed, never followed or removed", skip: true });
    } else if (st.isDirectory()) {
      const referenced = state.names.has(e.name) || state.dirs.has(p);
      folders.push({ path: p, why: referenced ? "referenced by state.json" : "not referenced by any workspace", skip: referenced });
    }
  }
}

for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
  try {
    if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("pty-daemon.cjs")) continue;
    const socket = /(?:^|\0)PTY_SOCKET=([^\0]*)/.exec(readFileSync(`/proc/${pid}/environ`, "utf8"))?.[1] ?? "";
    if (!socket || socket === LIVE_SOCKET) continue;
    if (SOCKETS_UNDER && !resolve(socket).startsWith(SOCKETS_UNDER + "/")) continue;
    daemons.push({ pid: Number(pid), socket });
  } catch {
    /* gone, or not ours to read */
  }
}

const passwd = passwdNames();
const uidsKnown = new Set(passwd.values());
if (!DIRS_ONLY) {
  for (const dir of ["/root", "/root/.kohlab"]) {
    if (!existsSync(dir)) continue;
    const acl = spawnSync("getfacl", ["-n", "-p", dir], { encoding: "utf8" }).stdout ?? "";
    for (const line of acl.split("\n")) {
      const m = /^user:([^:]*):/.exec(line);
      if (!m || m[1] === "") continue;
      const who = m[1];
      const gone = /^\d+$/.test(who) ? !uidsKnown.has(Number(who)) : !passwd.has(who);
      if (gone) aclStale.push({ dir, who, numeric: /^\d+$/.test(who) });
    }
  }
  const owned = usersJsonIds();
  for (const [name] of passwd) {
    if (!ANY_TEST_ACCOUNT.test(name)) continue;
    const member = owned === null || owned.has(name);
    const home = homes.get(name) ?? "";
    // never a real member's, and only a test home: under /home or a /root/.kohlab-chk-* throwaway
    const homeOk = /^\/home\/[^/]+$/.test(home) || /^\/root\/\.kohlab-chk-[^/]+$/.test(home);
    const running = inUse(name);
    const removable = !member && TEST_ACCOUNTS.test(name) && homeOk && !running;
    const why = member ? "owned by users.json, never removed here" : removable ? "not in users.json, removable" : !TEST_ACCOUNTS.test(name) ? "not in users.json, listed only" : !homeOk ? `home ${home || "(none)"} is not a test home, listed only` : "has running processes, listed only";
    accounts.push({ name, removable, why });
  }
}

/* ------------------------------------------------------------------ report -- */
say(`kohlab leftovers, under ${WORKS}${APPLY ? " (--apply)" : " (listing only, nothing changes)"}`);
say(`live daemon socket: ${LIVE_SOCKET}`);
if (!state.ok) say("state.json cannot be read: folders will not be removed (nothing can be proven unreferenced)");
say();
say(`folders (${folders.length}):`);
for (const f of folders) say(`  ${f.skip ? "keep" : "rm  "} ${f.path}  (${f.why})`);
say(`stray daemons (${daemons.length}):`);
for (const d of daemons) say(`  kill pid ${d.pid}  socket ${d.socket}`);
if (!DIRS_ONLY) {
  say(`ACL entries for users that no longer exist (${aclStale.length}):`);
  for (const a of aclStale) say(`  ${a.dir}  user:${a.who}${a.numeric ? " (numeric)" : ""}`);
  say(`OS accounts (${accounts.length}):`);
  for (const a of accounts) say(`  ${a.name}  ${a.why}`);
}

if (!APPLY) {
  say();
  say("nothing removed. Run with --apply to remove the folders, daemons, ACL entries and test accounts above.");
  process.exit(0);
}

/* ------------------------------------------------------------------- apply -- */
say();
for (const f of folders.filter((x) => !x.skip)) {
  if (!state.ok) {
    say(`refused: ${f.path} (state.json is unreadable)`);
    continue;
  }
  if (resolve(f.path) !== join(WORKS, basename(f.path)) || resolve(dirname(f.path)) !== WORKS) {
    say(`refused: ${f.path} is not directly inside ${WORKS}`);
    continue;
  }
  const st = lstatSync(f.path);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    say(`skipped: ${f.path} is not a plain folder now`);
    continue;
  }
  rmSync(f.path, { recursive: true, force: true });
  say(`removed folder ${f.path}`);
}

for (const d of daemons) {
  try {
    // Re-read before killing: the pid may have been reused since the list was printed.
    const cmd = readFileSync(`/proc/${d.pid}/cmdline`, "utf8");
    if (!cmd.includes("pty-daemon.cjs")) continue;
    process.kill(d.pid, "SIGTERM");
    say(`stopped daemon pid ${d.pid} (socket ${d.socket})`);
  } catch {
    say(`skipped pid ${d.pid}: gone`);
  }
}

if (!DIRS_ONLY) {
  for (const a of aclStale) {
    spawnSync("setfacl", ["-x", `u:${a.who}`, a.dir], { encoding: "utf8" });
    say(`removed ACL entry user:${a.who} on ${a.dir}`);
  }
  for (const a of accounts.filter((x) => x.removable)) {
    if (inUse(a.name)) {
      say(`account ${a.name} not removed: it has running processes now`);
      continue;
    }
    const r = spawnSync("userdel", ["-r", a.name], { encoding: "utf8" });
    say(r.status === 0 ? `removed account ${a.name}` : `account ${a.name} not removed: ${(r.stderr || "").trim()}`);
  }
}
