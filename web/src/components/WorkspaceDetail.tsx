import { lazy, Suspense, startTransition, useEffect, useOptimistic, useRef, useState } from "react";
import {
  ArrowsClockwise,
  Files,
  GitDiff,
  Ghost,
  Play,
  Plus,
  Scroll,
  ShareNetwork,
  Stop,
  Terminal,
  Trash,
  X,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../api";
import { toastAction } from "../lib/actions";
import { announce } from "../lib/announce";
import { useApp } from "../store";
import { workspaceStatus } from "../lib/status";
import { cn } from "../lib/utils";
import BrowseView from "./BrowseView";
import ConfirmDialog from "./ConfirmDialog";
import ErrorBoundary from "./ErrorBoundary";
import LogView from "./LogView";
import { disposeWorkspaceTerminals } from "./terminalCache";
import { Button, EmptyState, SkeletonRows, StatusChip } from "./ui";

// xterm (~390 KB) and Monaco must not load before the cockpit does: only an
// import through lazy() defers the fetch. A static import here — even one that
// only wants a helper — would pull the whole chunk into first paint.
const TerminalView = lazy(() => import("./TerminalView"));
const DiffView = lazy(() => import("./DiffView"));

type TabId = "terminal" | "files" | "review" | "log";

const TABS: { id: TabId; label: string; icon: typeof Terminal }[] = [
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "files", label: "Files", icon: Files },
  { id: "review", label: "Review", icon: GitDiff },
  { id: "log", label: "Log", icon: Scroll },
];

/** Tab count badges, noun included so the tab's name reads as a sentence. */
interface Badge {
  count: number;
  noun: string;
  chip: string;
}

const ACTION_DONE: Record<string, string> = {
  start: "started",
  stop: "stopped",
  restart: "restarted",
  delete: "deleted",
};

const TEXT_ENTRY_TAGS: Record<string, true> = { INPUT: true, TEXTAREA: true, SELECT: true };

