#!/usr/bin/env bun
// kohlab — PTY-backed coding-agent workspace CLI

import { spawnSync } from "child_process";
import {
  createWorkspace,
  deleteWorkspace,
  getDiff,
  getWorkspace,
  listWorkspaces,
  restartWorkspace,
  startWorkspace,
  stopWorkspace,
  commitWorkspace,
  worktreePath,
  loadState,
  saveState,
  WORKS_DIR,
  listUsers,
  addUser,
  removeUser,
  readAudit,
} from "./lib";

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "new": {
      const [repo, task, agent = "sh"] = args;
      if (!repo || !task) usage("new <repo> <task> [agent] [--branch b] [--payload '...'] [--timeout sec] [--max-mem mb] [--max-procs n]");
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
    case "ls": {
      const list = await listWorkspaces();
      if (list.length === 0) {
        console.log("no workspaces. create one: kohlab new <repo> <task> [agent]");
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
    case "delete": {
      if (!args[0]) usage("delete <id>");
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
    case "server": {
      const { spawn } = await import("child_process");
      const p = spawn("bun", ["run", "server.ts"], { stdio: "inherit", cwd: import.meta.dir });
      p.on("exit", () => process.exit(0));
      break;
    }
    case "open": {
      console.log(`dashboard: http://<vps-ip>:${process.env.PORT ?? 7676}`);
      console.log(`tunnel:    ssh -L ${process.env.PORT ?? 7676}:localhost:${process.env.PORT ?? 7676} user@vps`);
      break;
    }
    case "install": {
      // report what's here / what's missing
      for (const dep of ["git", "bun"]) {
        const ok = spawnSync("which", [dep]).status === 0;
        console.log(`${ok ? "✓" : "✗ missing"}  ${dep}`);
      }
      // generate + show an access key if none is set
      if (!process.env.KOHLAB_KEY) {
        const key = spawnSync("openssl", ["rand", "-hex", "24"]).stdout.toString().trim();
        console.log(`\nno KOHLAB_KEY set. run the server with one:\n  KOHLAB_KEY=${key} bun run cli.ts server`);
      }
      console.log(`\nstart:  bun run cli.ts server`);
      console.log(`tunnel: ssh -L 7676:localhost:7676 user@vps  →  http://localhost:7676`);
      console.log(`auto-start on reboot: docs/systemd.md`);
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
    case undefined:
      // bare `kohlab` → open the dashboard (browser as the app)
      await openDashboard();
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      usage();
  }
}

/** Open the dashboard in the browser, or print the URL if headless. */
async function openDashboard() {
  const port = process.env.PORT ?? "7676";
  const url = `http://localhost:${port}`;
  console.log(`kohlab dashboard: ${url}`);
  try {
    const { execFile } = await import("child_process");
    execFile("xdg-open", [url], { detached: true }).unref();
    console.log("opened in browser — close the tab, agents keep running.");
  } catch {
    console.log(`(headless? open ${url} in any browser, or ssh -L ${port}:localhost:${port} user@vps)`);
  }
}


function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function usage(extra?: string) {
  if (extra) console.error(`usage: kohlab ${extra}\n`);
  console.log(`kohlab — coding-agent workspaces
  kohlab new <repo> <task> [agent] [--branch b] [--payload '...'] [--timeout s] [--max-mem mb] [--max-procs n]  create a worktree workspace
  kohlab ls                                                         list workspaces
  kohlab start|stop|restart <id>                                    control a workspace
  kohlab diff <id>                                                  show uncommitted diff
  kohlab commit <id> [message]                                      commit workspace changes
  kohlab delete <id>                                                remove workspace + worktree
  kohlab agents [add <name> <cmd>]                                  list / add agent launchers
  kohlab server                                                     run the web dashboard server
  kohlab open                                                       print dashboard URL + tunnel
  kohlab install                                                    check deps + show setup steps
  kohlab user add <id> [--name 'N'] [--role R]                       add a team member (owner|member|viewer)
  kohlab user rm <id>                                                revoke a teammate
  kohlab user                                                        list users
  kohlab audit                                                       show the mutation audit trail
state: ${WORKS_DIR}`);
  process.exit(extra ? 1 : 0);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
