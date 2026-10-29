import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, type TeamAction, type TeamState } from "../api";
import { accountLabel } from "../lib/aiHub";
import { agentStripLine, budgetWord, defaultRole, eventTitle, isLive, LAND_LABEL, lastEventN, mergeEvents, pollDelay, primaryAction, roleStateText, teamWord, tasksLine } from "../lib/team";
import { useProviders } from "../lib/useProviders";
import { cn } from "../lib/utils";
import { useCan } from "../store";
import type { Team, TeamEvent, TeamRole } from "../team-types";
import ConfirmDialog from "./ConfirmDialog";
import ErrorBoundary from "./ErrorBoundary";
import { modelName } from "./ModelPicker";
import { RoleDialog, StartTeamDialog } from "./team/dialogs";
import { AgentCard, BudgetMeters, Board, Feed, NeedsYouList, OrgChart } from "./team/parts";
import { Button, EmptyState, SkeletonRows, Tab, TabList, Tabs } from "./ui";

const ChatView = lazy(() => import("./ChatView"));

type View = "board" | "team" | "activity";
const VIEWS: { id: View; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "team", label: "Team" },
  { id: "activity", label: "Activity" },
];

const errorText = (e: unknown): string => (e instanceof Error && e.message ? e.message : "Try again.");

/**
 * The Team tab. Desktop: the agents above the board on the left, the activity above the picked agent's own chat on the
 * right. A phone shows one of Board, Team or Activity, and an agent's chat opens as a full-height sheet. The team is read
 * again every 2 s while it works and every 10 s otherwise. Only the picked agent's chat is mounted.
 */
