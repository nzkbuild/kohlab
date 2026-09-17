import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowRight,
  CheckCircle,
  Clock,
  Cpu,
  FolderOpen,
  PlayCircle,
  Pulse,
  Stack,
} from "@phosphor-icons/react";
import { api } from "../api";
import { useApp } from "../store";
import { relativeTime } from "../lib/format";
import {
  ACTIVITY_CHIP,
  STATUS_LABEL,
  STATUS_TEXT,
  byReviewFirst,
  workspaceStatus,
  type ActivityKind,
  type WorkspaceStatus,
} from "../lib/status";
import type { AgentStatus, Workspace } from "../types";
import { cn } from "../lib/utils";
import { Button, EmptyState, Panel, PanelHead, Skeleton, SkeletonRows, StatusChip } from "./ui";

/* --------------------------------------------------------------- constants -- */

/** Lifecycle order, review first: the queue is the reason this screen exists. */
const TABS: WorkspaceStatus[] = ["needs-review", "running", "committed", "stopped"];

const TABLE_PANEL_ID = "dashboard-workspaces";

const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  created: "created",
  start: "started",
  review: "ready for review",
  commit: "committed",
  stop: "stopped",
};

/** Installed reads as available (cyan, no pulse); missing keeps the outline. */
const AGENT_CHIP = { installed: "chip-committed", missing: "chip-stopped" } as const;

interface ActivityEntry {
  key: string;
  workspaceId: string;
  task: string;
  kind: ActivityKind;
  time: number;
}

/** The timeline is derived from workspace timestamps — there is no event feed. */
function buildActivity(workspaces: Workspace[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const w of workspaces) {
    const base = { workspaceId: w.id, task: w.task };
    entries.push({ ...base, key: `${w.id}-created`, kind: "created", time: w.created });
    if (w.started) entries.push({ ...base, key: `${w.id}-started`, kind: "start", time: w.started });
    if (w.stopped) {
      entries.push({
        ...base,
        key: `${w.id}-stopped`,
        kind: workspaceStatus(w) === "needs-review" ? "review" : "stop",
        time: w.stopped,
      });
    }
    if (w.lastCommitAt) entries.push({ ...base, key: `${w.id}-commit`, kind: "commit", time: w.lastCommitAt });
  }
  return entries.sort((a, b) => b.time - a.time).slice(0, 12);
}

/* --------------------------------------------------------------- dashboard -- */

