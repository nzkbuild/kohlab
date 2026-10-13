import { lazy, Suspense, startTransition, useEffect, useOptimistic, useState } from "react";
import {
  ArrowsClockwise,
  ChatCircleDots,
  DotsThree,
  Files,
  GitDiff,
  Ghost,
  List,
  Play,
  PencilSimple,
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
import { useApp, useCan } from "../store";
import type { WorkspaceTab } from "../lib/route";
import { workspaceStatus } from "../lib/status";
import { projectTitle } from "../lib/format";
import { cn } from "../lib/utils";
import BrowseView from "./BrowseView";
import ConfirmDialog from "./ConfirmDialog";
import { RenameDialog } from "./Sidebar";
import ErrorBoundary from "./ErrorBoundary";
import LogView from "./LogView";
import { disposeWorkspaceTerminals } from "./terminalCache";
import { Button, EmptyState, Menu, MenuItem, SkeletonRows, StatusChip, Tab, TabList, TabPanel, Tabs } from "./ui";
import { copyText } from "../lib/clipboard";

// xterm (~390 KB) and Monaco must not load before the cockpit does: only an
// import through lazy() defers the fetch. A static import here: even one that
// only wants a helper: would pull the whole chunk into first paint.
const TerminalView = lazy(() => import("./TerminalView"));
const ChatView = lazy(() => import("./ChatView"));
const DiffView = lazy(() => import("./DiffView"));

type TabId = WorkspaceTab;

const TABS: { id: TabId; label: string; icon: typeof Terminal }[] = [
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "files", label: "Files", icon: Files },
  { id: "review", label: "Changes", icon: GitDiff },
  { id: "log", label: "Log", icon: Scroll },
];

