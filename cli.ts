#!/usr/bin/env bun
// kohlab — PTY-backed coding-agent workspace CLI

import { spawn, spawnSync } from "child_process";
import { accessSync, constants, readFileSync, writeFileSync } from "fs";
import { hostname, networkInterfaces, userInfo } from "os";
import { randomBytes } from "crypto";
import { join } from "path";
import {
  createWorkspace,
  deleteWorkspace,
  getDiff,
  listWorkspaces,
  restartWorkspace,
  startWorkspace,
  stopWorkspace,
  commitWorkspace,
  loadState,
  saveState,
  WORKS_DIR,
  listUsers,
  addUser,
  removeUser,
  readAudit,
  ptyDisconnect,
  getWorkspace,
  ptyLog,
  sessionId,
  checkRelease,
} from "./lib";

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "create":
    case "new": {
      const [repo, task, agent = "sh"] = args;
      if (!repo || !task) usage("create <repo> <task> [agent] [--branch b] [--payload '...'] [--timeout sec] [--max-mem mb] [--max-procs n]");
      const branch = flag(args, "--branch");
      const payload = flag(args, "--payload");
      const timeoutSec = flag(args, "--timeout");
      const maxMemoryMb = flag(args, "--max-mem");
      const maxProcs = flag(args, "--max-procs");
      const limits: { timeoutSec?: number; maxMemoryMb?: number; maxProcs?: number } = {};
      if (timeoutSec) limits.timeoutSec = Number(timeoutSec);
      if (maxMemoryMb) limits.maxMemoryMb = Number(maxMemoryMb);
      if (maxProcs) limits.maxProcs = Number(maxProcs);
      const ws = await createWorkspace({ repo, task, agent, branch, payload, limits: Object.keys(limits).length ? limits : undefined });
      console.log(`created ${ws.id} at ${ws.path}`);
      if (limits.timeoutSec || limits.maxMemoryMb || limits.maxProcs) {
        console.log(`limits: ${[limits.timeoutSec && `${limits.timeoutSec}s`, limits.maxMemoryMb && `${limits.maxMemoryMb}MB`, limits.maxProcs && `${limits.maxProcs} procs`].filter(Boolean).join(", ")}`);
      }
      console.log(`start it: kohlab start ${ws.id}`);
      break;
    }
    case "list":
    case "ls": {
      const list = await listWorkspaces();
      if (list.length === 0) {
        console.log("no workspaces. create one: kohlab create <repo> <task> [agent]");
        break;
      }
      for (const w of list) {
        const state = w.running ? "● running" : "○ stopped";
        const age = w.started ? `started ${new Date(w.started).toISOString().slice(11, 19)}` : "never started";
        console.log(`${state}  ${w.id.padEnd(38)} ${w.agent.padEnd(6)} ${age}  ${w.task}`);
      }
      break;
    }
    case "start":
    case "stop":
    case "restart": {
      if (!args[0]) usage(`${cmd} <id>`);
      const fn = cmd === "start" ? startWorkspace : cmd === "stop" ? stopWorkspace : restartWorkspace;
      const ws = await fn(args[0]);
      console.log(`${cmd}: ${ws.id} ${ws.running ? "running" : "stopped"}`);
      break;
    }
    case "remove":
    case "rm":
    case "delete": {
      if (!args[0]) usage("remove <id>");
      await deleteWorkspace(args[0]);
      console.log(`deleted ${args[0]}`);
      break;
    }
    case "diff": {
      if (!args[0]) usage("diff <id>");
      const files = await getDiff(args[0]);
      for (const f of files) {
        console.log(`\n=== ${f.name} ===\n`);
        console.log(f.diff || "(clean)");
      }
      break;
    }
    case "commit": {
      if (!args[0]) usage("commit <id> [message]");
      const msg = args.slice(1).join(" ");
      await commitWorkspace(args[0], msg);
      console.log(`committed ${args[0]}`);
      break;
    }
    case "agents": {
      const s = await loadState();
      if (args[0] === "add" && args[1] && args[2]) {
        s.agents[args[1]] = args[2];
        await saveState(s);
        console.log(`agent ${args[1]} → ${args[2]}`);
      } else {
        for (const [k, v] of Object.entries(s.agents)) console.log(`${k.padEnd(10)} ${v}`);
      }
      break;
    }
    case "update": {
      // save → check → download → install → build → reload, with rollback.
      const p = spawn("bash", [`${import.meta.dir}/scripts/update.sh`, ...args], { stdio: "inherit", cwd: import.meta.dir });
      p.on("exit", (code) => process.exit(code ?? 1));
      break;
    }
    case "logs":
    case "log": {
      if (!args[0]) usage("logs <id>");
      const ws = await getWorkspace(args[0]);
      const log = await ptyLog(sessionId(ws.id));
      if (!log) {
        console.log(`no output from ${ws.id} yet — start it: kohlab start ${ws.id}`);
        break;
      }
      process.stdout.write(log.endsWith("\n") ? log : log + "\n");
      break;
    }
    case "version":
    case "--version":
    case "-V":
    case "-v": {
      printVersion();
      break;
    }
    case "key": {
      // The recovery channel of last resort. Whoever holds the box can read or
      // replace the key; nobody else can, and it never travels over the network.
      const sources: [string, string | undefined][] = [
        ["KOHLAB_KEY in this environment", process.env.KOHLAB_KEY],
        ["the systemd unit", unitKey()],
        [`${join(WORKS_DIR, "key")}`, fileKey()],
      ];
      const found = sources.find(([, v]) => v && v.length > 0);

      if (args[0] === "rotate") {
        const next = randomBytes(24).toString("hex");
        writeFileSync(join(WORKS_DIR, "key"), next + "\n", { mode: 0o600 });
        console.log(`new key written to ${join(WORKS_DIR, "key")}\n`);
        console.log(next);
        console.log(`\nthe running server still uses the old one. to apply it:`);
        console.log(`  1. if ${UNIT} sets KOHLAB_KEY, replace that value with the key above`);
        console.log(`  2. sudo systemctl daemon-reload && sudo systemctl restart ${UNIT}`);
        console.log(`\nthe old key stops working the moment the server restarts.`);
        break;
      }

      if (!found?.[1]) {
        console.log(`no access key found. this server is open to anything that can reach it.`);
        console.log(`set one:  kohlab key rotate   (then follow the two steps it prints)`);
        break;
      }
      console.log(found[1]);
      console.error(`(from ${found[0]})`);
      break;
    }
    case "status": {
      await printStatus();
      break;
    }
    case "doctor":
    case "install": {
      await doctor();
      break;
    }
    case "serve":
    case "server": {
      const { spawn } = await import("child_process");
      const p = spawn("bun", ["run", "server.ts"], { stdio: "inherit", cwd: import.meta.dir });
      p.on("exit", () => process.exit(0));
      break;
    }
    case "open": {
      printDashboard();
      break;
    }
    case "user": {
      if (args[0] === "add") {
        const id = args[1];
        const name = flag(args, "--name") ?? id;
        const role = flag(args, "--role") ?? "member";
        if (!id) usage("user add <id> [--name 'Name'] [--role owner|member|viewer]");
        if (!["owner", "member", "viewer"].includes(role)) usage("role must be owner|member|viewer");
        try {
          const { key } = await addUser({ id, name, role: role as "owner" | "member" | "viewer" });
          console.log(`created user '${id}' (${role})`);
          console.log(`key (shown once — store it now): ${key}`);
        } catch (e) {
          console.error((e as Error).message);
          process.exit(1);
        }
        break;
      }
      if (args[0] === "rm") {
        if (!args[1]) usage("user rm <id>");
        await removeUser(args[1]);
        console.log(`removed user '${args[1]}'`);
        break;
      }
      // list (default)
      const users = listUsers();
      if (users.length === 0) console.log("no users yet. add one: kohlab user add <id>");
      for (const u of users) console.log(`${u.id.padEnd(16)} ${u.role.padEnd(8)} ${u.name}`);
      break;
    }
    case "audit": {
      const limitStr = flag(args, "--limit");
      const events = await readAudit(limitStr ? Number(limitStr) : 200);
      for (const e of events) {
        const when = new Date(e.t).toISOString().slice(11, 19);
        console.log(`${when}  ${e.user.padEnd(12)} ${e.action.padEnd(12)} ${e.id ?? ""} ${e.detail ?? ""}`);
      }
      break;
    }
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    case undefined:
      // Standard CLI behaviour: no arguments prints the command list. Use
      // `kohlab open` for the dashboard — a bare command that launches a
      // browser is a surprise on a headless server.
      usage();
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      usage(undefined, 1);
  }
}