/** Command center: KPIs, review queue, filterable workspace table, activity, agents. */
export default function Dashboard() {
  const workspaces = useApp((s) => s.workspaces);
  const loading = useApp((s) => s.loading);
  const navigate = useApp((s) => s.navigate);

  const counts = useMemo(() => {
    const by: Record<WorkspaceStatus, number> = { running: 0, "needs-review": 0, committed: 0, stopped: 0 };
    for (const w of workspaces) by[workspaceStatus(w)] += 1;
    return by;
  }, [workspaces]);

  const review = useMemo(
    () => workspaces.filter((w) => workspaceStatus(w) === "needs-review").sort(byReviewFirst),
    [workspaces],
  );

  const activity = useMemo(() => buildActivity(workspaces), [workspaces]);

  // A chosen tab sticks. Until the operator chooses, the queue decides, and an
  // empty queue falls through to whatever is actually live — never a blank table.
  const [picked, setPicked] = useState<WorkspaceStatus | null>(null);
  const tab = picked ?? TABS.find((status) => counts[status] > 0) ?? "needs-review";

  const rows = useMemo(
    () => workspaces.filter((w) => workspaceStatus(w) === tab).sort(byReviewFirst),
    [workspaces, tab],
  );

  const tabRefs = useRef<Partial<Record<WorkspaceStatus, HTMLButtonElement | null>>>({});
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length];
    setPicked(next);
    tabRefs.current[next]?.focus();
  };

  const [agents, setAgents] = useState<AgentStatus | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  const loadAgents = useCallback(() => {
    setAgentsError(null);
    setAgents(null);
    api.agentsStatus().then(setAgents).catch((e: Error) => setAgentsError(e.message));
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const agentEntries = Object.entries(agents ?? {}).sort(([, a], [, b]) => Number(b) - Number(a));

  const metrics: { label: string; value: number; icon: ReactNode; status?: WorkspaceStatus }[] = [
    { label: "Running", value: counts.running, icon: <PlayCircle size={15} />, status: "running" },
    { label: "Needs review", value: counts["needs-review"], icon: <Pulse size={15} />, status: "needs-review" },
    { label: "Workspaces", value: workspaces.length, icon: <FolderOpen size={15} /> },
    { label: "Committed", value: counts.committed, icon: <CheckCircle size={15} />, status: "committed" },
  ];

  const empty = !loading && workspaces.length === 0;

  return (
    <div className="surface">
      <div className="surface-inner">
        <h1 className="surface-title">Command center</h1>
        <p className="surface-description">
          What is running, what is waiting for you, and what has landed. Review comes first.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {metrics.map((m) => (
            <div key={m.label} className="panel p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-text-muted">{m.label}</span>
                <span className="text-text-faint" aria-hidden="true">
                  {m.icon}
                </span>
              </div>
              <div
                className={cn(
                  "mt-2 text-2xl font-semibold tnum",
                  m.status ? STATUS_TEXT[m.status] : "text-text-primary",
                )}
              >
                {loading ? <Skeleton className="h-7 w-8" /> : m.value}
              </div>
            </div>
          ))}
        </div>

        {review.length > 0 ? (
          <Panel className="mt-5">
            <PanelHead
              title="Review queue"
              icon={<Pulse size={14} />}
              meta={<span className="tnum">{review.length} waiting</span>}
            />
            <ul className="p-2">
              {review.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    onClick={() => navigate({ kind: "workspace", id: w.id })}
                    className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface-hover"
                  >
                    <span className={cn("chip-dot shrink-0", STATUS_TEXT["needs-review"])} aria-hidden="true" />
                    <span className="mono shrink-0 text-sm text-text-primary">{w.id}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-text-secondary">{w.task}</span>
                    <span className="mono hidden shrink-0 text-2xs text-text-faint shell:inline">{w.agent}</span>
                    <span className="tnum shrink-0 text-2xs text-text-muted">
                      {relativeTime(w.stopped ?? w.created)}
                    </span>
                    <ArrowRight size={14} className="shrink-0 text-text-faint" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        {empty ? (
          <Panel className="mt-5">
            <EmptyState
              icon={<Stack size={18} />}
              title="No workspaces yet"
              description="A workspace is one task, one repository and one agent. Create the first one and its agent starts immediately."
              action={
                <Button variant="primary" onClick={() => navigate({ kind: "workspaces" })}>
                  create a workspace
                </Button>
              }
            />
          </Panel>
        ) : (
          <Panel className="mt-5">
            <PanelHead
              title="Workspaces"
              icon={<Stack size={14} />}
              meta={loading ? undefined : <span className="tnum">{rows.length}</span>}
            />
            <div className="tabstrip" role="tablist" aria-label="Filter workspaces by status">
              {TABS.map((status, index) => (
                <button
                  key={status}
                  type="button"
                  role="tab"
                  id={`dashboard-tab-${status}`}
                  ref={(el) => {
                    tabRefs.current[status] = el;
                  }}
                  aria-selected={tab === status}
                  aria-controls={TABLE_PANEL_ID}
                  tabIndex={tab === status ? 0 : -1}
                  className="tab"
                  onClick={() => setPicked(status)}
                  onKeyDown={(event) => onTabKey(event, index)}
                >
                  {STATUS_LABEL[status]}
                  {loading ? (
                    <Skeleton className="h-2.5 w-3" />
                  ) : (
                    <span className="tnum text-2xs text-text-muted">{counts[status]}</span>
                  )}
                </button>
              ))}
            </div>

            <div id={TABLE_PANEL_ID} role="tabpanel" aria-labelledby={`dashboard-tab-${tab}`}>
              {loading ? (
                <SkeletonRows rows={6} />
              ) : rows.length === 0 ? (
                <p className="px-3.5 py-6 text-center text-sm text-text-muted">
                  Nothing is {STATUS_LABEL[tab]} right now.
                </p>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Workspace</th>
                      <th scope="col">Task</th>
                      <th scope="col">Status</th>
                      <th scope="col">Agent</th>
                      <th scope="col">Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((w) => (
                      <tr key={w.id}>
                        <th scope="row" className="normal-case tracking-normal">
                          <button
                            type="button"
                            onClick={() => navigate({ kind: "workspace", id: w.id })}
                            className="mono inline-flex min-h-6 items-center text-sm font-medium text-text-primary transition-colors hover:text-accent"
                          >
                            {w.id}
                          </button>
                        </th>
                        <td className="max-w-md truncate text-text-secondary">{w.task}</td>
                        <td>
                          <StatusChip status={workspaceStatus(w)} />
                        </td>
                        <td className="mono text-xs text-text-muted">{w.agent}</td>
                        <td className="tnum text-xs text-text-muted">{relativeTime(w.created)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Panel>
        )}

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          {empty ? null : (
            <Panel>
              <PanelHead
                title="Recent activity"
                icon={<Clock size={14} />}
                meta={loading ? undefined : <span className="tnum">{activity.length}</span>}
              />
              {activity.length === 0 ? (
                <p className="px-3.5 py-4 text-sm text-text-muted">
                  Nothing yet — activity appears here as agents start and finish.
                </p>
              ) : (
                <ul>
                  {activity.map((entry) => (
                    <li key={entry.key}>
                      <button
                        type="button"
                        onClick={() => navigate({ kind: "workspace", id: entry.workspaceId })}
                        className="flex w-full items-center gap-3 border-t border-line-subtle px-3.5 py-2 text-left transition-colors first:border-t-0 hover:bg-surface-hover"
                      >
                        <span className={cn("chip", ACTIVITY_CHIP[entry.kind])}>
                          {ACTIVITY_LABEL[entry.kind]}
                        </span>
                        <span className="mono shrink-0 text-xs text-text-secondary">{entry.workspaceId}</span>
                        <span className="min-w-0 flex-1 truncate text-xs text-text-muted">{entry.task}</span>
                        <span className="tnum shrink-0 text-2xs text-text-faint">{relativeTime(entry.time)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          <Panel>
            <PanelHead title="Agents on this server" icon={<Cpu size={14} />} />
            <div className="flex flex-wrap items-center gap-2 p-4">
              {agentsError ? (
                <>
                  <p className="text-sm text-status-danger" role="alert">
                    Could not read agent status — {agentsError}
                  </p>
                  <Button size="sm" onClick={loadAgents}>
                    retry
                  </Button>
                </>
              ) : agents === null ? (
                <span className="text-sm text-text-muted">checking…</span>
              ) : agentEntries.length === 0 ? (
                <span className="text-sm text-text-muted">
                  This server reports no agents installed — install one from the workspace setup steps.
                </span>
              ) : (
                agentEntries.map(([name, installed]) => (
                  <span
                    key={name}
                    className={cn("chip", installed ? AGENT_CHIP.installed : AGENT_CHIP.missing)}
                  >
                    <span className="chip-dot" aria-hidden="true" />
                    {name} — {installed ? "installed" : "missing"}
                  </span>
                ))
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
