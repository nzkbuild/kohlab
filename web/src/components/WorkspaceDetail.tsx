import { lazy, Suspense, startTransition, useEffect, useOptimistic, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowsClockwise,
  Browser,
  Check,
  ChatCircle,
  CaretDown,
  Copy,
  CaretLeft,
  DownloadSimple,
  Ghost,
  List,
  NotePencil,
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
import { projectTitle, relativeTime } from "../lib/format";
import { canContinue, copyProject, switchConversation } from "../lib/projectActions";
import { agentName, isAiAgent } from "../lib/agentName";
import { isTouchOnly } from "../lib/platform";
import { cn } from "../lib/utils";
import { useDragSize } from "../lib/useDragSize";
import ConfirmDialog from "./ConfirmDialog";
/** Shown while a terminal project's chat still runs background work: the server refuses to start the terminal then. */
const BACKGROUND_WAIT_LINE = "Claude is still finishing work in the background. The terminal opens when it's done.";
import { RenameDialog } from "./Sidebar";
import ErrorBoundary from "./ErrorBoundary";
import PreviewPanel from "./PreviewPanel";
import { disposeWorkspaceTerminals } from "./terminalCache";
import {
  Button,
  EmptyState,
  Menu,
  MenuItem,
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

/** Which view a terminal project's Claude shows: its conversation as a chat, or the terminal. Remembered per project. */
type ClaudeView = "chat" | "terminal";
const claudeViewKey = (id: string) => `kohlab.claudeView.${id}`;
// localStorage can throw (private mode, storage disabled): the view then just is not remembered.
function readClaudeView(id: string): ClaudeView {
  try {
    return localStorage.getItem(claudeViewKey(id)) === "terminal" ? "terminal" : "chat";
  } catch {
    return "chat";
  }
}
function writeClaudeView(id: string, view: ClaudeView) {
  try {
    localStorage.setItem(claudeViewKey(id), view);
  } catch {
    /* storage disabled: nothing to keep */
  }
}
// Once Changes code has been fetched (it is, shortly after the tab exists), render it directly: a lazy component always
// suspends once, and React holds a revealed fallback for 300 ms, which was most of the wait to see the changes.
let diffViewLoaded: typeof import("./DiffView").default | null = null;
const loadDiffView = () => import("./DiffView").then((m) => ((diffViewLoaded = m.default), m));
const DiffViewLazy = lazy(loadDiffView);
function DiffView(props: { workspaceId: string; simple: boolean }) {
  const Loaded = diffViewLoaded;
  return Loaded ? <Loaded {...props} /> : <DiffViewLazy {...props} />;
}
const FilesView = lazy(() => import("./FilesView"));
const BrainView = lazy(() => import("./BrainView"));

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

/** The Conversations submenu: a new conversation, or an earlier one of this project. Loads when it opens. */
function ConversationItems({ workspaceId, onSwitched }: { workspaceId: string; onSwitched: () => void }) {
  const [list, setList] = useState<{ current: string | null; sessions: { id: string; title: string; at: number }[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .chatSessions(workspaceId)
      .then((r) => {
        if (live) setList(r);
      })
      .catch((e: Error) => {
        if (live) setFailed(e.message);
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const pick = async (sid: string | null) => {
    try {
      await switchConversation(workspaceId, sid);
      onSwitched();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (failed) return <MenuItem disabled>{failed}</MenuItem>;
  if (!list) return <MenuItem disabled>Loading…</MenuItem>;
  return (
    <>
      <MenuItem onSelect={() => void pick(null)}>
        <Plus size={16} aria-hidden="true" />
        New conversation
      </MenuItem>
      {list.sessions.length ? <MenuSeparator /> : null}
      {list.sessions.map((s) => {
        const current = s.id === list.current;
        return (
          <MenuItem key={s.id} disabled={current} onSelect={() => void pick(s.id)}>
            {current ? <Check size={14} aria-hidden="true" /> : <span className="w-3.5 shrink-0" aria-hidden="true" />}
            <span className="min-w-0 flex-1 truncate">{s.title}</span>
            <span className="shrink-0 text-xs text-text-faint">{relativeTime(s.at)}</span>
          </MenuItem>
        );
      })}
    </>
  );
}

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
  const setNotesFor = useApp((s) => s.setNotesFor);
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
  // An earlier version the preview should open on (from Changes, Look). A new object opens it again.
  const [openVersion, setOpenVersion] = useState<{ sha: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  // The Claude tab's view. Kept with the project id, so a change of project shows that project's own choice.
  const [claudeViewState, setClaudeViewState] = useState<{ id: string; view: ClaudeView }>(() => ({ id: workspaceId, view: readClaudeView(workspaceId) }));
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
  // A terminal project whose agent is Claude also has a chat view of its conversation.
  const claudeTerminal = !chat && w?.agent === "claude";
  // Names the AI in menus and copy; a plain terminal project says "the terminal" and "Restart" instead.
  const who = isAiAgent(w?.agent) ? agentName(w!.agent) : null;
  const claudeView = claudeViewState.id === workspaceId ? claudeViewState.view : readClaudeView(workspaceId);

  // Lifecycle toggles are bounded single-object mutations, so they may show
  // their outcome before the server confirms it. Deleting and committing never do.
  const [optimisticRunning, setOptimisticRunning] = useOptimistic(w?.running ?? false);

  const preview = async () => {
    setPreviewing(true);
    try {
      const { url } = await api.preview(workspaceId);
      setPane({ url, t: Date.now() });
      // The ready card in a chat listens for this, so it can point at the preview the person just opened.
      window.dispatchEvent(new CustomEvent("kohlab:preview-opened", { detail: { id: workspaceId } }));
    } catch (e) {
      toast.error(`Couldn't open the preview. ${(e as Error).message}`);
    } finally {
      setPreviewing(false);
    }
  };
  const reloadPane = () => setPane((p) => (p ? { ...p, t: Date.now() } : p));

  // Look at an earlier version (Changes): the preview opens, then shows that version in the shared browser.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ id?: string; version?: string }>).detail;
      if (!d || d.id !== workspaceId) return;
      if (d.version) setOpenVersion({ sha: d.version });
      void preview();
    };
    window.addEventListener("kohlab:open-preview", onOpen);
    return () => window.removeEventListener("kohlab:open-preview", onOpen);
  }, [workspaceId]);

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
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.focus());
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

  // A terminal project's Claude cannot start while the chat's Claude still runs background work. The terminal then waits for it.
  const [waitingBackground, setWaitingBackground] = useState(false);
  const backgroundBusy = w?.backgroundWork === true;
  const startClaudeTerminal = () => {
    startTransition(async () => {
      setOptimisticRunning(true);
      try {
        await api.action(workspaceId, "start");
        setWaitingBackground(false);
        await refresh();
        announce(`${workspaceId} ${ACTION_DONE.start ?? "started"}`);
      } catch (e) {
        const message = (e as Error).message;
        if (message.includes("still finishing work in the background")) setWaitingBackground(true);
        else {
          setWaitingBackground(false);
          toast.error(`Couldn't start the terminal. ${message}`);
        }
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
  // The old "terminal" tab id means the Claude view: the chat or the terminal, whichever was remembered.
  // A chat has no terminal tab, and a project without Claude has no chat tab.
  // A chat project has no Changes tab until it has changed a file: then a link to it falls back to the chat.
  const hasWork = !chat || reviewCount > 0 || w?.lastCommitAt !== undefined;
  const setHasWork = useApp((s) => s.setHasWork);
  useEffect(() => setHasWork(workspaceId, hasWork), [workspaceId, hasWork, setHasWork]);
  const showChanges = hasWork || routeTab === "review";
  // The Brain tab shows once the brain holds more than its seeded Goal (peek: looking never creates the vault),
  // or when a link or a recalled note asks for it. It is re-checked on a switch of tab, after a Keep and when the changed files change.
  const [brainFilled, setBrainFilled] = useState(false);
  const lastCommitAt = w?.lastCommitAt;
  useEffect(() => {
    setBrainFilled(false);
  }, [workspaceId]);
  useEffect(() => {
    if (!chat) return;
    let live = true;
    api.brain(workspaceId, true).then((g) => live && g.count > 1 && setBrainFilled(true), () => {});
    return () => {
      live = false;
    };
  }, [workspaceId, chat, routeTab, lastCommitAt, reviewCount]);
  const showBrain = chat && (brainFilled || routeTab === "brain");
  // Hover, focus or the start of a press on the Changes tab: the diff and versions are on their way before the click lands.
  const warmChanges = { onPointerEnter: () => api.prefetchChanges(workspaceId), onFocus: () => api.prefetchChanges(workspaceId), onPointerDown: () => api.prefetchChanges(workspaceId) };
  // Changes opens on a first paint, not a download: fetch its code as soon as the tab exists.
  useEffect(() => {
    if (showChanges) void loadDiffView();
  }, [showChanges]);
  // And when any project page opens, once the browser is idle: the first click on a cold browser then finds the code already there.
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((f: () => void) => window.setTimeout(f, 1500));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const h = idle(() => void loadDiffView());
    return () => cancel(h);
  }, []);
  const rawTab0: TabId = (hiddenTab ? undefined : routeTab) ?? (needsReview && !chat && !claudeTerminal ? "review" : "terminal");
  // The Brain tab is for chat projects only: a link to it on any other project falls back to the chat.
  const rawTab1: TabId = rawTab0 === "brain" && !showBrain ? "chat" : rawTab0;
  const rawTab: TabId = rawTab1 === "review" && !showChanges ? "chat" : rawTab1;
  const tab: TabId =
    rawTab === "terminal" && (chat || claudeTerminal)
      ? chat
        ? "chat"
        : claudeView
      : rawTab === "chat" && !chat && !claudeTerminal
        ? "terminal"
        : rawTab;
  useEffect(() => {
    if (w && tab !== routeTab) setTab(tab);
  }, [w === undefined, routeTab]);
  // The terminal opens by itself once the background work is done, while its view is open.
  useEffect(() => {
    if (waitingBackground && !backgroundBusy && tab === "terminal" && can.mutate) startClaudeTerminal();
  }, [waitingBackground, backgroundBusy, tab]);

  const tabs: { id: TabId; label: string }[] = [
    ...(chat || claudeTerminal ? [{ id: "chat" as const, label: "Chat" }] : []),
    ...(chat ? [] : [{ id: "terminal" as const, label: "Terminal" }]),
    ...(showChanges ? [{ id: "review" as const, label: "Changes" }] : []),
    ...(showBrain ? [{ id: "brain" as const, label: "Brain" }] : []),
    ...(powerTools ? [{ id: "files" as const, label: "Files" }] : []),
  ];

  // A chat project also needs the count: it decides whether the Changes tab and the header Preview exist.
  // It is read again when the project's state moves (a turn ends, a question comes or goes, a keep or an undo).
  // bumped when the chat reports a finished turn: the turn may have written the first file
  const [turnTick, setTurnTick] = useState(0);
  useEffect(() => {
    if (!needsReview && !chat) {
      setReviewCount(0);
      return;
    }
    let alive = true;
    api
      .diff(workspaceId)
      .then((files) => {
        if (!alive) return;
        setReviewCount(files.length);
        // The person is likely to open Changes next: start what it paints from.
        if (chat && files.length > 0) api.prefetchChanges(workspaceId);
      })
      .catch(() => {
        if (alive) setReviewCount(0);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, needsReview, chat, w?.lastCommitAt, w?.discardedAt, w?.running, w?.waiting, w?.stopped, turnTick]);

  // 1..n switch panes, `.` puts the cursor back in the terminal. Keys are left
  // alone while focus is in a text field or in the terminal itself.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextEntry(e.target)) return;
      if (e.key === ".") {
        e.preventDefault();
        goTo(chat ? "chat" : "terminal");
        setFocusTick((t) => t + 1);
        return;
      }
      const index = Number(e.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < tabs.length) {
        e.preventDefault();
        goTo(tabs[index].id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // The tab list depends on power tools and on chat, so the handler is rebound when either changes.
  }, [workspaceId, powerTools, chat, claudeTerminal, showChanges]);

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

  // The chat is shown when the preview sends a picture or a point (assigned below, once the pane helpers exist). Hooks stay above the early returns.
  const showChatRef = useRef(() => {});
  useEffect(() => {
    const onShow = (e: Event) => {
      if ((e as CustomEvent<{ id?: string }>).detail?.id === workspaceId) showChatRef.current();
    };
    window.addEventListener("kohlab:show-chat", onShow);
    return () => window.removeEventListener("kohlab:show-chat", onShow);
  }, [workspaceId]);

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

  const pickClaudeView = (view: ClaudeView) => {
    setClaudeViewState({ id: workspaceId, view });
    writeClaudeView(workspaceId, view);
    // The chat moved the conversation on: Terminal resumes it there, once the chat's background work is done.
    if (view === "terminal" && w?.resumeInTerminal && can.mutate) {
      if (backgroundBusy) setWaitingBackground(true);
      else startClaudeTerminal();
    }
  };

  // Chat and Terminal remember the choice. Other tabs just switch.
  const goTo = (next: TabId) => {
    if (claudeTerminal && (next === "chat" || next === "terminal")) pickClaudeView(next);
    setTab(next);
  };

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
          className="inline-flex h-9 pointer-coarse:h-11 min-w-0 max-w-full items-center gap-2 rounded-row px-2.5 text-base font-medium text-text-primary hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <span className="min-w-0 truncate">{title}</span>
          <CaretDown size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
        </button>
      }
    >
      {(chat || claudeTerminal) && can.mutate ? (
        <>
          <MenuItem
            onSelect={() =>
              void switchConversation(workspaceId, null)
                .then(() => goTo("chat"))
                .catch((e: Error) => toast.error(e.message))
            }
          >
            <Plus size={16} aria-hidden="true" />
            New chat
          </MenuItem>
          <MenuSub label="Conversations" icon={<ChatCircle size={16} aria-hidden="true" />}>
            <ConversationItems workspaceId={workspaceId} onSwitched={() => goTo("chat")} />
          </MenuSub>
        </>
      ) : null}
      {chat && can.mutate ? (
        <MenuItem onSelect={() => setNotesFor(workspaceId)}>
          <NotePencil size={16} aria-hidden="true" />
          {`Notes for ${who ?? "the AI"}…`}
        </MenuItem>
      ) : null}
      <MenuItem onSelect={() => setRenaming(true)}>
        <PencilSimple size={16} aria-hidden="true" />
        Rename
      </MenuItem>
      {can.mutate && w ? (
        <MenuItem onSelect={() => void copyProject(w)}>
          <Copy size={16} aria-hidden="true" />
          Make a copy
        </MenuItem>
      ) : null}
      <MenuItem onSelect={() => void api.downloadProject(workspaceId, title).catch((e: Error) => toast.error(`Couldn't download the project. ${e.message}`))}>
        <DownloadSimple size={16} aria-hidden="true" />
        Download project
      </MenuItem>
      {/* A chat project's terminals are power tools: listed only once power tools are on. */}
      {!chat || powerTools ? (
        <MenuItem onSelect={() => openPanel()}>
          <Terminal size={14} aria-hidden="true" />
          <span className="flex-1">Open terminal</span>
          {isTouchOnly() ? null : <span className="whitespace-nowrap text-xs text-text-faint">Ctrl `</span>}
        </MenuItem>
      ) : null}
      {chat && w?.agent === "claude" && powerTools ? (
        <MenuItem
          disabled={!canContinue(w)}
          title={canContinue(w) ? undefined : "Send Claude a message first, then you can continue it here."}
          onSelect={() => openPanel(true)}
        >
          <Terminal size={14} aria-hidden="true" />
          Continue in Claude's terminal
        </MenuItem>
      ) : null}
      {chat ? null : (
        <>
          <MenuSeparator />
          <MenuItem onSelect={() => run("restart")}>
            <ArrowsClockwise size={14} aria-hidden="true" />
            {who ? `Restart ${who}` : "Restart"}
          </MenuItem>
          {running ? (
            <MenuItem onSelect={() => run("stop")}>
              <Stop size={14} aria-hidden="true" />
              {who ? `Stop ${who}` : "Stop"}
            </MenuItem>
          ) : null}
        </>
      )}
      <MenuSeparator />
      <MenuItem tone="danger" onSelect={() => setConfirming(true)}>
        <Trash size={16} aria-hidden="true" />
        Delete project…
      </MenuItem>
    </Menu>
  );

  const paneOpen = wide && pane !== null;
  const sheetOpen = !wide && pane !== null;
  const closePreview = () => setPane(null);

  // A picture or a pointed-at element came from the preview while the chat was not showing: show the chat (on a phone, over the sheet) so it can take it.
  showChatRef.current = () => {
    goTo("chat");
    if (!wide) closePreview();
  };
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
                    "inline-flex h-8 items-center gap-2 rounded-lg px-2.5 text-sm whitespace-nowrap",
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
      <Tabs value={tab} onValueChange={(v) => goTo(v as TabId)} className="flex min-h-0 flex-1">
      <div className="@container flex min-w-0 min-h-0 flex-1 flex-col">
      {/* One 56px row per project: the title (its menu), the segmented switch centred, and Preview. The header reads the
          width of the content column (the @container on its parent), so with the preview pane open, or on a phone, the
          switch drops to its own centred row under the title and nothing overlaps. The title truncates. */}
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2 max-md:gap-x-1 max-md:px-1 max-md:pt-[var(--safe-top,env(safe-area-inset-top))] @min-[44rem]:h-14 @min-[44rem]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] @min-[44rem]:gap-y-0 @min-[44rem]:py-0">
        <div className="col-start-1 row-start-1 flex min-w-0 items-center justify-self-stretch gap-1 max-md:h-13">
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
          <h1 className="m-0 flex min-w-0 flex-1 text-base font-medium text-text-primary">
            {can.mutate ? projectMenu : <span className="min-w-0 truncate px-2.5">{title}</span>}
          </h1>
        </div>

        {/* A switch with one segment is a control with one choice: show it only when there is something to switch to. */}
        {tabs.length > 1 ? (
        <TabList
          label="Project views"
          className="col-span-2 col-start-1 row-start-2 w-full justify-self-center @min-[44rem]:col-span-1 @min-[44rem]:col-start-2 @min-[44rem]:row-start-1 @min-[44rem]:w-auto"
        >
          {tabs.map(({ id, label }) => {
            const badge = badges[id];
            return (
              <Tab
                key={id}
                value={id}
                aria-label={badge ? `${label}, ${badge.count} ${badge.noun}` : undefined}
                {...(id === "review" ? warmChanges : {})}
              >
                {label}
                {badge ? (
                  <span className="tnum text-text-muted" aria-hidden="true">
                    {badge.count}
                  </span>
                ) : null}
              </Tab>
            );
          })}
        </TabList>
        ) : null}

        <div className="col-start-2 row-start-1 flex shrink-0 items-center justify-self-end gap-2 max-md:h-13 @min-[44rem]:col-start-3">
          {/* Nothing to preview until the chat has changed a file. A pane that is already open keeps its button. */}
          {!chat || hasWork || paneOpen ? (
            <Button variant="quiet" aria-pressed={paneOpen} disabled={previewing} onClick={() => void preview()}>
              <Browser size={18} aria-hidden="true" />
              Preview
            </Button>
          ) : null}
          {can.mutate ? null : (
            <span className="chip chip-stopped" title="You can look at this project but not change it.">
              View only
            </span>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="cockpit-body min-w-0">
          {chat || claudeTerminal ? (
            <TabPanel value="chat" className="flex h-full min-h-0 flex-col" tabIndex={-1}>
              <ErrorBoundary label="Chat">
                <Suspense fallback={<SkeletonRows rows={4} className="p-4" />}>
                  <ChatView key={`${workspaceId}:${w?.chatReset ?? 0}`} workspaceId={workspaceId} onPreview={() => void preview()} previewing={previewing} previewOpen={paneOpen} onTurnEnd={() => { reloadPane(); setTurnTick((t) => t + 1); }} terminalProject={claudeTerminal} />
                </Suspense>
              </ErrorBoundary>
            </TabPanel>
          ) : null}

          <TabPanel value="terminal" className="flex h-full min-h-0 flex-col" tabIndex={-1}>
            <ErrorBoundary label="Terminal">
              <Suspense fallback={<SkeletonRows rows={4} className="p-4" />}>
                {!chat ? (
                  // The terminal is mounted even when the workspace is not
                  // running, because the daemon retains the final screen of a
                  // finished session, replacing it with a notice would throw
                  // away the only surviving record of what the agent did.
                  // The terminal sits in a calm dark panel, inset from the page edges and under the header.
                  <div className="mx-3 mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] bg-surface-terminal">
                    {running ? null : claudeTerminal && (backgroundBusy || waitingBackground) ? (
                      <div className="flex shrink-0 px-5 pt-3 text-sm text-text-muted">
                        <span>{BACKGROUND_WAIT_LINE}</span>
                      </div>
                    ) : (
                      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-3 text-sm text-text-muted">
                        <span className="min-w-0 flex-1">
                          {can.mutate ? `${who ?? "The terminal"} has stopped. This is the last thing it showed.` : "Not running, showing the last screen."}
                        </span>
                        {can.mutate ? (
                          <Button variant="secondary" size="sm" className="rounded-full" onClick={() => run("start")}>
                            {who ? `Restart ${who}` : "Restart"}
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

          {showBrain ? (
            <TabPanel value="brain" className="h-full min-h-0" tabIndex={-1}>
              <ErrorBoundary label="Brain">
                <Suspense fallback={<SkeletonRows rows={6} className="p-4" />}>
                  {tab === "brain" ? <BrainView workspaceId={workspaceId} /> : null}
                </Suspense>
              </ErrorBoundary>
            </TabPanel>
          ) : null}

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
          <PreviewPanel url={pane.url} t={pane.t} variant="pane" onReload={reloadPane} onClose={closePreview} onNewLink={(url) => setPane({ url, t: Date.now() })} version={openVersion} onShowChat={() => goTo("chat")} />
        </aside>
      ) : null}
      {sheetOpen && pane ? (
        <PreviewPanel url={pane.url} t={pane.t} variant="sheet" onReload={reloadPane} onClose={closePreview} onNewLink={(url) => setPane({ url, t: Date.now() })} version={openVersion} onShowChat={() => goTo("chat")} />
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