/**
 * Where the dashboard actually is: loopback plus every non-internal IPv4 this
 * box has (the Tailscale address shows up here), the SSH tunnel for anything
 * else, and the state directory in use — so "which fleet am I looking at?" is
 * never a guess.
 */
function printDashboard() {
  const port = process.env.PORT ?? "7676";
  const extra: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) extra.push(`http://${a.address}:${port}   (${name})`);
    }
  }
  console.log(`dashboard:  http://localhost:${port}`);
  for (const u of extra) console.log(`            ${u}`);
  console.log(`tunnel:     ssh -L ${port}:localhost:${port} ${userInfo().username}@${hostname()}`);
  console.log(`state:      ${WORKS_DIR}`);
}

/** Open the dashboard in the browser, or print the URL if headless. */



/** The unit this deployment runs as, when it runs under systemd. */
const UNIT = process.env.KOHLAB_UNIT ?? "kohlab";

/** The key as configured in the service unit, if there is one. */
function unitKey(): string | undefined {
  // systemd merges every Environment= line into one, so match anywhere on it.
  return /KOHLAB_KEY=([^ ]+)/.exec(systemctl(["show", UNIT, "-p", "Environment"]).out)?.[1];
}

/** The key generated at startup, if one was. */
function fileKey(): string | undefined {
  try {
    return readFileSync(join(WORKS_DIR, "key"), "utf8").trim();
  } catch {
    return undefined;
  }
}