/** Simple mode: the agent and the changes, nothing else. */
const SIMPLE_TABS = TABS.filter(({ id }) => id === "terminal" || id === "review").map((t) =>
  t.id === "terminal" ? { ...t, label: "Claude" } : t,
);

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
  const setNavOpen = useApp((s) => s.setNavOpen);
  const route = useApp((s) => s.route);
  const advanced = useApp((s) => s.advanced);
  const can = useCan();
  const visibleTabs = advanced ? TABS : SIMPLE_TABS;

  // The pane lives in the URL (/w/:id/review), so a refresh, a shared link or
  // Back returns to it. Switching panes replaces the entry rather than pushing
  // one per click.
  const routeTab = route.kind === "workspace" ? route.tab : undefined;
  const setTab = (next: TabId) => navigate({ kind: "workspace", id: workspaceId, tab: next }, { replace: true });
  const [installedAgents, setInstalledAgents] = useState<string[]>([]);
  useEffect(() => {
    api.agentsStatus().then((st) => setInstalledAgents(Object.keys(st).filter((n) => st[n])), () => {});
  }, []);
  const [terminals, setTerminals] = useState([{ id: "main", label: "agent" }]);
  const [activeTerminal, setActiveTerminal] = useState("main");
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const [reviewCount, setReviewCount] = useState(0);

  const w = workspaces.find((x) => x.id === workspaceId);
  // A chat workspace drives the AI through a conversation: its "terminal" pane is the chat.
  const chat = w?.chat === true;

  // Lifecycle toggles are bounded single-object mutations, so they may show
  // their outcome before the server confirms it. Deleting and committing never do.
  const [optimisticRunning, setOptimisticRunning] = useOptimistic(w?.running ?? false);

  // Home's "open… > Terminal in" lands here: open one fresh shell, once.
  const openShell = useApp((s) => s.openShell);
  const setOpenShell = useApp((s) => s.setOpenShell);
  useEffect(() => {
    if (openShell !== workspaceId) return;
    setOpenShell(null);
    const id = `shell-${Date.now()}`;
    setTerminals((items) => [...items, { id, label: `shell ${items.length}` }]);
    setActiveTerminal(id);
  }, [openShell, workspaceId, setOpenShell]);

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
      await copyText(link);
      toast.success("share link copied");
      announce(`share link copied for ${workspaceId}`);
    } catch (e) {
      toast.error(`could not copy the link, ${(e as Error).message}`);
    }
  };

  const onDelete = async () => {
    setDeleting(true);
    try {
      // Cached xterm buffers outlive their pane, so they are dropped explicitly
      //: the cache module is xterm-free, which is why this stays a static import.
      disposeWorkspaceTerminals(workspaceId);
      await toastAction(workspaceId, "delete");
      await refresh();
      announce("Project deleted");
      setConfirming(false);
      navigate({ kind: "workspaces" });
    } catch (e) {
      toast.error(`delete failed, ${(e as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

  // The review badge has to be readable before the tab is opened, so the count
  // is fetched once per needs-review state: not polled.
  const needsReview = w !== undefined && workspaceStatus(w) === "needs-review";
  // Work waiting for a decision opens on that decision, not on a finished
  // terminal. The default is written into the URL once, so a workspace that
  // flips to needs-review while you watch it does not yank you off the terminal.
  // A hidden pane in the URL (files or log, while simple) falls back like no pane.
  const hiddenTab = !advanced && (routeTab === "files" || routeTab === "log");
  // A chat workspace opens on its chat even when it needs review; the review button is still there.
  const tab: TabId = (hiddenTab ? undefined : routeTab) ?? (needsReview && !chat ? "review" : "terminal");
  useEffect(() => {
    if (w && tab !== routeTab) setTab(tab);
  }, [w === undefined, routeTab]);
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
      if (Number.isInteger(index) && index >= 0 && index < visibleTabs.length) {
        e.preventDefault();
        setTab(visibleTabs[index].id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [workspaceId, advanced]);

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
            title="Project not found"
            description={`${workspaceId} is not on this server. It may have been deleted, or the link may be stale.`}
            action={
              <Button variant="primary" onClick={() => navigate({ kind: "workspaces" })}>
                Back to Home
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
  if (terminals.length > 1 && !chat) badges.terminal = { count: terminals.length, noun: "open terminals", chip: "chip-stopped" };
  if (reviewCount > 0)
    badges.review = { count: reviewCount, noun: reviewCount === 1 ? "changed file" : "changed files", chip: "chip-review" };

  // Terminal ids carry their kind (see spawnAgentSession): shell-<n> or agent-<name>-<n>.
  const addTerminal = (kind: "shell" | string) => {
    const id = kind === "shell" ? `shell-${Date.now()}` : `agent-${kind}-${Date.now()}`;
    setTerminals((items) => [...items, { id, label: kind === "shell" ? `shell ${items.length}` : kind }]);
    setActiveTerminal(id);
  };

  const closeTerminal = (id: string) => {
    setTerminals((items) => items.filter((item) => item.id !== id));
    if (activeTerminal === id) setActiveTerminal("main");
  };

  // One primary per state: a workspace waiting for review asks for a review,
  // not for its agent to be started again. The rest live in the overflow menu,
  // which also keeps the row inside a 320px viewport.
  // No primary button here: the one primary action of a chat lives in the chat.
  const actions = (
    <>
      {/* A chat has no start/stop of its own: the server's start is a no-op, and Stop lives inside the chat. */}
      {chat ? null : (
        <Button size="sm" variant={needsReview || running ? "secondary" : "primary"} className="max-md:min-h-11" onClick={() => run(running ? "stop" : "start")}>
          {running ? <Stop size={13} weight="fill" aria-hidden="true" /> : <Play size={13} weight="fill" aria-hidden="true" />}
          {running ? "stop" : "start"}
        </Button>
      )}
      <Menu
        label="More actions"
        trigger={
          <Button size="sm" variant="secondary" iconOnly className="max-md:size-11 max-md:border-transparent max-md:bg-transparent">
            <DotsThree size={16} weight="bold" />
          </Button>
        }
      >
        {chat ? null : (
          <MenuItem onSelect={() => run("restart")}>
            <ArrowsClockwise size={14} aria-hidden="true" />
            restart
          </MenuItem>
        )}
        {advanced ? (
          <MenuItem onSelect={() => void share()}>
            <ShareNetwork size={14} aria-hidden="true" />
            copy share link
          </MenuItem>
        ) : null}
        <MenuItem onSelect={() => setRenaming(true)}>
          <PencilSimple size={14} aria-hidden="true" />
          Rename
        </MenuItem>
        <MenuItem tone="danger" onSelect={() => setConfirming(true)}>
          <Trash size={14} aria-hidden="true" />
          Delete project…
        </MenuItem>
      </Menu>
    </>
  );

  return (
    <div className="cockpit max-md:overflow-hidden">
      {/* On a phone this is the only top bar of the project page: menu, title, status, and the ⋯ menu in one 52px row. */}
      <header className="cockpit-head max-md:!gap-1 max-md:!px-1 max-md:!py-0 max-md:pt-[var(--safe-top,env(safe-area-inset-top))]">
        <div className="flex min-w-0 flex-1 items-center gap-2 max-md:h-13 max-md:gap-1">
          <Button variant="quiet" iconOnly aria-label="Open menu" title="Menu" className="shell:hidden size-11 shrink-0" onClick={() => setNavOpen(true)}>
            <List size={20} aria-hidden="true" />
          </Button>
          <h1 className="m-0 min-w-0 truncate text-base font-semibold text-text-primary">{projectTitle(w)}</h1>
          <StatusChip status={st} />
        </div>

        {can.mutate ? (
          <div className="flex shrink-0 items-center gap-1.5 max-md:gap-1">{actions}</div>
        ) : (
          <span className="chip chip-stopped" title="You can look at this project but not change it.">
            View only
          </span>
        )}
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className="flex min-h-0 flex-1 flex-col">
      <TabList label="Project tabs">
        {visibleTabs.map(({ id, label, icon: Icon }) => {
          const badge = badges[id];
          const TabIcon = chat && id === "terminal" ? ChatCircleDots : Icon;
          return (
            <Tab key={id} value={id} aria-label={badge ? `${label}, ${badge.count} ${badge.noun}` : undefined}>
              <TabIcon size={14} aria-hidden="true" />
              {chat && id === "terminal" ? "Chat" : label}
              {badge ? (
                <span className={cn("chip", badge.chip, "tnum")} aria-hidden="true">
                  {badge.count}
                </span>
              ) : null}
            </Tab>
          );
        })}
      </TabList>

      {tab === "terminal" && !chat ? (
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
                    <X size={13} />
                  </Button>
                ) : null}
              </span>
            );
          })}
          {advanced && !chat ? (
            <Menu
              label="new terminal"
              trigger={
                <Button variant="quiet" size="sm" title="Open another terminal in this project's folder">
                  <Plus size={13} aria-hidden="true" />
                  new
                </Button>
              }
            >
              <MenuItem onSelect={() => addTerminal("shell")}>
                <Terminal size={14} aria-hidden="true" />
                plain shell
              </MenuItem>
              {installedAgents.map((name) => (
                <MenuItem key={name} onSelect={() => addTerminal(name)}>
                  <Play size={14} aria-hidden="true" />
                  {name}
                </MenuItem>
              ))}
            </Menu>
          ) : null}
        </div>
      ) : null}

      <div className="cockpit-body">
        <TabPanel value="terminal" className="flex h-full min-h-0 flex-col" tabIndex={-1}>
          <ErrorBoundary label="Terminal">
            <Suspense fallback={<SkeletonRows rows={8} className="p-4" />}>
              {tab === "terminal" && chat ? <ChatView key={workspaceId} workspaceId={workspaceId} /> : null}
              {tab === "terminal" && !chat ? (
                <>
                  {/* The terminal is mounted even when the workspace is not
                      running, because the daemon retains the final screen of a
                      finished session, replacing it with a notice would throw
                      away the only surviving record of what the agent did. */}
                  {running || activeTerminal !== "main" ? null : (
                    <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle bg-surface-raised px-3 py-1.5">
                      <Play size={13} className="shrink-0 text-text-muted" aria-hidden="true" />
                      <span className="min-w-0 flex-1 text-xs text-text-muted">
                        {can.mutate
                          ? `Claude stopped, showing the last screen. Restart it${advanced ? ", or open a shell" : ""}.`
                          : "Not running, showing the last screen."}
                      </span>
                      {can.mutate ? (
                        <Button variant="secondary" size="sm" onClick={() => run("start")}>
                          restart agent
                        </Button>
                      ) : null}
                      {can.mutate && advanced ? (
                        <Button variant="secondary" size="sm" onClick={() => addTerminal("shell")}>
                          open shell
                        </Button>
                      ) : null}
                    </div>
                  )}
                  <div className="min-h-0 flex-1">
                    <TerminalView
                      key={`${workspaceId}:${activeTerminal}`}
                      workspaceId={workspaceId}
                      terminalId={activeTerminal}
                      onExit={activeTerminal === "main" ? undefined : () => closeTerminal(activeTerminal)}
                    />
                  </div>
                </>
              ) : null}
            </Suspense>
          </ErrorBoundary>
        </TabPanel>

        {advanced ? (
          <TabPanel value="files" className="h-full min-h-0" tabIndex={-1}>
            <ErrorBoundary label="Files">
              {tab === "files" ? <BrowseView workspaceId={workspaceId} /> : null}
            </ErrorBoundary>
          </TabPanel>
        ) : null}

        <TabPanel value="review" className="h-full min-h-0" tabIndex={-1}>
          <ErrorBoundary label="Review">
            <Suspense fallback={<SkeletonRows rows={6} className="p-4" />}>
              {tab === "review" ? <DiffView key={workspaceId} workspaceId={workspaceId} simple={chat} /> : null}
            </Suspense>
          </ErrorBoundary>
        </TabPanel>

        {advanced ? (
          <TabPanel value="log" className="h-full min-h-0" tabIndex={-1}>
            <ErrorBoundary label="Log">
              {tab === "log" ? <LogView key={workspaceId} workspaceId={workspaceId} /> : null}
            </ErrorBoundary>
          </TabPanel>
        ) : null}
      </div>
      </Tabs>

      <RenameDialog id={workspaceId} shown={projectTitle(w)} open={renaming} onOpenChange={setRenaming} />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete this project?"
        description="Its files and chat are removed from the server."
        confirmLabel="Delete project"
        busy={deleting}
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
