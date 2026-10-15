import { lazy, Suspense, startTransition, useEffect, useOptimistic, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowsClockwise,
  Browser,
  CaretDown,
  CaretLeft,
  DownloadSimple,
  Ghost,
  List,
  PencilSimple,
  Plus,
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
import { canContinue, changeModel, modelOf, type ModelChoice } from "../lib/projectActions";
import { cn } from "../lib/utils";
import { useDragSize } from "../lib/useDragSize";
import ConfirmDialog from "./ConfirmDialog";
import { RenameDialog } from "./Sidebar";
import ErrorBoundary from "./ErrorBoundary";
import PreviewPanel from "./PreviewPanel";
import { disposeWorkspaceTerminals } from "./terminalCache";
import {
  Button,
  EmptyState,
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  SkeletonRows,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from "./ui";

// xterm (~390 KB) and Monaco must not load before the cockpit does: only an
// import through lazy() defers the fetch. A static import here: even one that
// only wants a helper: would pull the whole chunk into first paint.
const TerminalView = lazy(() => import("./TerminalView"));
const ChatView = lazy(() => import("./ChatView"));
const DiffView = lazy(() => import("./DiffView"));
const FilesView = lazy(() => import("./FilesView"));

type TabId = WorkspaceTab;

/** The shell breakpoint: the preview opens beside the project from here, as a sheet below it. */
const WIDE_QUERY = "(min-width: 56.25rem)";

/** Shell tabs are `shell-*` (a login shell in the project folder); the Claude tab is `resume-*`. */
const SHELL_PREFIX = "shell-";
const RESUME_PREFIX = "resume-";

/** Tab count badges, noun included so the tab's name reads as a sentence. */
interface Badge {
  count: number;
  noun: string;
}

interface Shell {
  id: string;
  label: string;
}

const ACTION_DONE: Record<string, string> = {
  start: "started",
  stop: "stopped",
  restart: "restarted",
  delete: "deleted",
};

const TEXT_ENTRY_TAGS: Record<string, true> = { INPUT: true, TEXTAREA: true, SELECT: true };

/** Focus is busy in a field or a live terminal: bare keys belong there, not to the page. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || TEXT_ENTRY_TAGS[target.tagName] === true || target.closest(".xterm") !== null;
}

export default function WorkspaceDetail({ workspaceId }: { workspaceId: string }) {
  const workspaces = useApp((s) => s.workspaces);
  const loading = useApp((s) => s.loading);
  const refresh = useApp((s) => s.refresh);
  const navigate = useApp((s) => s.navigate);
  const setNavOpen = useApp((s) => s.setNavOpen);
  const navIndex = useApp((s) => s.navIndex);
  const route = useApp((s) => s.route);
  const powerTools = useApp((s) => s.powerTools);
  const setPowerTools = useApp((s) => s.setPowerTools);
  const panelRequest = useApp((s) => s.panelRequest);
  const requestPanel = useApp((s) => s.requestPanel);
  const can = useCan();

  // The pane lives in the URL (/w/:id/review), so a refresh, a shared link or
  // Back returns to it. Switching panes replaces the entry rather than pushing
  // one per click.
  const routeTab = route.kind === "workspace" ? route.tab : undefined;
  const setTab = (next: TabId) => navigate({ kind: "workspace", id: workspaceId, tab: next }, { replace: true });
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const [reviewCount, setReviewCount] = useState(0);
  // The preview of a terminal project: the same pane the chat opens, beside the project when wide.
  const [pane, setPane] = useState<{ url: string; t: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  // The bottom terminal panel. Its tabs and size live as long as this page does; the page is keyed by project.
  const [panelOpen, setPanelOpen] = useState(false);
  // Both sizes are dragged by the person and kept per browser.
  const { size: paneSize, handleProps: paneHandle } = useDragSize("kohlab_preview_width", 520, 360, () => window.innerWidth - 480, "left");
  const { size: panelSize, handleProps: panelHandle } = useDragSize("kohlab_panel_height", 300, 140, () => window.innerHeight - 200, "top");
  const [shells, setShells] = useState<Shell[]>([]);
  const [activeShell, setActiveShell] = useState("");
  const shellSeq = useRef(0);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const w = workspaces.find((x) => x.id === workspaceId);
  // A chat workspace drives the AI through a conversation: its "terminal" pane is the chat.
  const chat = w?.chat === true;

  // Lifecycle toggles are bounded single-object mutations, so they may show
  // their outcome before the server confirms it. Deleting and committing never do.
  const [optimisticRunning, setOptimisticRunning] = useOptimistic(w?.running ?? false);

  const preview = async () => {
    setPreviewing(true);
    try {
      const { url } = await api.preview(workspaceId);
      setPane({ url, t: Date.now() });
    } catch (e) {
      toast.error(`Could not open the preview, ${(e as Error).message}`);
    } finally {
      setPreviewing(false);
    }
  };
  const reloadPane = () => setPane((p) => (p ? { ...p, t: Date.now() } : p));

  const addShell = () => {
    shellSeq.current += 1;
    const id = `${SHELL_PREFIX}${Date.now()}`;
    setShells((items) => [...items, { id, label: `Terminal ${shellSeq.current}` }]);
    setActiveShell(id);
  };

  // Opening the panel is the first use of power tools, so the Files tab appears from here on.
  const openPanel = (resume = false) => {
    setPowerTools(true);
    setPanelOpen(true);
    if (resume) {
      const existing = shells.find((s) => s.id.startsWith(RESUME_PREFIX));
      if (existing) {
        setActiveShell(existing.id);
        return;
      }
      const id = `${RESUME_PREFIX}${Date.now()}`;
      setShells((items) => [...items, { id, label: "Claude" }]);
      setActiveShell(id);
      return;
    }
    if (shells.length === 0) addShell();
  };

  // Closing a tab ends its shell on the server too.
  const closeShell = (id: string) => {
    void api.closeTerminal(workspaceId, id).catch(() => {});
    const rest = shells.filter((s) => s.id !== id);
    setShells(rest);
    if (rest.length === 0) setPanelOpen(false);
    else if (activeShell === id) setActiveShell(rest[rest.length - 1].id);
  };

  const togglePanel = () => {
    if (!panelOpen) {
      openPanel();
      return;
    }
    // Closing from inside the terminal would drop focus to the page body: send it to the chat composer instead.
    const inPanel = !!document.activeElement?.closest('[aria-label="Terminal panel"]');
    setPanelOpen(false);
    if (inPanel) {
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Claude"]')?.focus());
    }
  };
  // The window listener is bound once per project, so it reads the latest toggle through a ref.
  const togglePanelRef = useRef(togglePanel);
  togglePanelRef.current = togglePanel;

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
      toast.error(`Delete failed, ${(e as Error).message}`);
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
  // The Files pane is hidden while power tools are off, and falls back like no pane.
  const hiddenTab = routeTab === "files" && !powerTools;
  // A chat workspace opens on its chat even when it needs review; the review button is still there.
  const tab: TabId = (hiddenTab ? undefined : routeTab) ?? (needsReview && !chat ? "review" : "terminal");
  useEffect(() => {
    if (w && tab !== routeTab) setTab(tab);
  }, [w === undefined, routeTab]);

  const tabs: { id: TabId; label: string }[] = [
    { id: "terminal", label: chat ? "Chat" : "Claude" },
    { id: "review", label: "Changes" },
    ...(powerTools ? [{ id: "files" as const, label: "Files" }] : []),
  ];

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

  // 1..n switch panes, `.` puts the cursor back in the terminal. Keys are left
  // alone while focus is in a text field or in the terminal itself.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextEntry(e.target)) return;
      if (e.key === ".") {
        e.preventDefault();
        setTab("terminal");
        setFocusTick((t) => t + 1);
        return;
      }
      const index = Number(e.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < tabs.length) {
        e.preventDefault();
        setTab(tabs[index].id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // The tab list depends on power tools and on chat, so the handler is rebound when either changes.
  }, [workspaceId, powerTools, chat]);

  // Ctrl+` (and Ctrl+J, as in VS Code) open and close the terminal panel. Ctrl+`
  // works from anywhere; Ctrl+J stays out of fields and terminals, where it is a newline.
  const projectOpen = w !== undefined;
  useEffect(() => {
    if (!can.mutate || !projectOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.ctrlKey || e.metaKey || e.altKey) return;
      const backtick = e.key === "`" || e.code === "Backquote";
      if (!backtick && (e.key.toLowerCase() !== "j" || isTextEntry(e.target))) return;
      e.preventDefault();
      togglePanelRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [can.mutate, projectOpen]);

  // Command-palette actions for this project. Taken once, then cleared.
  useEffect(() => {
    if (!panelRequest || panelRequest.workspaceId !== workspaceId) return;
    requestPanel(null);
    switch (panelRequest.action) {
      case "terminal":
        if (can.mutate) openPanel();
        break;
      case "continue":
        if (can.mutate && canContinue(w)) openPanel(true);
        break;
      case "files":
        setPowerTools(true);
        setTab("files");
        break;
      case "changes":
        setTab("review");
        break;
      case "preview":
        void preview();
        break;
    }
  }, [panelRequest, workspaceId]);

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

  const running = optimisticRunning;
  const title = projectTitle(w);

  const badges: Partial<Record<TabId, Badge>> = {};
  if (reviewCount > 0) badges.review = { count: reviewCount, noun: reviewCount === 1 ? "changed file" : "changed files" };

  // The panel is for people who can change the project. Viewers never see it.
  const showPanel = can.mutate && panelOpen && shells.length > 0;
  const current = shells.find((s) => s.id === activeShell) ?? shells[0];

  // No primary button in the header: a terminal project's Claude is restarted or
  // stopped from the project menu, and a chat's one primary action lives in the chat.
  // A chat has no start/stop of its own: the server's start is a no-op, and Stop lives inside the chat.
  // The project name is the menu's trigger, so the menu is the title's own affordance.
  const projectMenu = (
    <Menu
      label={title}
      align="start"
      trigger={
        <button
          type="button"
          className="inline-flex h-9 min-w-0 max-w-full items-center gap-1.5 rounded-row px-2.5 text-[15px] font-medium text-text-primary hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <span className="min-w-0 truncate">{title}</span>
          <CaretDown size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
        </button>
      }
    >
      <MenuItem onSelect={() => setRenaming(true)}>
        <PencilSimple size={16} aria-hidden="true" />
        Rename
      </MenuItem>
      <MenuSub label="Model">
        <MenuRadioGroup value={modelOf(w)} onValueChange={(v) => void changeModel(w, v as ModelChoice)}>
          <MenuRadioItem value="opus">
            <span className="block">Opus 5.5</span>
            <span className="block text-xs text-text-muted">Most capable, uses your limit fastest</span>
          </MenuRadioItem>
          <MenuRadioItem value="sonnet">
            <span className="block">Sonnet 5.5</span>
            <span className="block text-xs text-text-muted">Good for most projects</span>
          </MenuRadioItem>
          <MenuRadioItem value="haiku">
            <span className="block">Haiku 5.5</span>
            <span className="block text-xs text-text-muted">Fastest, for small changes</span>
          </MenuRadioItem>
          <MenuSeparator />
          <MenuRadioItem value="default">Account default</MenuRadioItem>
        </MenuRadioGroup>
      </MenuSub>
      <MenuSeparator />
      <MenuItem onSelect={() => openPanel()}>
        <Terminal size={14} aria-hidden="true" />
        <span className="flex-1">Open terminal</span>
        <span className="text-xs text-text-faint">Ctrl `</span>
      </MenuItem>
      {chat ? (
        <MenuItem
          disabled={!canContinue(w)}
          title={canContinue(w) ? undefined : "Send Claude a message first, then you can continue it here."}
          onSelect={() => openPanel(true)}
        >
          <Terminal size={14} aria-hidden="true" />
          Continue in Claude's terminal
        </MenuItem>
      ) : null}
      <MenuItem onSelect={() => void api.download(workspaceId, "").catch((e: Error) => toast.error(`Could not download the project, ${e.message}`))}>
        <DownloadSimple size={16} aria-hidden="true" />
        Download project
      </MenuItem>
      <MenuSeparator />
      {chat ? null : (
        <>
          <MenuItem onSelect={() => run("restart")}>
            <ArrowsClockwise size={14} aria-hidden="true" />
            Restart Claude
          </MenuItem>
          {running ? (
            <MenuItem onSelect={() => run("stop")}>
              <Stop size={14} aria-hidden="true" />
              Stop Claude
            </MenuItem>
          ) : null}
        </>
      )}
      <MenuItem tone="danger" onSelect={() => setConfirming(true)}>
        <Trash size={16} aria-hidden="true" />
        Delete project…
      </MenuItem>
    </Menu>
  );

  const paneOpen = wide && pane !== null;
  const sheetOpen = !wide && pane !== null;
  const closePreview = () => setPane(null);

  // Docked on desktop, a full-screen sheet on a phone (Back closes it).
  const terminalPanel = showPanel ? (
    <section
      aria-label="Terminal panel"
      className={cn(
        "dark-pane flex min-h-0 flex-col overflow-hidden bg-surface-terminal",
        wide
          ? "relative mx-3 mb-2.5 shrink-0 rounded-[14px]"
          : "fixed inset-0 z-[var(--z-drawer)] pt-[var(--safe-top)] pb-[var(--safe-bottom)]",
      )}
      style={wide ? { height: panelSize } : undefined}
    >
      {wide ? <div {...panelHandle} aria-label="Resize terminal panel" className="resize-handle resize-handle-y" /> : null}
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1.5">
        {wide ? null : (
          <Button variant="quiet" size="sm" className="shrink-0" onClick={() => setPanelOpen(false)}>
            <CaretLeft size={14} aria-hidden="true" />
            Back
          </Button>
        )}
        <div role="group" aria-label="Terminals" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {shells.map((shell) => {
            const active = shell.id === current.id;
            return (
              <span
                key={shell.id}
                className={cn("flex shrink-0 items-center gap-0.5 rounded-lg pr-0.5", active && "bg-surface-active")}
              >
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => setActiveShell(shell.id)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm whitespace-nowrap",
                    active ? "text-text-primary" : "text-text-muted hover:text-text-primary",
                  )}
                >
                  {active ? <Terminal size={14} aria-hidden="true" /> : null}
                  {shell.label}
                </button>
                <Button variant="quiet" size="sm" iconOnly aria-label={`Close ${shell.label}`} onClick={() => closeShell(shell.id)}>
                  <X size={12} aria-hidden="true" />
                </Button>
              </span>
            );
          })}
        </div>
        <Button variant="quiet" size="sm" iconOnly aria-label="New terminal" onClick={() => addShell()}>
          <Plus size={14} aria-hidden="true" />
        </Button>
        {wide ? (
          <Button variant="quiet" size="sm" iconOnly aria-label="Close the terminal panel" onClick={() => setPanelOpen(false)}>
            <X size={14} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        <ErrorBoundary label="Terminal">
          <Suspense fallback={<SkeletonRows rows={3} className="p-4" />}>
            <TerminalView
              key={`${workspaceId}:${current.id}`}
              workspaceId={workspaceId}
              terminalId={current.id}
              onExit={() => closeShell(current.id)}
              autoFocus
            />
          </Suspense>
        </ErrorBoundary>
      </div>
    </section>
  ) : null;

  return (
    <div className="cockpit max-md:overflow-hidden">
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className="flex min-h-0 flex-1">
      <div className="flex min-w-0 min-h-0 flex-1 flex-col">
      {/* One 56px row per project: the title (its menu), the segmented switch centred, and Preview. On a phone the title row is 52px and the switch sits on its own row below. */}
      <header className="grid h-14 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-3 px-4 max-md:h-auto max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-1 max-md:px-1 max-md:pt-[var(--safe-top,env(safe-area-inset-top))]">
        <div className="flex min-w-0 items-center justify-self-start gap-1 max-md:h-13 max-md:w-full max-md:justify-self-stretch">
          {/* A project reached from Home or search has history behind it: Back, not the menu. */}
          {navIndex > 0 ? (
            <Button variant="quiet" iconOnly aria-label="Back" title="Back" className="shell:hidden size-11 shrink-0" onClick={() => history.back()}>
              <ArrowLeft size={20} aria-hidden="true" />
            </Button>
          ) : (
            <Button variant="quiet" iconOnly aria-label="Open menu" title="Menu" className="shell:hidden size-11 shrink-0" onClick={() => setNavOpen(true)}>
              <List size={20} aria-hidden="true" />
            </Button>
          )}
          <h1 className="m-0 flex min-w-0 text-[15px] font-medium text-text-primary">
            {can.mutate ? projectMenu : <span className="min-w-0 truncate px-2.5">{title}</span>}
          </h1>
        </div>

        <TabList label="Project views" className="max-md:col-span-2 max-md:row-start-2 max-md:mb-2 max-md:w-full">
          {tabs.map(({ id, label }) => {
            const badge = badges[id];
            return (
              <Tab key={id} value={id} aria-label={badge ? `${label}, ${badge.count} ${badge.noun}` : undefined}>
                {label}
                {badge ? (
                  <span className="tnum text-text-faint" aria-hidden="true">
                    {badge.count}
                  </span>
                ) : null}
              </Tab>
            );
          })}
        </TabList>

        <div className="flex shrink-0 items-center justify-self-end gap-1.5 max-md:h-13">
          <button
            type="button"
            aria-pressed={paneOpen}
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-2 rounded-row px-3 text-sm text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50",
              paneOpen && "bg-surface-active text-text-primary",
            )}
            disabled={previewing}
            onClick={() => void preview()}
          >
            <Browser size={18} aria-hidden="true" />
            Preview
          </button>
          {can.mutate ? null : (
            <span className="chip chip-stopped" title="You can look at this project but not change it.">
              View only
            </span>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="cockpit-body min-w-0">
          <TabPanel value="terminal" className="flex h-full min-h-0 flex-col" tabIndex={-1}>
            <ErrorBoundary label="Terminal">
              <Suspense fallback={<SkeletonRows rows={4} className="p-4" />}>
                {chat ? (
                  <ChatView key={workspaceId} workspaceId={workspaceId} onPreview={() => void preview()} previewing={previewing} previewOpen={paneOpen} onTurnEnd={reloadPane} />
                ) : null}
                {!chat ? (
                  // The terminal is mounted even when the workspace is not
                  // running, because the daemon retains the final screen of a
                  // finished session, replacing it with a notice would throw
                  // away the only surviving record of what the agent did.
                  // The terminal sits in a calm dark panel, inset from the page edges and under the header.
                  <div className="mx-3 mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] bg-surface-terminal">
                    {running ? null : (
                      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-3 text-sm text-text-muted">
                        <span className="min-w-0 flex-1">
                          {can.mutate ? "Claude has stopped. This is the last thing it showed." : "Not running, showing the last screen."}
                        </span>
                        {can.mutate ? (
                          <Button variant="secondary" size="sm" className="rounded-full" onClick={() => run("start")}>
                            Restart Claude
                          </Button>
                        ) : null}
                      </div>
                    )}
                    <div className="min-h-0 flex-1">
                      <TerminalView key={`${workspaceId}:main`} workspaceId={workspaceId} terminalId="main" />
                    </div>
                  </div>
                ) : null}
              </Suspense>
            </ErrorBoundary>
          </TabPanel>

          <TabPanel value="review" className="h-full min-h-0" tabIndex={-1}>
            <ErrorBoundary label="Review">
              <Suspense fallback={<SkeletonRows rows={6} className="p-4" />}>
                {tab === "review" ? <DiffView key={workspaceId} workspaceId={workspaceId} simple={chat} /> : null}
              </Suspense>
            </ErrorBoundary>
          </TabPanel>

          {powerTools ? (
            <TabPanel value="files" className="h-full min-h-0" tabIndex={-1}>
              <ErrorBoundary label="Files">
                <Suspense fallback={<SkeletonRows rows={6} className="p-4" />}>
                  {tab === "files" ? <FilesView workspaceId={workspaceId} /> : null}
                </Suspense>
              </ErrorBoundary>
            </TabPanel>
          ) : null}
        </div>
      </div>
      {terminalPanel}
      </div>
      {paneOpen && pane ? (
        <aside aria-label="Preview" className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-line-subtle bg-surface-raised" style={{ width: paneSize }}>
          <div {...paneHandle} aria-label="Resize preview" className="resize-handle resize-handle-x" />
          <PreviewPanel url={pane.url} t={pane.t} variant="pane" onReload={reloadPane} onClose={closePreview} onNewLink={(url) => setPane({ url, t: Date.now() })} />
        </aside>
      ) : null}
      {sheetOpen && pane ? (
        <PreviewPanel url={pane.url} t={pane.t} variant="sheet" onReload={reloadPane} onClose={closePreview} onNewLink={(url) => setPane({ url, t: Date.now() })} />
      ) : null}
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