/** kohlab's own version, from the checkout this command runs from. */
function version(): { version: string; commit: string } {
  let v = "0.0.0";
  try {
    v = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")).version;
  } catch {
    /* not a checkout — report the placeholder rather than dying */
  }
  const commit = spawnSync("git", ["-C", import.meta.dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout?.trim() ?? "";
  return { version: v, commit };
}

function printVersion() {
  const { version: v, commit } = version();
  console.log(`kohlab ${v}${commit ? ` (${commit})` : ""}`);
}

const TICK = "\x1b[1;32m✓\x1b[0m";
const NOTE = "\x1b[1;33m!\x1b[0m";
const CROSS = "\x1b[1;31m✗\x1b[0m";
const dim = (s: string) => (s ? `  \x1b[2m${s}\x1b[0m` : "");

/** One screen: what is installed, what is running, what is new. */
async function printStatus() {
  const { version: v, commit } = version();
  console.log(`kohlab ${v}${commit ? ` (${commit})` : ""}`);

  const port = process.env.PORT ?? "7676";
  const up = await probePort(port);

  // the unit, when there is one — how the server is meant to stay up
  const unit = systemctl(["is-active", "kohlab"]);
  if (unit.available) {
    const enabled = systemctl(["is-enabled", "kohlab"]).out;
    const state = unit.out === "active" ? `${TICK} active` : `${NOTE} ${unit.out}`;
    console.log(`  service     ${state}${dim(`kohlab.service, ${enabled || "not enabled"}`)}`);
  }
  console.log(`  server      ${up ? `${TICK} answering on :${port}` : `${NOTE} nothing on :${port}${dim("start it: kohlab serve")}`}`);
  console.log(`  state       ${WORKS_DIR}`);

  const ws = await listWorkspaces();
  const running = ws.filter((w) => w.running).length;
  console.log(`  workspaces  ${ws.length} total · ${running} running · ${ws.length - running} stopped`);

  try {
    const release = await checkRelease();
    if (release.error) console.log(`  update      ${NOTE} could not check${dim(release.error)}`);
    else if (release.available) console.log(`  update      ${NOTE} v${release.latest} available${dim(`${release.commits.length} commit(s) — kohlab update`)}`);
    else console.log(`  update      ${TICK} up to date${dim(`v${release.current}`)}`);
  } catch {
    /* status must never fail on a network check */
  }
}

/** Deps, service and the two ways a deployment is quietly broken. Non-zero on a hard failure. */
async function doctor() {
  let failed = 0;
  const ok = (label: string, detail = "") => console.log(`${TICK} ${label}${dim(detail)}`);
  const warn = (label: string, detail = "") => console.log(`${NOTE} ${label}${dim(detail)}`);
  const bad = (label: string, detail = "") => {
    failed++;
    console.log(`${CROSS} ${label}${dim(detail)}`);
  };

  for (const dep of ["git", "bun"]) {
    const r = spawnSync(dep, ["--version"], { encoding: "utf8" });
    if (r.status === 0) ok(dep, (r.stdout ?? "").trim().split("\n")[0]);
    else bad(dep, "not on PATH — install it, then re-run");
  }

  const self = spawnSync("which", ["kohlab"], { encoding: "utf8" }).stdout?.trim();
  if (self) ok("kohlab on PATH", self);
  else warn("kohlab is not on PATH", "run the installer, or call it by absolute path");

  console.log(`${TICK} state directory`, WORKS_DIR);
  try {
    accessSync(WORKS_DIR, constants.W_OK);
  } catch {
    warn("state directory is not writable", WORKS_DIR);
  }

  const active = systemctl(["is-active", "kohlab"]);
  if (!active.available) {
    warn("systemd not available", "run it in the foreground: kohlab serve");
  } else if (active.out === "active") {
    const enabled = systemctl(["is-enabled", "kohlab"]).out;
    ok("kohlab.service", `active, ${enabled || "not enabled"}`);
  } else {
    warn("kohlab.service is not running", "start it: sudo systemctl enable --now kohlab");
  }

  // The one misconfiguration that silently costs you every live agent.
  const killMode = systemctl(["show", "kohlab", "-p", "KillMode"]).out.replace(/^KillMode=/, "");
  if (killMode === "process") ok("KillMode=process", "a restart keeps every live agent session");
  else if (killMode) bad(`KillMode=${killMode}`, "a restart kills the PTY daemon and every live agent — see docs/systemd.md");

  const port = process.env.PORT ?? "7676";
  if (await probePort(port)) ok("dashboard", `http://localhost:${port}`);
  else warn(`nothing answering on :${port}`, "start it: kohlab serve");

  // The key lives in the unit, not in this process's environment — checking
  // process.env alone reported a false alarm on every healthy deployment.
  const unitEnv = systemctl(["show", "kohlab", "-p", "Environment"]).out;
  if (process.env.KOHLAB_KEY || /KOHLAB_KEY=[^ ]/.test(unitEnv)) {
    ok("access key set");
  } else {
    warn("no access key", "set KOHLAB_KEY in the unit, or the dashboard is open to anything that reaches the port");
  }

  console.log(failed ? `\n${failed} problem(s) found` : "\nno problems found");
  process.exit(failed ? 1 : 0);
}

/** systemctl's answer, with "no systemd on this box" distinguishable from an empty one. */
function systemctl(args: string[]): { available: boolean; out: string } {
  const r = spawnSync("systemctl", args, { encoding: "utf8" });
  return { available: !r.error, out: (r.stdout ?? "").trim() };
}

/** Is the dashboard answering? Never throws, never hangs. */
async function probePort(port: string): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(1500) });
    return r.status < 400;
  } catch {
    return false;
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function usage(extra?: string, code = extra ? 1 : 0) {
  if (extra) console.error(`usage: kohlab ${extra}\n`);
  console.log(`kohlab — run AI coding agents in parallel, persistently, from any device

usage: kohlab <command> [options]

basic
  help                                       this list
  version                                    print the version
  status                                     what is installed and what is running
  doctor                                     check dependencies, service and config

workspaces
  list                                       list workspaces
  create <repo> <task> [agent]               start an agent in its own worktree
         [--branch b] [--payload '...'] [--timeout s] [--max-mem mb] [--max-procs n]
  start <id>                                 start its session
  stop <id>                                  stop it
  restart <id>                               start it again
  logs <id>                                  what the agent has printed
  diff <id>                                  uncommitted changes
  commit <id> [message]                      commit them in the workspace
  remove <id>                                delete the workspace and its worktree

server
  serve                                      run the dashboard server (foreground)
  open                                       print the dashboard URLs
  update [--check] [--force]                 update kohlab; running agents keep running

access
  users                                      list team members
  user add <id> [--name 'N'] [--role R]      add one (owner|member|viewer)
  user rm <id>                               revoke one
  audit                                      the mutation audit trail
  key                                        print the access key (from this box)
  key rotate                                 issue a new one and say how to apply it

agents
  agents                                     list agent launchers
  agents add <name> <cmd>                    register one

aliases: ls=list  new=create  rm=delete=remove  log=logs  server=serve  install=doctor
state: ${WORKS_DIR}`);
  process.exit(code);
}

main()
  // The daemon socket is a module-level singleton; without closing it a
  // one-shot CLI never exits (see ptyDisconnect).
  .then(() => ptyDisconnect())
  .catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
