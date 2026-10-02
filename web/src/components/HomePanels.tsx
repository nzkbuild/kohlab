import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Clock, Cpu, Pulse } from "@phosphor-icons/react";
import { api } from "../api";
import { useApp } from "../store";
import { relativeTime } from "../lib/format";
import { ACTIVITY_CHIP, STATUS_TEXT, byReviewFirst, workspaceStatus, type ActivityKind } from "../lib/status";
import type { AgentStatus, Workspace } from "../types";
import { cn } from "../lib/utils";
import { Button, Panel, PanelHead } from "./ui";

/*
 * The bands Home composes around the workspace list. Review leads (Product
 * principle 2); activity and agents are context, so they sit below the list.
 */

/* --------------------------------------------------------------- constants -- */

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

/* ------------------------------------------------------------ review queue -- */

/** Renders nothing when the queue is empty: an empty band is noise above the list. */
export function ReviewQueue({ workspaces }: { workspaces: Workspace[] }) {
  const navigate = useApp((s) => s.navigate);
  const review = useMemo(
    () => workspaces.filter((w) => workspaceStatus(w) === "needs-review").sort(byReviewFirst),
    [workspaces],
  );
  if (review.length === 0) return null;

  return (
    <Panel className="mt-5 border-status-review/40">
      <PanelHead
        title="Ready for review"
        icon={<Pulse size={14} className="text-status-review" />}
        meta={<span className="tnum">{review.length} waiting</span>}
      />
      <ul className="p-2">
        {review.map((w) => (
          <li key={w.id}>
            <button
              type="button"
              onClick={() => navigate({ kind: "workspace", id: w.id })}
              className="flex min-h-(--row-h) w-full items-center gap-3 rounded-md px-2.5 text-left transition-colors hover:bg-surface-hover"
            >
              <span className={cn("chip-dot shrink-0", STATUS_TEXT["needs-review"])} aria-hidden="true" />
              <span className="mono shrink-0 text-sm text-text-primary">{w.id}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-text-secondary">{w.task}</span>
              <span className="mono hidden shrink-0 text-2xs text-text-faint shell:inline">{w.agent}</span>
              <span className="tnum shrink-0 text-2xs text-text-muted">{relativeTime(w.stopped ?? w.created)}</span>
              <ArrowRight size={14} className="shrink-0 text-text-faint" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* ---------------------------------------------------------------- activity -- */

export function ActivityPanel({ workspaces }: { workspaces: Workspace[] }) {
  const navigate = useApp((s) => s.navigate);
  const activity = useMemo(() => buildActivity(workspaces), [workspaces]);

  return (
    <Panel>
      <PanelHead title="Recent activity" icon={<Clock size={14} />} meta={<span className="tnum">{activity.length}</span>} />
      {activity.length === 0 ? (
        <p className="px-3.5 py-4 text-sm text-text-muted">Nothing yet — activity appears here as agents start and finish.</p>
      ) : (
        <ul>
          {activity.map((entry) => (
            <li key={entry.key}>
              <button
                type="button"
                onClick={() => navigate({ kind: "workspace", id: entry.workspaceId })}
                className="flex w-full items-center gap-3 border-t border-line-subtle px-3.5 py-2 text-left transition-colors first:border-t-0 hover:bg-surface-hover"
              >
                <span className={cn("chip", ACTIVITY_CHIP[entry.kind])}>{ACTIVITY_LABEL[entry.kind]}</span>
                <span className="mono shrink-0 text-xs text-text-secondary">{entry.workspaceId}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-text-muted">{entry.task}</span>
                <span className="tnum shrink-0 text-2xs text-text-faint">{relativeTime(entry.time)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ agents -- */

export function AgentsPanel() {
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

  return (
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
            This server reports no agents installed — install one from Settings.
          </span>
        ) : (
          agentEntries.map(([name, installed]) => (
            <span key={name} className={cn("chip", installed ? AGENT_CHIP.installed : AGENT_CHIP.missing)}>
              <span className="chip-dot" aria-hidden="true" />
              {name} — {installed ? "installed" : "missing"}
            </span>
          ))
        )}
      </div>
    </Panel>
  );
}
