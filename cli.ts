#!/usr/bin/env bun
// works — tmux-backed coding-agent workspace runner CLI

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
} from "./lib";

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "new": {
      const [repo, task, agent = "sh"] = args;
      if (!repo || !task) usage("new <repo> <task> [agent] [--branch b] [--payload '...']");
      const branch = flag(args, "--branch");
      const payload = flag(args, "--payload");
      const ws = await createWorkspace({ repo, task, agent, branch, payload });
      console.log(`created ${ws.id} at ${ws.path}`);
      console.log(`start it: works start ${ws.id}`);
      break;
    }
    case "ls": {
      const list = await listWorkspaces();
      if (list.length === 0) {
        console.log("no workspaces. create one: works new <repo> <task> [agent]");
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
    case "attach": {
      if (!args[0]) usage("attach <id>");
      const ws = await getWorkspace(args[0]);
      const { spawn } = await import("child_process");
      spawn("tmux", ["attach", "-t", `works-${ws.id}`], { stdio: "inherit" }).on("exit", () => process.exit(0));
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
    case "help":
    case undefined:
      usage();
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      usage();
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function usage(extra?: string) {
  if (extra) console.error(`usage: works ${extra}\n`);
  console.log(`works — tmux-backed coding-agent workspaces
  works new <repo> <task> [agent] [--branch b] [--payload '...']   create a worktree workspace
  works ls                                                          list workspaces
  works start|stop|restart <id>                                     control a workspace
  works attach <id>                                                 tmux attach to a workspace
  works diff <id>                                                   show uncommitted diff
  works commit <id> [message]                                       commit workspace changes
  works delete <id>                                                 remove workspace + worktree
  works agents [add <name> <cmd>]                                   list / add agent launchers
  works server                                                      run the web dashboard server
  works open                                                        print dashboard URL + tunnel
state: ${WORKS_DIR}`);
  process.exit(extra ? 1 : 0);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
