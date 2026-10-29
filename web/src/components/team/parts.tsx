import type { ReactNode } from "react";
import { DotsThree, Pause, Play, SlidersHorizontal, Stop } from "@phosphor-icons/react";
import { agoText } from "../../lib/aiHub";
import { boardGroups, budgetLines, taskWord } from "../../lib/team";
import { cn } from "../../lib/utils";
import type { Budget, NeedsYou, Spent, TeamEvent, TeamRole, TeamTask } from "../../team-types";
import { Button, Menu, MenuItem, MenuSeparator } from "../ui";

/* ----------------------------------------------------------- meter -- */

/** A slim budget bar: the Usage dialog's recipe. A missing limit has no bar, only its words. */
export function Meter({ label, percent, text }: { label: string; percent: number | null; text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {percent === null ? null : (
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={text}
          className="h-1.5 w-full overflow-hidden rounded-full bg-surface-raised"
        >
          <div className="h-full rounded-full bg-text-secondary" style={{ width: `${percent}%` }} />
        </div>
      )}
      <p className="text-xs text-text-muted tabular-nums">{text}</p>
    </div>
  );
}

/** The budget's meters in the order lines come: tokens, then minutes. */
export function BudgetMeters({ label, budget, spent }: { label: string; budget: Budget; spent: Spent }) {
  return (
    <div className="flex flex-col gap-2">
      {budgetLines(budget, spent).map((l) => (
        <Meter key={l.key} label={`${label}, ${l.key === "tokens" ? "tokens" : "minutes"}`} percent={l.percent} text={l.text} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ agents -- */

export interface AgentActions {
  onSelect: () => void;
  onChange: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

/**
 * One agent: its name (a filled dot before it when it needs you), the run-strip line that carries the AI, account, model,
 * mode and state, and a ⋯ menu for the person who can change the team. Pressing the card picks the agent.
 */
export function AgentCard({
  role,
  strip,
  selected,
  canChange,
  actions,
}: {
  role: TeamRole;
  strip: string;
  selected: boolean;
  canChange: boolean;
  actions: AgentActions;
}) {
  const paused = role.state === "paused";
  const ended = role.state === "stopped" || role.state === "budget";
  return (
    <div className={cn("flex min-w-0 items-start gap-2 rounded-card p-3", selected ? "bg-surface-active" : "bg-surface-raised")}>
      <button
        type="button"
        aria-pressed={selected}
        onClick={actions.onSelect}
        className="flex min-w-0 flex-1 flex-col gap-1 rounded-row text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:min-h-11"
      >
        <span className="flex min-w-0 items-center gap-2">
          {role.state === "needs_you" ? <span className="size-2 shrink-0 rounded-full bg-text-primary" aria-hidden="true" /> : null}
          <span className="min-w-0 truncate text-base font-medium text-text-primary">{role.name}</span>
        </span>
        <span className="truncate text-sm text-text-muted">{strip}</span>
      </button>
      {canChange ? (
        <Menu
          label={`Actions for ${role.name}`}
          align="end"
          trigger={
            <Button variant="quiet" iconOnly aria-label={`Actions for ${role.name}`} className="size-11 shrink-0">
              <DotsThree size={18} weight="bold" aria-hidden="true" />
            </Button>
          }
        >
          <MenuItem onSelect={actions.onChange}>
            <SlidersHorizontal size={16} aria-hidden="true" />
            Change AI, model or mode
          </MenuItem>
          {ended ? null : paused ? (
            <MenuItem onSelect={actions.onResume}>
              <Play size={16} aria-hidden="true" />
              Resume
            </MenuItem>
          ) : (
            <MenuItem onSelect={actions.onPause}>
              <Pause size={16} aria-hidden="true" />
              Pause
            </MenuItem>
          )}
          {ended ? null : (
            <>
              <MenuSeparator />
              <MenuItem tone="danger" onSelect={actions.onStop}>
                <Stop size={16} aria-hidden="true" />
                Stop
              </MenuItem>
            </>
          )}
        </Menu>
      ) : null}
    </div>
  );
}

/** The Lead on top, the others in a row under it. Each card is the same AgentCard. */
export function OrgChart({ roles, render }: { roles: TeamRole[]; render: (r: TeamRole) => ReactNode }) {
  const lead = roles.filter((r) => r.kind === "lead");
  const rest = roles.filter((r) => r.kind !== "lead");
  return (
    <section aria-labelledby="team-agents" className="flex flex-col gap-3">
      <h2 id="team-agents" className="sr-only">
        Agents
      </h2>
      {lead.map((r) => (
        <div key={r.id} className="mx-auto w-full max-w-sm">
          {render(r)}
        </div>
      ))}
      <ul aria-label="Builders, reviewer and tester" className="grid grid-cols-1 gap-3 [grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))]">
        {rest.map((r) => (
          <li key={r.id} className="min-w-0">
            {render(r)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------- board -- */

/** The four columns, each a heading (h3) and its tasks. On a phone the same markup stacks in one column. */
export function Board({ tasks, names }: { tasks: TeamTask[]; names: Record<string, string> }) {
  return (
    <section aria-labelledby="team-board" className="flex flex-col gap-3">
      <h2 id="team-board" className="text-sm font-medium text-text-secondary">
        Board
      </h2>
      <div className="grid grid-cols-1 gap-4 shell:grid-cols-4">
        {boardGroups(tasks).map((g) => (
          <div key={g.id} className="flex min-w-0 flex-col gap-2">
            <h3 className="flex items-baseline gap-2 text-sm font-medium text-text-primary">
              {g.label}
              <span className="text-xs font-normal text-text-muted tabular-nums">{g.tasks.length}</span>
            </h3>
            {g.tasks.length === 0 ? <p className="text-xs text-text-muted">Nothing here</p> : null}
            <ul aria-label={g.label} className="flex flex-col gap-2">
              {g.tasks.map((t) => (
                <li key={t.id} className="flex min-w-0 flex-col gap-1 rounded-card bg-surface-raised p-3">
                  <span className="text-sm text-text-primary">{t.title}</span>
                  <span className="text-xs text-text-muted">
                    {[taskWord(t.status), t.assignee ? names[t.assignee] ?? t.assignee : null].filter(Boolean).join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- feed -- */

/** The team's events, newest first. Text is plain; the server has already capped it. */
export function Feed({ events, title }: { events: TeamEvent[]; title: (e: TeamEvent) => string }) {
  const newest = events.slice(-200).reverse();
  return (
    <section aria-labelledby="team-activity" className="flex min-h-0 flex-col gap-2">
      <h2 id="team-activity" className="text-sm font-medium text-text-secondary">
        Activity
      </h2>
      {newest.length === 0 ? <p className="text-sm text-text-muted">Nothing has happened yet.</p> : null}
      <ol aria-label="Activity" className="flex min-h-0 flex-col gap-3 overflow-y-auto">
        {newest.map((e) => (
          <li key={e.n} className="flex min-w-0 flex-col gap-0.5">
            <p className="text-sm break-words text-text-primary">{e.text}</p>
            <p className="text-xs text-text-muted">{`${title(e)} · ${agoText(e.at)}`}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------- needs you -- */

/** What waits for the person: one line each, a filled dot and the words. */
export function NeedsYouList({ items, names }: { items: NeedsYou[]; names: Record<string, string> }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="team-needs" className="flex flex-col gap-2">
      <h2 id="team-needs" className="text-sm font-medium text-text-primary">
        Needs you
      </h2>
      <ul aria-label="Needs you" className="flex flex-col gap-2">
        {items.map((n, i) => (
          <li key={`${n.kind}-${i}`} className="flex min-w-0 items-start gap-2">
            <span className="mt-1.5 size-2 shrink-0 rounded-full bg-text-primary" aria-hidden="true" />
            <span className="min-w-0 text-sm text-text-secondary">
              {n.role && names[n.role] ? `${names[n.role]}: ` : ""}
              {n.text}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