export default function TeamView({ workspaceId }: { workspaceId: string }) {
  const { mutate, own } = useCan();
  const { cards } = useProviders();
  const [data, setData] = useState<TeamState | null>(null);
  const dataRef = useRef<TeamState | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View>("team");
  const [picked, setPicked] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [starting, setStarting] = useState(false);
  const [changing, setChanging] = useState<string | null>(null);
  const [stopping, setStopping] = useState<{ role?: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Every read and every action lands here: the events merge into the feed, and a new team starts its feed over.
  const apply = useCallback((r: TeamState) => {
    const prev = dataRef.current;
    const next: TeamState = { team: r.team, events: mergeEvents(prev && prev.team?.id === r.team?.id ? prev.events : [], r.events) };
    dataRef.current = next;
    setData(next);
    setNow(Date.now());
  }, []);

  const team: Team | null = data?.team ?? null;
  const live = team ? isLive(team.status) : false;

  // Polling: the next read starts after the last event this view has, and the rhythm follows the team and the window.
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const tick = () => {
      api
        .team(workspaceId, lastEventN(dataRef.current?.events ?? []))
        .then(
          (r) => {
            if (!alive) return;
            apply(r);
            setFailed(false);
          },
          () => {
            if (alive) setFailed(true);
          },
        )
        .finally(() => {
          if (alive) timer = window.setTimeout(tick, pollDelay(document.visibilityState !== "hidden", live));
        });
    };
    tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [workspaceId, apply, live]);

  const retry = () => {
    api
      .team(workspaceId, lastEventN(dataRef.current?.events ?? []))
      .then((r) => {
        apply(r);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  };

  const act = async (body: TeamAction) => {
    try {
      apply(await api.teamAction(workspaceId, body));
    } catch (e) {
      toast.error(`Couldn't do that. ${errorText(e)}`);
    }
  };

  const roles = team?.roles ?? [];
  const names = Object.fromEntries(roles.map((r) => [r.id, r.name]));
  const selected = roles.find((r) => r.id === picked) ?? defaultRole(roles);
  const changingRole = roles.find((r) => r.id === changing);
  const events: TeamEvent[] = data?.events ?? [];
  const eventName = (e: TeamEvent) => eventTitle(e, names);

  // The run-strip line on each card: the AI, the account (the owner sees it), the model, the mode and the state.
  const claude = (cards ?? []).find((c) => c.id === "claude");
  const stripOf = (r: TeamRole) => {
    const account = claude?.accounts.find((a) => a.id === (r.account ?? "default"));
    return agentStripLine({
      account: claude && account ? accountLabel(claude, own, account) : null,
      model: r.model ? modelName(r.model) : null,
      mode: r.mode,
      state: roleStateText(r, now),
    });
  };
  const cardFor = (r: TeamRole) => (
    <AgentCard
      role={r}
      strip={stripOf(r)}
      selected={selected?.id === r.id}
      canChange={mutate}
      actions={{
        onSelect: () => {
          setPicked(r.id);
          setSheet(true);
        },
        onChange: () => setChanging(r.id),
        onPause: () => void act({ action: "pause", role: r.id }),
        onResume: () => void act({ action: "resume", role: r.id }),
        onStop: () => setStopping({ role: r.id }),
      }}
    />
  );

  const status = team?.status;
  const land = status !== undefined && primaryAction(status) === "land";
  const stoppable = status === "running" || status === "paused" || status === "awaiting_approval";
  const budgetNote = team ? budgetWord(team.budget, team.spent) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {data === null ? (
        failed ? (
          <EmptyState
            title="Can't read the team right now"
            description="Check your connection, then try again."
            action={
              <Button variant="secondary" onClick={retry}>
                Try again
              </Button>
            }
          />
        ) : (
          <SkeletonRows rows={4} className="p-4" />
        )
      ) : team === null ? (
        <EmptyState
          title="Work as a team"
          description={
            mutate
              ? "A Lead plans the work, Builders make the changes and a Reviewer checks them. You bring the result into your project when you are ready."
              : "Nobody has started a team on this project yet."
          }
          action={
            mutate ? (
              <Button variant="primary" onClick={() => setStarting(true)}>
                Start a team
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <header className="flex flex-col gap-3 px-4 pt-4 pb-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="line-clamp-2 text-base font-medium text-text-primary">{team.goal}</h2>
                <p className="text-sm text-text-secondary">{[teamWord(team.status), tasksLine(team.tasks), budgetNote].filter(Boolean).join(" · ")}</p>
              </div>
              {mutate ? (
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {land ? (
                    <Button variant="primary" onClick={() => void act({ action: "land" })}>
                      {LAND_LABEL}
                    </Button>
                  ) : null}
                  {status === "running" ? (
                    <Button variant="secondary" onClick={() => void act({ action: "pause" })}>
                      Pause
                    </Button>
                  ) : status === "paused" ? (
                    <Button variant="secondary" onClick={() => void act({ action: "resume" })}>
                      Resume
                    </Button>
                  ) : null}
                  {stoppable ? (
                    <Button variant="quiet" onClick={() => setStopping({})}>
                      Stop team
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="max-w-md">
              <BudgetMeters label="Team" budget={team.budget} spent={team.spent} />
            </div>
            <NeedsYouList items={team.needsYou} names={names} />
          </header>

          <Tabs value={view} onValueChange={(v) => setView(v as View)} className="px-4 shell:hidden">
            <TabList label="Team views" className="w-full">
              {VIEWS.map((v) => (
                <Tab key={v.id} value={v.id}>
                  {v.label}
                </Tab>
              ))}
            </TabList>
          </Tabs>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4 shell:grid shell:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] shell:overflow-hidden">
            <div className="flex min-h-0 min-w-0 flex-col gap-6 shell:overflow-y-auto">
              <div className={cn(view === "team" ? "block" : "hidden", "shell:block")}>
                <OrgChart roles={roles} render={cardFor} />
              </div>
              <div className={cn(view === "board" ? "block" : "hidden", "shell:block")}>
                <Board tasks={team.tasks} names={names} />
              </div>
            </div>

            <div className="flex min-h-0 min-w-0 flex-col gap-4">
              <div className={cn(view === "activity" ? "flex" : "hidden", "min-h-0 flex-col shell:flex shell:max-h-[40%]")}>
                <Feed events={events} title={eventName} />
              </div>
              {selected ? (
                <section
                  aria-label={`${selected.name}, its chat`}
                  className={cn(
                    sheet ? "fixed inset-0 z-[var(--z-drawer)] flex flex-col bg-surface-base" : "hidden",
                    "min-h-0 flex-1 flex-col shell:static shell:z-auto shell:flex",
                  )}
                >
                  <div className="flex shrink-0 items-center gap-2 px-2 pt-2 shell:px-0 shell:pt-0">
                    <Button variant="quiet" className="shell:hidden" onClick={() => setSheet(false)}>
                      <ArrowLeft size={16} aria-hidden="true" />
                      Back to team
                    </Button>
                    <h2 className="min-w-0 truncate px-2 text-sm font-medium text-text-primary">{selected.name}</h2>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col">
                    {selected.member ? (
                      <ErrorBoundary label="Agent">
                        <Suspense fallback={<SkeletonRows rows={4} className="p-4" />}>
                          <ChatView key={selected.member} compact workspaceId={selected.member} />
                        </Suspense>
                      </ErrorBoundary>
                    ) : (
                      <p className="p-4 text-sm text-text-muted">{`${selected.name} has not started. It starts when the team gives it work.`}</p>
                    )}
                  </div>
                </section>
              ) : null}
            </div>
          </div>
        </>
      )}

      <StartTeamDialog
        open={starting}
        onOpenChange={setStarting}
        workspaceId={workspaceId}
        onStarted={(r) => {
          dataRef.current = null;
          apply(r);
        }}
      />
      {changingRole ? (
        <RoleDialog
          open
          onOpenChange={(v) => !v && setChanging(null)}
          workspaceId={workspaceId}
          role={changingRole}
          owner={own}
          onChanged={apply}
        />
      ) : null}
      <ConfirmDialog
        open={stopping !== null}
        onOpenChange={(v) => !v && setStopping(null)}
        title={stopping?.role ? "Stop this agent?" : "Stop the team?"}
        description="Its agents stop. Nothing is brought into your project."
        confirmLabel="Stop"
        onConfirm={() => {
          const s = stopping;
          setStopping(null);
          void act(s?.role ? { action: "stop", role: s.role } : { action: "stop" });
        }}
      />
    </div>
  );
}
