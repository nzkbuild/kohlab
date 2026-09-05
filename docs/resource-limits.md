# Resource limits

Each workspace can carry **resource caps** applied to its agent's terminal
session. They prevent one runaway agent from pinning the CPU, filling memory,
or fork-bombing the shared box — without containers.

## The three caps

| Cap | Flag | Mechanism |
|---|---|---|
| Wall-clock timeout | `--timeout <sec>` | coreutils `timeout` wrapper |
| Memory | `--max-mem <mb>` | `ulimit -d` (RLIMIT_DATA) before the agent runs |
| Max processes | `--max-procs <n>` | `ulimit -u` |

## CLI

```bash
kohlab new ~/repo "task" claude --timeout 600 --max-mem 2048 --max-procs 64
```

## Dashboard

The new-workspace form has two optional fields — **max mem MB** and
**timeout s** — alongside repo/task/agent.

## How it works

Every agent shell is spawned by the PTY daemon (`pty-daemon.cjs`). When a
workspace has limits, the daemon wraps the launch command:

```
timeout <sec> sh -c 'ulimit -d <mb*1024>; ulimit -u <n>; exec <agent cmd>'
```

`exec` means the agent replaces the wrapper shell, so the process tree still
looks clean; the limits are applied *before* the agent starts.

## Notes & ceiling

- **`ulimit -d`, not `-v`.** Node reserves huge virtual address space at
  startup, so `ulimit -v` does not contain its heap. `ulimit -d` (data
  segment) does — a `node` agent that exceeds the cap aborts with
  `JavaScript heap out of memory` instead of touching more RAM.

  `ponytail:` `ulimit` is soft: it caps per-process memory but does not fairly
  share idle CPU. When "N agents each get an equal slice" or real per-agent
  accounting matters, move to cgroup v2 (`memory.max`, `pids.max`, `cpu.max`),
  enabled behind `KOHLAB_USE_CGROUPS=1`.

- **Timeout kill uses the existing process-tree kill** (v1.4 hardening), so the
  agent's children are cleaned up with it.

- Limits are **per-workspace**, not per-user. Cross-user *budgets* are a
  separate concern (see ROADMAP.md).