export default function WorkspaceDetail({ workspaceId }: { workspaceId: string }) {
  const workspaces = useApp((s) => s.workspaces);
  const loading = useApp((s) => s.loading);
  const refresh = useApp((s) => s.refresh);
  const navigate = useApp((s) => s.navigate);

  const [tab, setTab] = useState<TabId>("terminal");
  const [terminals, setTerminals] = useState([{ id: "main", label: "agent" }]);
  const [activeTerminal, setActiveTerminal] = useState("main");
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const [reviewCount, setReviewCount] = useState(0);

  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const w = workspaces.find((x) => x.id === workspaceId);

  // Lifecycle toggles are bounded single-object mutations, so they may show
  // their outcome before the server confirms it. Deleting and committing never do.
  const [optimisticRunning, setOptimisticRunning] = useOptimistic(w?.running ?? false);

  const run = (action: string) => {
    startTransition(async () => {
      if (action === "start") setOptimisticRunning(true);
      if (action === "stop") setOptimisticRunning(false);
      try {
        await toastAction(workspaceId, action);
        await refresh();
        announce(`${workspaceId} ${ACTION_DONE[action] ?? action}`);
      } catch {
        announce(`${workspaceId} could not ${action}`);
      }
    });
  };

  const share = async () => {
    try {
      const s = await api.share(workspaceId);
      const link = `${location.origin}/?share=${s.share}`;
      await navigator.clipboard.writeText(link);
      toast.success("share link copied");
      announce(`share link copied for ${workspaceId}`);
    } catch (e) {
      toast.error(`could not copy the link — ${(e as Error).message}`);
    }
  };

  const onDelete = async () => {
    setDeleting(true);
    try {
      // Cached xterm buffers outlive their pane, so they are dropped explicitly
      // — the cache module is xterm-free, which is why this stays a static import.
      disposeWorkspaceTerminals(workspaceId);
      await toastAction(workspaceId, "delete");
      await refresh();
      announce(`${workspaceId} deleted`);
      setConfirming(false);
      navigate({ kind: "workspaces" });
    } catch (e) {
      toast.error(`delete failed — ${(e as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

  // The review badge has to be readable before the tab is opened, so the count
  // is fetched once per needs-review state — not polled.
  const needsReview = w !== undefined && workspaceStatus(w) === "needs-review";
  useEffect(() => {
    if (!needsReview) {
      setReviewCount(0);
      return;
    }
    let alive = true;
    api
      .diff(workspaceId)
      .then((files) => {
        if (alive) setReviewCount(files.length);
      })
      .catch(() => {
        if (alive) setReviewCount(0);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, needsReview, w?.lastCommitAt]);

  // 1..4 switch panes, `.` puts the cursor back in the terminal. Keys are left
  // alone while focus is in a text field or in the terminal itself.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target;
      // A real keydown always targets an element, but the guard must not be the
      // thing that throws if one ever targets the document.
      if (target instanceof HTMLElement && (target.isContentEditable || TEXT_ENTRY_TAGS[target.tagName] || target.closest(".xterm")))
        return;
      if (e.key === ".") {
        e.preventDefault();
        setTab("terminal");
        setFocusTick((t) => t + 1);
        return;
      }
      const index = Number(e.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < TABS.length) {
        e.preventDefault();
        setTab(TABS[index].id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // The terminal bundle may still be in flight on the first `.`, so the focus
  // request retries briefly instead of silently doing nothing.
  useEffect(() => {
    if (tab !== "terminal" || focusTick === 0) return;
    let alive = true;
    let tries = 0;
    let timer: number | undefined;
    const focus = () => {
      if (!alive) return;
      const input = document.querySelector<HTMLTextAreaElement>("[data-terminal-root] .xterm-helper-textarea");
      if (input) {
        input.focus();
        return;
      }
      if (++tries < 8) timer = window.setTimeout(focus, 60);
    };
    const raf = requestAnimationFrame(focus);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [tab, focusTick]);

  if (!w) {
    if (loading) {
      return (
        <div className="surface">
          <div className="surface-inner">
            <SkeletonRows rows={4} className="panel" />
          </div>
        </div>
      );
    }
    return (
      <div className="surface">
        <div className="surface-inner">
          <EmptyState
            icon={<Ghost size={18} />}
            title="Workspace not found"
            description={`${workspaceId} is not on this server. It may have been deleted, or the link may be stale.`}
            action={
              <Button variant="primary" onClick={() => navigate({ kind: "workspaces" })}>
                back to workspaces
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const st = workspaceStatus(w);
  const running = optimisticRunning;

  const badges: Partial<Record<TabId, Badge>> = {};
  if (terminals.length > 1) badges.terminal = { count: terminals.length, noun: "open terminals", chip: "chip-stopped" };
  if (reviewCount > 0)
    badges.review = { count: reviewCount, noun: reviewCount === 1 ? "changed file" : "changed files", chip: "chip-review" };

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = TABS.length - 1;
    const next =
      e.key === "ArrowRight" ? (index === last ? 0 : index + 1) : e.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  const closeTerminal = (id: string) => {
    setTerminals((items) => items.filter((item) => item.id !== id));
    if (activeTerminal === id) setActiveTerminal("main");
  };

  return (
    <div className="cockpit">
      <header className="cockpit-head flex-wrap">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            {/* The workspace id IS this route's page identity, so it carries the
                single <h1> rather than leaving the route headingless. */}
            <h1 className="mono m-0 shrink-0 text-base font-semibold text-text-primary">{w.id}</h1>
            <StatusChip status={st} />
            <span className="mono min-w-0 truncate text-2xs text-text-faint" title={w.path}>
              {w.path}
            </span>
          </div>
          <p className="min-w-0 truncate text-xs text-text-muted" title={w.task}>
            {w.task}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button size="sm" variant="primary" disabled={running} onClick={() => run("start")}>
            <Play size={12} weight="fill" aria-hidden="true" />
            start
          </Button>
          <Button size="sm" variant="secondary" disabled={!running} onClick={() => run("stop")}>
            <Stop size={12} weight="fill" aria-hidden="true" />
            stop
          </Button>
          <Button size="sm" variant="secondary" onClick={() => run("restart")}>
            <ArrowsClockwise size={12} aria-hidden="true" />
            restart
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void share()}>
            <ShareNetwork size={12} aria-hidden="true" />
            share
          </Button>
          <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
            <Trash size={12} aria-hidden="true" />
            delete
          </Button>
        </div>
      </header>

      <div className="tabstrip" role="tablist" aria-label="Workspace panes">
        {TABS.map(({ id, label, icon: Icon }, index) => {
          const selected = tab === id;
          const badge = badges[id];
          return (
            <button
              key={id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${id}`}
              aria-selected={selected}
              aria-controls={`panel-${id}`}
              aria-label={badge ? `${label} — ${badge.count} ${badge.noun}` : undefined}
              tabIndex={selected ? 0 : -1}
              className="tab"
              onClick={() => setTab(id)}
              onKeyDown={(e) => onTabKeyDown(e, index)}
            >
              <Icon size={14} aria-hidden="true" />
              {label}
              {badge ? (
                <span className={cn("chip", badge.chip, "tnum")} aria-hidden="true">
                  {badge.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {tab === "terminal" ? (
        <div className="flex items-center gap-1 overflow-x-auto px-2 py-1.5" role="group" aria-label="Terminal instances">
          {terminals.map((term) => {
            const active = activeTerminal === term.id;
            return (
              <span
                key={term.id}
                className={cn(
                  "flex items-center gap-0.5 rounded-md border px-0.5",
                  active ? "border-line-strong bg-surface-active" : "border-transparent",
                )}
              >
                <button
                  type="button"
                  className={cn("file-row border-0 bg-transparent", active ? "text-text-primary" : "text-text-muted")}
                  aria-pressed={active}
                  onClick={() => setActiveTerminal(term.id)}
                >
                  <Terminal size={12} aria-hidden="true" />
                  {term.label}
                </button>
                {term.id !== "main" ? (
                  <Button
                    variant="quiet"
                    size="sm"
                    iconOnly
                    aria-label={`Close terminal ${term.label}`}
                    onClick={() => closeTerminal(term.id)}
                  >
                    <X size={11} />
                  </Button>
                ) : null}
              </span>
            );
          })}
          <Button
            variant="quiet"
            size="sm"
            iconOnly
            aria-label="Open another terminal"
            onClick={() => {
              const id = `terminal-${Date.now()}`;
              setTerminals((items) => [...items, { id, label: `shell ${items.length}` }]);
              setActiveTerminal(id);
            }}
          >
            <Plus size={13} />
          </Button>
        </div>
      ) : null}

      <div className="cockpit-body">
        <section
          role="tabpanel"
          id="panel-terminal"
          aria-labelledby="tab-terminal"
          hidden={tab !== "terminal"}
          className="h-full min-h-0"
        >
          <ErrorBoundary label="Terminal">
            <Suspense fallback={<SkeletonRows rows={8} className="p-4" />}>
              {tab === "terminal" ? (
                running ? (
                  <TerminalView key={`${workspaceId}:${activeTerminal}`} workspaceId={workspaceId} terminalId={activeTerminal} />
                ) : (
                  /* Opening a finished workspace no longer relaunches its agent,
                     so say what to do rather than showing a blank terminal. */
                  <div className="grid h-full place-items-center p-6">
                    <EmptyState
                      icon={<Play size={18} />}
                      title="No live session"
                      description="This workspace is not running, so there is nothing to attach to. Starting it launches the agent again in its worktree."
                      action={
                        <Button variant="primary" size="sm" onClick={() => run("start")}>
                          <Play size={14} weight="fill" aria-hidden="true" />
                          start
                        </Button>
                      }
                    />
                  </div>
                )
              ) : null}
            </Suspense>
          </ErrorBoundary>
        </section>

        <section
          role="tabpanel"
          id="panel-files"
          aria-labelledby="tab-files"
          hidden={tab !== "files"}
          className="h-full min-h-0"
        >
          <ErrorBoundary label="Files">
            {tab === "files" ? <BrowseView workspaceId={workspaceId} /> : null}
          </ErrorBoundary>
        </section>

        <section
          role="tabpanel"
          id="panel-review"
          aria-labelledby="tab-review"
          hidden={tab !== "review"}
          className="h-full min-h-0"
        >
          <ErrorBoundary label="Review">
            <Suspense fallback={<SkeletonRows rows={6} className="p-4" />}>
              {tab === "review" ? <DiffView workspaceId={workspaceId} /> : null}
            </Suspense>
          </ErrorBoundary>
        </section>

        <section role="tabpanel" id="panel-log" aria-labelledby="tab-log" hidden={tab !== "log"} className="h-full min-h-0">
          <ErrorBoundary label="Log">
            {tab === "log" ? <LogView key={workspaceId} workspaceId={workspaceId} /> : null}
          </ErrorBoundary>
        </section>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${w.id}?`}
        description={`The worktree at ${w.path} and any uncommitted changes are removed. This cannot be undone.`}
        confirmLabel="delete workspace"
        busy={deleting}
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
