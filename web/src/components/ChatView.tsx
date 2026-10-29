import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, Browser, Check, Paperclip, ShieldCheck, Stop, WarningCircle, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, type ChatUsage } from "../api";
import type { HelperNode, Pick } from "../types";
import { announce } from "../lib/announce";
import { splitAttached, pastedName, safeAttachName, withSuffix } from "../lib/attach";
import { chatShown, takeWaiting } from "../lib/toChat";
import { MAX_POINTS, composeSent, pointChipText, pointLine, splitPointed } from "../lib/point";
import { problemSummary } from "../lib/problemText";
import { askToFix, useProblems } from "../lib/problems";
import { BIG_PASTE, DRAFT_SAVE_MS, addSaved, readDraft, writeDraft } from "../lib/drafts";
import { isApple } from "../lib/platform";
import { copyText } from "../lib/clipboard";
import { findWorkspace, useApp, useCan } from "../store";
import { workspaceStatus } from "../lib/status";
import { cn } from "../lib/utils";
import { isPhone } from "../lib/viewport";
import { MODEL_LABEL, modelOf } from "../lib/projectActions";
import { agentName } from "../lib/agentName";
import ConfirmDialog from "./ConfirmDialog";
import { Composer, SaveLaterChip, SavedChip } from "./Composer";
import ModelPicker, { ClaudeModelChoices, ModelChoices, PickerBody, modelName, shortModel, type ModelInfo } from "./ModelPicker";
import RunPanel, { useRunInfo, useRunPanel } from "./RunPanel";
import RunStrip from "./RunStrip";
import { AccountChoices, EffortChoices, FULL_ACCESS_OWNER_ONLY, FullAccessDialog, ModeChoices } from "./AiMenus";
import { EFFORT_LABEL, MODE_LABEL, accountLabel, helpersWorkingText, noteLine } from "../lib/aiHub";
import { useProviders } from "../lib/useProviders";
import { Button, ComposerChip, Menu, MenuItem, MenuLabel, MenuSeparator, MenuSub } from "./ui";
import { ChatEvent, ToolEvent, AskEvent } from "./chat/types";
import { friendly, failed, workingLine, workedLine } from "./chat/text";
import { noteOf, isToolLine, mergeEvents, groupRows } from "./chat/events";
import { WorkspaceCtx, AgentCtx } from "./chat/contexts";
import { Prose } from "./chat/markdown";
import { CopyReply } from "./chat/copy";
import { pictureType, ProjectImage } from "./chat/media";
import { ToolRun, NoteLine, WorkingLine, Details } from "./chat/tools";
import { ASK_BUTTON, AnsweredAsk, QuestionCard, PlanCard, AnsweredGroup } from "./chat/ask-cards";
import { Todo, Checklist, BgTask, TaskList } from "./chat/checklist";
import { PickList } from "./chat/pick-list";
import { CommandInfo, COMPOSER_MARK, CommandChoices } from "./chat/commands";
import { MessageMenu } from "./chat/message-menu";
import { ChangesDialog } from "./chat/changes-dialog";
import { FreshDialog, HandoffCard } from "./chat/fresh-dialog";
import { CHECK_TEXT, READY_HINT_KEY, ReadyCard } from "./chat/ready";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const TOO_BIG = "That file is too big. Files up to 20 MB work.";

/** A file waiting in the composer. `path` is set once it is saved in the project, so a retry does not save it twice. */
interface Attachment {
  key: number;
  file: File;
  url: string | null;
  path?: string;
}

interface Props {
  workspaceId: string;
  onPreview?: () => void;
  previewing?: boolean;
  previewOpen?: boolean;
  /** Narrow dock (the Files view): full-width column, and no Keep/Preview/Undo row. */
  compact?: boolean;
  /** Called when Claude's turn ends, so an open preview can reload. */
  onTurnEnd?: () => void;
  /** A terminal project's Claude, shown as its chat: no Keep / Undo, since those would change the real project. */
  terminalProject?: boolean;
}

/** The note the server writes when the person Keeps a version (chat.ts's noteChat, via server.ts). */
const KEPT_NOTE = "Kept this version";

export default function ChatView({ workspaceId, onPreview, previewing = false, previewOpen = false, onTurnEnd, compact = false, terminalProject = false }: Props) {
  const refresh = useApp((s) => s.refresh);
  const workspaces = useApp((s) => s.workspaces);
  const can = useCan().mutate;
  // The agent this chat talks to. Claude's own features (Undo, background tasks, usage, mode, effort) show only for Claude.
  const agent = findWorkspace(workspaces, workspaceId)?.agent ?? "claude";
  const who = agentName(agent);
  const isClaude = agent === "claude";
  // The AI cards (account for the run strip, groups for the picker), and where the Run panel shows.
  const { cards: providerCards } = useProviders();
  const owner = useCan().own;
  const run = useRunPanel({ previewOpen, compact });
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [busy, setBusy] = useState(false);
  // When the current turn started (ms), whoever started it; background tasks still running; the model and mode the CLI reports.
  const [busySince, setBusySince] = useState<number | null>(null);
  // The same start on the server's clock (events carry server times): a user message after it is queued behind this turn.
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [tasks, setTasks] = useState<BgTask[]>([]);
  const background = isClaude ? tasks.length : 0;
  const [tasksOpen, setTasksOpen] = useState(false);
  // Claude's checklist (its TodoWrite list), and the helper agents it has running, by label.
  const [todos, setTodos] = useState<Todo[]>([]);
  const [helpers, setHelpers] = useState<string[]>([]);
  // The helpers as a tree (parents before children), the server's clock against this device's, and a fresh start waiting for idle.
  const [helperTree, setHelperTree] = useState<HelperNode[]>([]);
  const skewRef = useRef(0);
  const [freshPending, setFreshPending] = useState(false);
  // Continue fresh: the manual dialog, the banner's snooze (the percent it was dismissed at), and the switch while a save is in flight.
  const [freshOpen, setFreshOpen] = useState(false);
  const [bannerSnooze, setBannerSnooze] = useState<number | null>(null);
  const [autoFreshLocal, setAutoFreshLocal] = useState<boolean | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  // The CLI is retrying a request: which try, of how many. And the chat's usage, read when the last turn ended.
  const [retry, setRetry] = useState<{ attempt: number; max: number } | null>(null);
  const [usage, setUsage] = useState<ChatUsage | null>(null);
  const setUsageOpen = useApp((s) => s.setUsageOpen);
  const setChatContext = useApp((s) => s.setChatContext);
  // The Usage dialog shows this chat's context while the chat is open.
  const chatCtx = isClaude && usage?.context ? usage.context : null;
  useEffect(() => {
    setChatContext(chatCtx);
  }, [chatCtx, setChatContext]);
  useEffect(() => () => setChatContext(null), [setChatContext]);
  const [model, setModel] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  // The effort level set in this Claude, and what the CLI offers: slash commands and models.
  const [effort, setEffort] = useState<string | null>(null);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [commandsEnabled, setCommandsEnabled] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  // The model the next message alone will use ("Just for the next message…"); cleared when the AI or account changes or the message is sent.
  const [oneShot, setOneShot] = useState<{ model: string; label: string } | null>(null);
  // Full access waits for a yes before it is applied.
  const [fullAsk, setFullAsk] = useState(false);
  // Bumped after any change to the AI's settings, so the run info is read again.
  const [infoKick, setInfoKick] = useState(0);
  // The "/" menu: which command is highlighted, and whether Esc closed it for this text.
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashShut, setSlashShut] = useState(false);
  // The "@" menu: Esc closes it for this text.
  const [mentionShut, setMentionShut] = useState(false);
  // Edit and resend: the newest message being edited, and whether it has a checkpoint to go back to.
  const [editing, setEditing] = useState<{ n: number; tree: boolean } | null>(null);
  // Scrolled well up from the newest message: the "Scroll to latest" button shows.
  const [farFromEnd, setFarFromEnd] = useState(false);
  // Whether the project's terminal Claude is open: sending from here closes it.
  const [terminalOpen, setTerminalOpen] = useState(false);
  // Claude's reply as it is being written (streamed by the server, not yet an event).
  const [streamed, setStreamed] = useState("");
  const [kick, setKick] = useState(0);
  // The unsent text: restored for this chat, saved 300 ms after the last key.
  const [draft, setDraft] = useState(() => readDraft(workspaceId));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    const t = window.setTimeout(() => writeDraft(workspaceId, draft), DRAFT_SAVE_MS);
    return () => window.clearTimeout(t);
  }, [draft, workspaceId]);
  // Leaving the chat keeps what was typed, even inside that 300 ms.
  useEffect(() => () => writeDraft(workspaceId, draftRef.current), [workspaceId]);
  // Set by Ctrl/Cmd+Shift+V: the next paste is text, however big.
  const plainPaste = useRef(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [keeping, setKeeping] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  // Elements pointed at in the preview, waiting to be sent with the message (at most MAX_POINTS).
  const [points, setPoints] = useState<{ key: number; pick: Pick }[]>([]);
  const pointKey = useRef(0);
  // Problems with the page, read while the chat is open. A "Not now" hides the list until it changes.
  const { problems, key: problemKey, refresh: refreshProblems } = useProblems(workspaceId, can);
  const [problemHidden, setProblemHidden] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  useEffect(() => {
    try {
      setProblemHidden(localStorage.getItem(`kohlab:problem-hidden:${workspaceId}`));
    } catch {
      setProblemHidden(null);
    }
  }, [workspaceId]);
  const [uploading, setUploading] = useState(false);
  const attachKey = useRef(0);
  const attachRef = useRef(attachments);
  attachRef.current = attachments;
  const fileRef = useRef<HTMLInputElement>(null);
  // Release the preview links of files still in the composer when the chat closes.
  useEffect(() => () => attachRef.current.forEach((a) => a.url && URL.revokeObjectURL(a.url)), []);
  // iOS Safari does not shrink the layout viewport for the keyboard, so the composer
  // would sit under it. While the composer is focused on a phone, the chat is lifted by the keyboard's height.
  const [keyboard, setKeyboard] = useState(0);

  const afterRef = useRef(0);
  const primedRef = useRef(false);
  const openedRef = useRef(false);
  const announcedRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  // Stuck to the bottom: the chat follows new content until the person scrolls up themselves.
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const touchY = useRef(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Poll: 0.5 s while the AI is working, 1 s while it waits for an answer or background tasks run, 4 s otherwise. Paused while the
  // tab is hidden; `kick` restarts the loop at once (after a send or an answer).
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;

    const schedule = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void run(), ms);
    };

    const run = async () => {
      if (!alive || document.visibilityState === "hidden") return;
      try {
        const res = await api.chat(workspaceId, afterRef.current);
        if (!alive) return;
        const top = res.events.reduce((m, e) => Math.max(m, e.n), afterRef.current);
        afterRef.current = top;
        // The first load is history: it is not announced to a screen reader.
        if (!primedRef.current) {
          announcedRef.current = top;
          primedRef.current = true;
          // A brand-new chat has no history: the composer is where the user starts.
          if (res.events.length === 0) taRef.current?.focus();
        }
        if (res.events.length > 0) setEvents((prev) => mergeEvents(prev, res.events));
        setBusy(res.busy);
        // elapsed on the server's clock, moved onto this device's; kept steady across polls
        const start = res.busySince === null ? null : Date.now() - (res.now - res.busySince);
        setBusySince((prev) => (prev !== null && start !== null && Math.abs(prev - start) < 2000 ? prev : start));
        setTurnStartedAt(res.busySince);
        setTasks(res.tasks);
        // an older server sends no checklist or helpers
        setTodos(res.todos ?? []);
        setHelpers(res.helpers ?? []);
        setHelperTree(res.helperTree ?? []);
        setFreshPending(res.freshPending === true);
        skewRef.current = res.now - Date.now();
        setRetry(res.retry);
        setUsage(res.usage);
        setModel(res.model);
        setMode(res.mode);
        setWaiting(res.waiting);
        setEffort(res.effort);
        setCommands(res.commands);
        setCommandsEnabled(res.commandsEnabled);
        setModels(res.models);
        setStreamed(res.draft);
        setTerminalOpen(res.terminalOpen ?? false);
        schedule(res.busy ? 500 : res.waiting !== null || res.background > 0 ? 1000 : 4000);
      } catch {
        if (alive) schedule(4000);
      }
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      void run();
    };

    document.addEventListener("visibilitychange", onVisible);
    void run();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [workspaceId, kick]);

  const repoll = () => setKick((k) => k + 1);

  // The task list closes itself when the last task is gone.
  useEffect(() => {
    if (tasks.length === 0) setTasksOpen(false);
  }, [tasks.length]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const phone = window.matchMedia("(max-width: 767.98px)").matches;
      const hidden = Math.round(window.innerHeight - vv.height - vv.offsetTop);
      const lift = phone && document.activeElement === taRef.current && hidden > 80 ? hidden : 0;
      setKeyboard(lift);
      if (lift && stickRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  // A turn that just ended may have changed files: refresh so the Keep / Undo bar sees it,
  // and let the parent reload an open preview.
  const wasBusy = useRef(busy);
  const turnEndRef = useRef(onTurnEnd);
  turnEndRef.current = onTurnEnd;
  useEffect(() => {
    if (!busy) void refresh();
    if (wasBusy.current && !busy) {
      turnEndRef.current?.();
      refreshProblems();
    }
    wasBusy.current = busy;
  }, [busy, refresh, refreshProblems]);

  // The Preview counts as looked at once it has been opened since the last reply finished. The header's Preview says so with an event.
  const [previewSeen, setPreviewSeen] = useState(false);
  useEffect(() => {
    if (!busy) setPreviewSeen(false);
  }, [busy]);
  useEffect(() => {
    const opened = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (!id || id === workspaceId) setPreviewSeen(true);
    };
    window.addEventListener("kohlab:preview-opened", opened);
    return () => window.removeEventListener("kohlab:preview-opened", opened);
  }, [workspaceId]);
  // The first "Ready to check" card of the first visit carries a hint; it is never shown again after that.
  const [readyHint] = useState(() => {
    try {
      return localStorage.getItem(READY_HINT_KEY) === null;
    } catch {
      return false;
    }
  });

  // Announce new assistant text. Bursts are coalesced by announce() itself.
  useEffect(() => {
    for (const e of events) {
      if (e.kind === "assistant" && e.n > announcedRef.current) announce(e.text);
      else if (e.kind === "note" && e.until !== undefined && e.n > announcedRef.current) announce(noteLine(e.text, e.until));
    }
    announcedRef.current = Math.max(announcedRef.current, events.reduce((m, e) => Math.max(m, e.n), 0));
  }, [events]);

  const answers = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const e of events) if (e.kind === "answer") m.set(e.requestId, e.allow);
    return m;
  }, [events]);

  // What the person wrote back to a question or plan card, by request id.
  const replies = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) if (e.kind === "answer" && e.reply) m.set(e.requestId, e.reply);
    return m;
  }, [events]);

  // What each tool line gave back, by tool id: its output, and whether it failed.
  const results = useMemo(() => {
    const m = new Map<string, { output: string; failed?: boolean }>();
    for (const e of events) if (e.kind === "result") m.set(e.toolId, { output: e.output, failed: e.failed });
    return m;
  }, [events]);

  // The question Claude is waiting on right now, if the answer has not come back yet.
  const pendingAsk = useMemo(
    () => (waiting === null ? null : (events.find((e): e is AskEvent => e.kind === "ask" && e.requestId === waiting && !answers.has(waiting)) ?? null)),
    [events, waiting, answers],
  );

  const rows = useMemo(() => groupRows(events), [events]);

  // Work done before a pending question in the same turn is held back until the
  // question is answered, so a summary never reads as finished while Claude waits.
  const pendingN = pendingAsk?.n ?? Infinity;
  const lastUserN = Math.max(0, ...events.filter((e) => e.kind === "user" && e.n < pendingN).map((e) => e.n));
  const visibleRows = useMemo(
    () => (pendingAsk ? rows.filter((row) => !(isToolLine(row[0]) && row[0].n > lastUserN && row[0].n < pendingN)) : rows),
    [rows, lastUserN, pendingN, pendingAsk],
  );

  // Turns: each user message starts one; Claude's replies follow it.
  const turns = useMemo(() => {
    const out: ChatEvent[][][] = [];
    for (const row of visibleRows) {
      if (row[0].kind === "user" || out.length === 0) out.push([]);
      out[out.length - 1].push(row);
    }
    // Answered asks (and the tool runs between them) in one turn read as ONE row.
    // A question or plan card is never merged: it reads on its own.
    const isAnswered = (row: ChatEvent[]) => row.length === 1 && row[0].kind === "ask" && !row[0].form && answers.has(row[0].requestId);
    // The tool ran after its permission was answered, so its line comes after the ask in time. The answered ask moves up before the
    // run of tool lines just above it, so "You allowed ..." reads before the step it unlocked.
    const liftAnswered = (turn: ChatEvent[][]) => {
      const lifted: ChatEvent[][] = [];
      for (const row of turn) {
        if (!isAnswered(row)) {
          lifted.push(row);
          continue;
        }
        let k = lifted.length;
        while (k > 0 && isToolLine(lifted[k - 1][0])) k--;
        lifted.splice(k, 0, row);
      }
      return lifted;
    };
    return out.map((rawTurn) => {
      const turn = liftAnswered(rawTurn);
      const merged: ChatEvent[][] = [];
      for (let i = 0; i < turn.length; i++) {
        if (!isAnswered(turn[i])) {
          merged.push(turn[i]);
          continue;
        }
        let end = i;
        for (let j = i + 1; j < turn.length && (isAnswered(turn[j]) || isToolLine(turn[j][0])); j++) if (isAnswered(turn[j])) end = j;
        merged.push(turn.slice(i, end + 1).flat());
        i = end;
      }
      return merged;
    });
  }, [visibleRows, answers]);

  // Each turn's done line, by the message that starts the turn (0 for replies before any message).
  // A plan line that follows a done line is that turn's plan share (the server sends it once the usage is read).
  const doneByTurn = useMemo(() => {
    const m = new Map<number, Extract<ChatEvent, { kind: "done" }>>();
    let key = 0;
    let doneKey: number | null = null; // the turn of the latest done line (a new message may come before its plan line)
    for (const e of events) {
      if (e.kind === "user") key = e.n;
      else if (e.kind === "done") {
        m.set(key, e);
        doneKey = key;
      } else if (e.kind === "plan" && doneKey !== null) {
        const d = m.get(doneKey);
        if (d) m.set(doneKey, { ...d, planDelta: e.planDelta });
      }
    }
    return m;
  }, [events]);

  // Open at the very bottom, and keep new content in view while the reader is stuck there.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!openedRef.current) {
      if (events.length === 0) return;
      openedRef.current = true;
      stickRef.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [events, busy, waiting, streamed]);

  // Pictures, frames and images load after the text: as the column grows, a stuck reader stays at the bottom.
  useEffect(() => {
    const col = columnRef.current;
    const el = scrollRef.current;
    if (!col || !el) return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(col);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Moving up well above the end stops the following. Back at the end (or moved there by the app) it resumes.
    const up = el.scrollTop < lastTopRef.current - 1;
    lastTopRef.current = el.scrollTop;
    if (gap < 8) stickRef.current = true;
    else if (up && gap >= 80) stickRef.current = false;
    setFarFromEnd(gap >= 80 && !stickRef.current);
  };

  // A wheel, a swipe down or an arrow/page key up is the reader scrolling up: stop following at once.
  const scrollUp = () => {
    stickRef.current = false;
  };

  const scrollToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setFarFromEnd(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // Sends one message. Returns true when the server took it.
  const sendText = async (text: string, withModel?: string): Promise<boolean> => {
    setSending(true);
    setSendError(null);
    // Optimistic: Stop shows at once, not after the server answers. A failed send puts it back (below) and the poll corrects it.
    const wasBusy = busy;
    setBusy(true);
    try {
      await api.chatSend(workspaceId, text, withModel);
      if (withModel) setOneShot(null);
      stickRef.current = true;
      setFarFromEnd(false);
      return true;
    } catch (e) {
      // 409 "still working": Claude is busy, so the composer locks until it is not.
      setSendError(friendly(e));
      // Only "still working" means Claude is busy; any other failure (offline, refused) ran nothing, so Stop must not stay.
      setBusy(e instanceof Error && /still working/i.test(e.message) ? true : wasBusy);
      return false;
    } finally {
      setSending(false);
      repoll();
    }
  };

  /** Adds picked, pasted or dropped files to the composer, within the count and size limits. */
  const takeFiles = (list: FileList | File[], pasted = false) => {
    if (waiting !== null || sending || uploading) return;
    const picked = Array.from(list).map((f) => (pasted && !f.name ? new File([f], pastedName(f.type, Date.now()), { type: f.type }) : f));
    if (picked.length === 0) return;
    let note: string | null = null;
    const sized: File[] = [];
    for (const f of picked) {
      if (f.size > MAX_FILE_BYTES) note = TOO_BIG;
      else sized.push(f);
    }
    const room = Math.max(0, MAX_FILES - attachments.length);
    if (sized.length > room) note = `You can attach up to ${MAX_FILES} files at a time.`;
    const fits = sized.slice(0, room);
    setAttachNote(note);
    if (fits.length === 0) return;
    const next: Attachment[] = fits.map((file) => ({
      key: ++attachKey.current,
      file,
      url: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    }));
    setAttachments((prev) => [...prev, ...next]);
  };

  // A picture marked up in the preview arrives as a file for the composer. The ref keeps the newest takeFiles.
  const takeFilesRef = useRef(takeFiles);
  takeFilesRef.current = takeFiles;
  useEffect(() => {
    const onAttach = (e: Event) => {
      const d = (e as CustomEvent<{ id?: string; files?: File[] }>).detail;
      if (d?.files && d.id === workspaceId) takeFilesRef.current(d.files);
    };
    window.addEventListener("kohlab:attach", onAttach);
    return () => window.removeEventListener("kohlab:attach", onAttach);
  }, [workspaceId]);

  // An element pointed at in the preview becomes a chip above the box. Chips stop at MAX_POINTS.
  const addPickRef = useRef((_pick: Pick) => {});
  addPickRef.current = (pick) => {
    if (!can) return;
    if (points.length >= MAX_POINTS) {
      setAttachNote(`You can point at up to ${MAX_POINTS} things at a time.`);
      return;
    }
    setPoints((list) => [...list, { key: ++pointKey.current, pick }]);
  };
  useEffect(() => {
    const onPoint = (e: Event) => {
      const d = (e as CustomEvent<{ id?: string; pick?: Pick }>).detail;
      if (d?.pick && d.id === workspaceId) addPickRef.current(d.pick);
    };
    window.addEventListener("kohlab:point", onPoint);
    // Pictures and points sent while another tab was showing wait for this chat.
    const off = chatShown(workspaceId);
    for (const w of takeWaiting(workspaceId)) {
      const d = w.detail as { files?: File[]; pick?: Pick };
      if (w.name === "kohlab:attach" && d.files) takeFilesRef.current(d.files);
      else if (d.pick) addPickRef.current(d.pick);
    }
    return () => {
      off();
      window.removeEventListener("kohlab:point", onPoint);
    };
  }, [workspaceId]);

  const removeAttachment = (key: number) => {
    const gone = attachments.find((a) => a.key === key);
    if (gone?.url) URL.revokeObjectURL(gone.url);
    setAttachments((prev) => prev.filter((a) => a.key !== key));
    setAttachNote(null);
  };

  const clearAttachments = () => {
    attachments.forEach((a) => a.url && URL.revokeObjectURL(a.url));
    setAttachments([]);
    setAttachNote(null);
  };

  /** Saves each file that is not saved yet into uploads/, adding -2, -3 ... when the name is taken. Returns every saved path. */
  const uploadAll = async (): Promise<string[]> => {
    const paths: string[] = [];
    for (const a of attachments) {
      if (a.path) {
        paths.push(a.path);
        continue;
      }
      const base = safeAttachName(a.file.name);
      let saved: string | null = null;
      for (let i = 1; i <= 20 && saved === null; i++) {
        const res = await api.uploadFile(workspaceId, `uploads/${i === 1 ? base : withSuffix(base, i)}`, a.file);
        if (res.ok) saved = res.path;
      }
      if (saved === null) throw new Error(`Could not save ${a.file.name}. Try a shorter name.`);
      const done = saved;
      setAttachments((prev) => prev.map((x) => (x.key === a.key ? { ...x, path: done } : x)));
      paths.push(done);
    }
    return paths;
  };

  const send = async () => {
    const text = draft.trim();
    // While Claude works, a message is queued: the CLI runs it after the turn.
    if ((!text && attachments.length === 0 && points.length === 0) || waiting !== null || sending || uploading) return;
    let paths: string[] = [];
    if (attachments.length > 0) {
      setUploading(true);
      setSendError(null);
      try {
        paths = await uploadAll();
      } catch (e) {
        setSendError(friendly(e));
        return;
      } finally {
        setUploading(false);
      }
    }
    // Pointed-at lines sit after the text, and the Attached line stays last (splitAttached reads it there).
    const message = composeSent(text, points.map((p) => pointLine(p.pick)), paths);
    // Edit and resend: the message's files go back first (when it has a checkpoint), then the new text is sent as a normal message.
    if (editing?.tree) {
      try {
        await api.chatGoBack(workspaceId, editing.n);
      } catch (e) {
        setSendError(failed("go back", e));
        return;
      }
    }
    if (await sendText(message, oneShot?.model)) {
      setDraft("");
      clearAttachments();
      setPoints([]);
      setEditing(null);
    }
  };

  /** Copies a message's own text (its Attached line is not part of what the person wrote). */
  const copyMessage = async (text: string) => {
    try {
      await copyText(text);
      announce("Copied");
    } catch {
      toast.error("Could not copy");
    }
  };

  /** Edit and resend: the newest message goes into the box, and the line above the box says so until it is sent or cancelled. */
  const startEdit = (n: number, body: string, tree: boolean) => {
    setEditing({ n, tree });
    setDraft(body);
    focusEnd();
  };

  /** Puts the caret at the end of the box. Waits a frame, so a menu that just closed does not take focus back. */
  const focusEnd = () => {
    window.requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  // The "/" menu: while the text is a command name with no space yet, the commands that start with it.
  const slashQuery = commandsEnabled && draft.startsWith("/") && !/\s/.test(draft) ? draft.slice(1).toLowerCase() : null;
  const slashMatches = slashQuery === null || slashShut ? [] : commands.filter((c) => c.name.toLowerCase().startsWith(slashQuery));
  const slashOn = slashMatches.length > 0;
  // Typing "/" before the command list has loaded: a single row says so.
  const slashLoading = slashQuery !== null && !slashShut && commands.length === 0;
  const slashActive = Math.max(0, Math.min(slashIndex, slashMatches.length - 1));

  // The "@" menu: an "@" that starts a word at the end of the text, with no space after it yet. Files come from the CLI, 150 ms after the last key.
  // ponytail: only at the end of the text; a mention in the middle is typed as plain text. Upgrade path: read the caret position.
  const mentionMatch = /(?:^|\s)@(\S*)$/.exec(draft);
  const mentionQuery = mentionMatch && !slashOn && !mentionShut ? mentionMatch[1] : null;
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  useEffect(() => {
    if (mentionQuery === null) {
      setMentionFiles([]);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      api
        .chatControl(workspaceId, "files", mentionQuery)
        .then((r) => {
          if (!alive) return;
          setMentionFiles(r.files ?? []);
          setMentionIndex(0);
        })
        .catch(() => {
          if (alive) setMentionFiles([]);
        });
    }, 150);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [mentionQuery, workspaceId]);
  const mentionOn = mentionQuery !== null && mentionFiles.length > 0;
  const mentionActive = Math.max(0, Math.min(mentionIndex, mentionFiles.length - 1));

  /** Puts a picked file in the composer as "@path ", in place of the "@" being typed. */
  const pickFile = (path: string) => {
    setDraft((d) => d.replace(/@(\S*)$/, () => `@${path} `));
    setMentionFiles([]);
    taRef.current?.focus();
  };

  /** Puts a picked command in the composer, ready for its details. */
  const pickCommand = (c: CommandInfo) => {
    setDraft(`/${c.name} `);
    taRef.current?.focus();
  };

  /** The Commands chip's pick: "/name " goes at the start of the draft, and what was typed stays after it. */
  const insertCommand = (c: CommandInfo) => {
    setDraft(`/${c.name} ${draft.trimStart()}`);
    setSlashShut(false);
    focusEnd();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v") {
      plainPaste.current = true;
      window.setTimeout(() => {
        plainPaste.current = false;
      }, 1000);
    }
    // Ctrl/Cmd+Enter while the AI works: stop it and send this message now.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && working && draft.trim() !== "" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void sendNow();
      return;
    }
    if (mentionOn && !e.nativeEvent.isComposing) {
      const n = mentionFiles.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickFile(mentionFiles[mentionActive]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionShut(true);
        return;
      }
    }
    if (slashOn && !e.nativeEvent.isComposing) {
      const n = slashMatches.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickCommand(slashMatches[slashActive]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashShut(true);
        return;
      }
    }
  };

  const answer = async (requestId: string, allow: boolean, extra?: { answers?: Record<string, string>; message?: string; always?: boolean }) => {
    setAnswering(requestId);
    try {
      await api.chatAnswer(workspaceId, requestId, allow, extra);
      repoll();
    } catch (e) {
      toast.error(failed("answer", e));
    } finally {
      setAnswering(null);
    }
  };

  /** Stops the current turn. The chat stays open: the process is kept, so the next message needs no restart. */
  const stop = async () => {
    try {
      await api.chatControl(workspaceId, "interrupt", null);
      announce(`${who} stopped`);
    } catch {
      announce(`${who} could not stop`);
    } finally {
      repoll();
    }
  };

  const busyRef = useRef(busy);
  busyRef.current = busy;
  /** Send now: stop the turn, wait for it to end (10 s at most), then send. The server would queue it anyway after the timeout. */
  const sendingNow = useRef(false);
  const sendNow = async () => {
    const text = draft.trim();
    if (text === "" || sendingNow.current) return;
    sendingNow.current = true;
    try {
      await stop();
      const until = Date.now() + 10_000;
      while (busyRef.current && Date.now() < until) await new Promise((r) => window.setTimeout(r, 200));
      // The box changed meanwhile (Enter queued it, or it was edited): this send is stale, drop it.
      if (draftRef.current.trim() !== text) return;
      await send();
    } finally {
      sendingNow.current = false;
    }
  };

  /** Ctrl/Cmd+S and the Save button: the text goes to the saved list and the box clears. */
  const saveForLater = () => {
    const text = draft.trim();
    if (text === "") return;
    addSaved(text);
    setDraft("");
    announce("Saved for later");
    taRef.current?.focus();
  };

  /** A menu pick: shown at once and sent to Claude; the old choice comes back with a toast if the server refuses. */
  const pick = async (action: "model" | "mode" | "effort", value: string, current: string | null, set: (v: string | null) => void) => {
    set(value);
    try {
      await api.chatControl(workspaceId, action, value);
    } catch (e) {
      set(current);
      toast.error(failed("change that", e));
    } finally {
      repoll();
      setInfoKick((k) => k + 1);
    }
  };

  /** A mode pick. Full access never applies on the first tap: it asks in words first. */
  const chooseMode = (value: string) => {
    if (value === "full" && mode !== "full") setFullAsk(true);
    else void pick("mode", value, mode, setMode);
  };
  const allowFull = async () => {
    setFullAsk(false);
    const before = mode;
    setMode("full");
    try {
      await api.chatControl(workspaceId, "mode", "full");
    } catch (e) {
      setMode(before);
      toast.error(e instanceof Error && /owner|forbidden/i.test(e.message) ? FULL_ACCESS_OWNER_ONLY : failed("change that", e));
    } finally {
      repoll();
      setInfoKick((k) => k + 1);
    }
  };

  /** Switches the chat's AI, and its account when one is named (null: the AI's own login). Reversible, so no confirmation: the conversation stays, and the new AI gets what it missed with the next message. Resolves to whether it worked. */
  const switchAgent = async (value: string, account?: string | null): Promise<boolean> => {
    try {
      await api.chatControl(workspaceId, "agent", account === undefined ? value : { agent: value, account });
      await refresh();
      return true;
    } catch (e) {
      toast.error(failed("switch", e));
      return false;
    } finally {
      repoll();
      setInfoKick((k) => k + 1);
    }
  };

  /** Another account on this AI (null: its own login). */
  const switchAccount = async (id: string | null) => {
    try {
      await api.chatControl(workspaceId, "account", id);
    } catch (e) {
      toast.error(failed("switch", e));
    } finally {
      repoll();
      setInfoKick((k) => k + 1);
    }
  };

  /** Back to what Settings says for one field. */
  const resetField = async (field: string) => {
    try {
      await api.chatControl(workspaceId, "reset", field);
      announce("Back to the Settings choice");
      await refresh();
    } catch (e) {
      toast.error(failed("reset that", e));
    } finally {
      repoll();
      setInfoKick((k) => k + 1);
    }
  };

  /** Another AI's or account's model was picked in the picker: switch there, then choose the model once the switch has landed and its snapshot lists it (or 3 s have passed, for a model the snapshot never lists). */
  const pendingModel = useRef<{ agent: string; value: string; at: number; ready: boolean } | null>(null);
  const pickOther = async (to: string, value: string | null, account: string | null) => {
    const mine = value === null ? null : { agent: to, value, at: Date.now(), ready: false };
    pendingModel.current = mine;
    window.setTimeout(() => {
      if (pendingModel.current === mine) pendingModel.current = null;
    }, 15_000);
    const ok = await switchAgent(to, account);
    if (pendingModel.current !== mine) return;
    if (ok && mine) {
      mine.ready = true;
      repoll();
    } else pendingModel.current = null;
  };
  useEffect(() => {
    const p = pendingModel.current;
    if (!p || !p.ready || p.agent !== agent || !(models.some((m) => m.value === p.value) || Date.now() - p.at > 3000)) return;
    pendingModel.current = null;
    void pick("model", p.value, model, setModel);
  }, [agent, models]);

  const working = busy && waiting === null;
  // The line under the last message: the newest tool line of this turn if the code has one, else "Working".
  const lastUserAllN = Math.max(0, ...events.filter((e) => e.kind === "user").map((e) => e.n));
  const latestTool = [...events].reverse().find((e): e is ToolEvent => isToolLine(e) && e.n > lastUserAllN);
  // While the CLI retries a failed request, the working line says which try it is on. While the reply is being written, it says so, not the last step.
  const currentAction = retry
    ? `Retrying (attempt ${retry.attempt}${retry.max ? ` of ${retry.max}` : ""})…`
    : streamed.trim() !== ""
      ? "Writing a reply"
      : latestTool
        ? workingLine(latestTool.text)
        : "Working";

  // With a checklist, the working line says which step it is on: done + 1, up to the total.
  const todosDone = todos.filter((t) => t.status === "done").length;
  const step = todos.length > 0 && todosDone < todos.length ? `step ${todosDone + 1} of ${todos.length}` : null;

  // Keep / Undo only while the AI's changes are waiting to be kept or undone.
  const ws = findWorkspace(workspaces, workspaceId);
  // What the AI is set to for this project and where each setting comes from; read again when a turn or note lands or a setting changes.
  const runKey = `${agent}|${ws?.notes ?? ""}|${events.reduce((m, e) => (e.kind === "done" || e.kind === "note" ? e.n : m), 0)}|${infoKick}`;
  const { info: runInfo, failed: runFailed, reload: reloadRun } = useRunInfo(workspaceId, runKey, !compact);
  const accountId = runInfo?.account?.id ?? "default";
  useEffect(() => setOneShot(null), [agent, accountId]);
  const hasChanges = !terminalProject && ws !== null && workspaceStatus(ws) === "needs-review";
  // The commit message is the user's last request: its first line, cut to 72 characters.
  const lastRequest = [...events].reverse().find((e) => e.kind === "user")?.text ?? "";
  const keepMessage = (lastRequest.split("\n")[0] ?? "").trim().slice(0, 72).trim() || "Changes from chat";

  // How many files the AI changed, for "Changed N files" under the reply.
  const [changed, setChanged] = useState<number | null>(null);
  useEffect(() => {
    if (!hasChanges || busy) return;
    let alive = true;
    api
      .diff(workspaceId)
      .then((files) => {
        if (alive) setChanged(files.length);
      })
      .catch(() => {
        if (alive) setChanged(null);
      });
    return () => {
      alive = false;
    };
  }, [hasChanges, busy, workspaceId]);

  // Once a ready card has shown, the first-visit hint is remembered.
  useEffect(() => {
    if (!readyHint || busy || !hasChanges || !can || compact) return;
    try {
      localStorage.setItem(READY_HINT_KEY, "1");
    } catch {
      /* no storage: the hint may show again next time */
    }
  }, [readyHint, busy, hasChanges, can, compact]);

  // Keep and Undo confirm in the conversation itself (the server writes a note), so no toast here: only failures show.
  const keep = async () => {
    setKeeping(true);
    try {
      await api.commit(workspaceId, keepMessage);
      repoll();
      await refresh();
    } catch (e) {
      toast.error(failed("save", e));
    } finally {
      setKeeping(false);
    }
  };

  /** Copies the link to this project's Preview, as the Preview panel does. */
  const copyPreviewLink = async () => {
    try {
      // The share link (it expires, and Share a link can turn it off), not the owner's own preview address.
      let info = await api.link(workspaceId);
      if (!info.url) info = await api.setLink(workspaceId, "1d", false);
      if (!info.url) throw new Error("Links for this kind of app aren't ready yet.");
      await copyText(location.origin + info.url);
      toast.success("Link copied. Anyone who can reach this Kohlab can open it.");
    } catch (e) {
      toast.error(`Couldn't copy the link. ${friendly(e)}`);
    }
  };

  /** Opens the Preview from the ready card: that counts as having looked at it. */
  const openPreview = () => {
    setPreviewSeen(true);
    onPreview?.();
  };

  const undo = async () => {
    setUndoing(true);
    try {
      await api.action(workspaceId, "discard");
      repoll();
      await refresh();
    } catch (e) {
      toast.error(failed("undo", e));
    } finally {
      setUndoing(false);
      setConfirmUndo(false);
    }
  };

  /** Stops one background task the CLI runs. */
  const stopTask = async (taskId: string) => {
    setStopping(taskId);
    try {
      await api.chatControl(workspaceId, "stop_task", taskId);
      announce("Task stopped");
    } catch (e) {
      toast.error(failed("stop that", e));
    } finally {
      setStopping(null);
      repoll();
    }
  };

  /** The message whose changes are shown, and the message the person is asked to go back to. */
  const [changesOf, setChangesOf] = useState<{ n: number } | null>(null);
  const [backTo, setBackTo] = useState<{ n: number; text: string } | null>(null);
  const [goingBack, setGoingBack] = useState(false);

  /** Go back to before a message: its files return as they were, and the next message is told so. */
  const confirmGoBack = async () => {
    if (!backTo) return;
    setGoingBack(true);
    try {
      await api.chatGoBack(workspaceId, backTo.n);
      toast.success("Went back. Your files are as they were before that message.");
      await refresh();
    } catch (e) {
      toast.error(failed("go back", e));
    } finally {
      setGoingBack(false);
      setBackTo(null);
      repoll();
    }
  };

  /** A new conversation that starts from what was said up to a message. The files stay as they are. */
  const branchFrom = async (n: number) => {
    try {
      await api.chatBranch(workspaceId, n);
      toast.success("Started a new chat from here");
      await refresh();
    } catch (e) {
      toast.error(failed("start a new chat", e));
    }
  };

  const renderEvent = (e: ChatEvent) => {
    const note = noteOf(e);
    if (note !== null) {
      // Under the newest "Kept this version": a quiet line to show someone the Preview link.
      const latestKeptN = Math.max(0, ...events.filter((x) => x.kind === "note" && x.text === KEPT_NOTE).map((x) => x.n));
      if (note === KEPT_NOTE && e.n === latestKeptN && can) {
        return (
          <>
            <NoteLine text={note} />
            <div className="flex items-center justify-center gap-2 text-xs text-text-muted">
              <span>Show someone:</span>
              <Button variant="quiet" size="sm" className="text-xs text-text-secondary" onClick={() => void copyPreviewLink()}>
                Copy link
              </Button>
            </div>
          </>
        );
      }
      return <NoteLine text={note} />;
    }
    switch (e.kind) {
      case "user": {
        const attached = splitAttached(e.text);
        const { body, points: pointed } = splitPointed(attached.body);
        const files = attached.files;
        // Pictures show as thumbnails; the other files stay as chips. Attachments are always saved in uploads/.
        const pictures = files.filter((name) => pictureType(name) !== null);
        const others = files.filter((name) => pictureType(name) === null);
        // Edit and resend: the newest message, once the AI is idle. Going back and a new chat need a checkpoint (a turn that changed nothing has none).
        const newest = e.n === lastUserAllN && !busy && waiting === null && can;
        const checkpoint = e.tree !== undefined && can && !busy;
        // Sent after the running turn began: the CLI runs it once that turn ends.
        const queuedBehind = busy && turnStartedAt !== null && e.at > turnStartedAt;
        return (
          <div className="group/msg flex flex-col items-end">
            <div className="max-w-[70%] break-words whitespace-pre-wrap rounded-[20px] bg-surface-bubble px-[18px] py-[10px] text-base leading-6 text-text-primary max-md:text-base">
              {body}
              {pointed.length > 0 ? (
                <ul className="mt-1 flex flex-wrap gap-2 whitespace-normal">
                  {pointed.map((line, i) => (
                    <li key={i} title={line} className="flex max-w-full items-center rounded-lg bg-surface-raised px-2 py-0.5 text-sm text-text-secondary">
                      <span className="truncate">{pointChipText(line)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {pictures.map((name, i) => (
                <div key={i} className="mt-1">
                  <ProjectImage path={`uploads/${name}`} alt={name} thumbClass="max-h-32" />
                </div>
              ))}
              {others.length > 0 ? (
                <ul className="mt-1 flex flex-wrap gap-2 whitespace-normal">
                  {others.map((name, i) => (
                    <li key={i} className="flex max-w-full items-center gap-1 rounded-lg bg-surface-raised px-2 py-0.5 text-sm text-text-secondary">
                      <Paperclip size={12} aria-hidden="true" className="shrink-0" />
                      <span className="truncate">{name}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            {queuedBehind || e.with ? (
              <p className="-mt-0.5 text-xs text-text-muted">
                {[queuedBehind ? "Waiting to send" : "", e.with ? `${queuedBehind ? "sent" : "Sent"} with ${modelName(e.with)}` : ""].filter(Boolean).join(" · ")}
              </p>
            ) : null}
            <MessageMenu
              onCopy={() => void copyMessage(body)}
              onEdit={newest ? () => startEdit(e.n, body, e.tree !== undefined) : undefined}
              onChanges={checkpoint ? () => setChangesOf({ n: e.n }) : undefined}
              onBack={checkpoint ? () => setBackTo({ n: e.n, text: e.text }) : undefined}
              onBranch={checkpoint ? () => void branchFrom(e.n) : undefined}
            />
          </div>
        );
      }
      case "assistant":
        return <Prose text={e.text} />;
      case "ask": {
        const answered = answers.get(e.requestId);
        if (answered !== undefined) return <AnsweredAsk e={e} allowed={answered} reply={replies.get(e.requestId)} />;
        // Nothing is waiting on this question any more (the server restarted before it was answered): it stays on screen, dimmed,
        // with its buttons off, and the newest one can be asked again.
        const dead = pendingAsk?.requestId !== e.requestId;
        const askBusy = dead || answering !== null;
        const latestAskN = Math.max(0, ...events.filter((x) => x.kind === "ask").map((x) => x.n));
        const repeatable = dead && e.n === latestAskN && !events.some((x) => x.kind === "user" && x.n > e.n) && !busy && waiting === null && can;
        const card =
          e.form === "question" ? (
            <QuestionCard e={e} can={can} busy={askBusy} onAnswer={(allow, extra) => void answer(e.requestId, allow, extra)} />
          ) : e.form === "plan" ? (
            <PlanCard e={e} can={can} busy={askBusy} onAnswer={(allow, extra) => void answer(e.requestId, allow, extra)} />
          ) : (
            <section aria-label={`${who} is asking`} className="rounded-card bg-surface-raised px-5 py-[18px]">
              <p className="text-base font-semibold text-text-primary">{e.text}</p>
              {e.why ? <p className="mt-1 text-small leading-5 text-text-muted">{e.why}</p> : null}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {can ? (
                  <>
                    <Button variant="primary" className={ASK_BUTTON} disabled={askBusy} onClick={() => void answer(e.requestId, true)}>
                      Allow
                    </Button>
                    <Button variant="secondary" className={ASK_BUTTON} disabled={askBusy} onClick={() => void answer(e.requestId, false)}>
                      {"Don't allow"}
                    </Button>
                    {e.always ? (
                      <Button variant="quiet" className="text-text-secondary [@media(pointer:coarse)]:min-h-11" disabled={askBusy} onClick={() => void answer(e.requestId, true, { always: true })}>
                        {`Always allow: ${e.always.label}`}
                      </Button>
                    ) : null}
                  </>
                ) : dead ? null : (
                  <p className="text-small text-text-muted">Waiting for an answer.</p>
                )}
                {e.detail ? <Details className="ml-auto" detail={e.detail} /> : null}
              </div>
            </section>
          );
        if (!dead) return card;
        return (
          <div className="flex flex-col items-start gap-3">
            <div className="w-full opacity-50" aria-disabled="true">
              {card}
            </div>
            <p className="text-small text-text-muted">{`Kohlab restarted before you answered, so ${who} stopped here.`}</p>
            {repeatable ? (
              <Button variant="secondary" disabled={sending} onClick={() => void sendText("Please carry on with what you were doing.")}>
                {`Ask ${who} again`}
              </Button>
            ) : null}
          </div>
        );
      }
      case "handoff":
        return <HandoffCard text={e.text} />;
      case "error":
        return (
          <p className="flex items-center gap-2 text-sm text-text-muted">
            <WarningCircle size={16} className="shrink-0" aria-hidden="true" />
            {e.text}
          </p>
        );
      default:
        return null;
    }
  };

  // The composer's chips show the CLI's current choices. Effort lives in the model menu, and only when the model supports it.
  // The snapshot names the model in full (claude-haiku-5-5); the menu lists it by alias (haiku). Both match by the display name.
  // Until the snapshot arrives, the project's stored model shows and the mode reads "…".
  const modelInfo = model === null ? undefined : models.find((m) => m.value === model || m.displayName === modelName(model));
  const levels = isClaude ? (modelInfo?.supportedEffortLevels ?? []) : [];
  const storedModel = modelOf(ws ?? undefined);
  const modelText = !isClaude ? (model ? shortModel(model) : "Default") : (modelInfo?.displayName ?? (model ? modelName(model) : storedModel === "default" ? "Default" : MODEL_LABEL[storedModel]));
  const effortText = effort ? (EFFORT_LABEL[effort] ?? effort) : "Default";
  // Never a bare "Mode": an unknown or not-yet-known mode shows the default mode's label.
  const modeText = (mode !== null ? MODE_LABEL[mode] : undefined) ?? MODE_LABEL.default;
  // The run strip: who, which account, model and mode, and what it is doing. Words only.
  const ctxPercent = isClaude && usage?.context ? usage.context.percent : null;
  const autoFresh = autoFreshLocal ?? (runInfo?.ai ? runInfo.ai.autoFresh.value !== false : ws?.autoFresh !== false);
  const freshWaiting = isClaude && autoFresh && (freshPending || (ctxPercent !== null && ctxPercent >= 85 && (busy || waiting !== null || background > 0)));
  const runningHelpers = helperTree.length > 0 ? helperTree.filter((h) => h.status === "running").length : helpers.length;
  const stripState = waiting !== null ? "Waiting for you" : busy ? "Working" : freshWaiting && background > 0 ? "Will continue fresh when the background work finishes" : background > 0 || runningHelpers > 0 ? "In the background" : "Ready";
  const stripExtra = [helpersWorkingText(runningHelpers), freshWaiting && (busy || waiting !== null) ? "Will continue fresh after this reply" : ""].filter(Boolean).join(" · ") || null;
  const stripAccount = runInfo?.account?.label ?? accountLabel(providerCards?.find((c) => c.id === agent) ?? { id: agent, name: who, kind: "cli", installed: true, version: null, state: "connected", checkedAt: 0, stale: false, accounts: [], actions: [] }, owner);
  const strip = compact ? null : (
    <RunStrip
      ai={who}
      account={stripAccount}
      model={modelText}
      mode={modeText}
      state={stripState}
      since={working ? busySince : null}
      extra={stripExtra}
      next={oneShot ? { label: oneShot.label, onClear: () => setOneShot(null) } : null}
      expanded={run.open}
      onToggle={run.toggle}
    />
  );
  // The banner: a long Claude chat offers a fresh memory at 70%, and again after each 10% more if it was put off.
  const showBanner = can && !compact && ctxPercent !== null && ctxPercent >= 70 && !busy && waiting === null && background === 0 && (bannerSnooze === null || ctxPercent >= bannerSnooze + 10);
  const setAutoFresh = async (on: boolean) => {
    setAutoFreshLocal(on);
    try {
      await api.chatAutoFresh(workspaceId, on);
      await refresh();
    } catch (e) {
      toast.error(failed("change that", e));
    } finally {
      setAutoFreshLocal(null);
    }
  };
  // "Just for the next message…": one reply on another model. Not while the AI works, and not for an AI that has listed no models.
  const canOneShot = can && !terminalProject && !!ws?.chat;
  const oneShotItem = !canOneShot ? null : !busy && models.length > 0 ? (
    <MenuSub label="Just for the next message…">
      <ModelChoices autoFocus={false} models={models} value={oneShot?.model ?? ""} onPick={(v) => setOneShot({ model: v, label: models.find((m) => m.value === v)?.displayName ?? modelName(v) })} />
    </MenuSub>
  ) : (
    <MenuItem disabled>
      <span className="block">Just for the next message…</span>
      <span className="block text-xs text-text-muted">{busy ? "Wait until the reply finishes" : "Not available for this AI yet"}</span>
    </MenuItem>
  );
  // The model menu's body, shared by the desktop model chip and the phone's combined chip.
  const modelMenu = (
    <>
      {oneShotItem}
      {oneShotItem ? <MenuSeparator /> : null}
      {isClaude ? (
        <ClaudeModelChoices models={models} value={modelInfo?.value ?? ""} onPick={(v) => void pick("model", v, model, setModel)} />
      ) : (
        <ModelChoices models={models} value={modelInfo?.value ?? ""} onPick={(v) => void pick("model", v, model, setModel)} />
      )}
      {levels.length > 0 ? (
        <>
          <MenuSeparator />
          <MenuLabel>{`Effort: ${effortText}`}</MenuLabel>
          <EffortChoices value={effort} levels={levels} onPick={(v) => void pick("effort", v, effort, setEffort)} />
        </>
      ) : null}
    </>
  );
  const pickerBody = (
    <PickerBody agent={agent} accountId={accountId} currentMenu={modelMenu} canSwitch={!terminalProject && !!ws?.chat} busy={busy} onPickOther={(a, m, acc) => void pickOther(a, m, acc)} />
  );
  const modeBody = <ModeChoices value={mode} isClaude={isClaude} onPick={chooseMode} />;
  const accountChoices = (providerCards?.find((c) => c.id === agent)?.accounts ?? []).filter((a) => a.state !== "signed_out" && a.state !== "error");
  const accountMenu = (
    <>
      <MenuLabel>{`${who} account`}</MenuLabel>
      <AccountChoices accounts={accountChoices} value={accountId} busy={busy} onPick={(id) => void switchAccount(id === "default" ? null : id)} />
    </>
  );

  // No message or reply yet (notes alone): the empty-chat layout, with the heading above the composer.
  const empty = events.every((e) => noteOf(e) !== null) && !busy;

  // The ready card's two buttons: Preview is the primary one until the person has looked at it, Keep is after that.
  const previewPrimary = !previewOpen && !previewSeen;
  const previewButton = previewOpen ? null : (
    <Button variant={previewPrimary ? "primary" : "secondary"} className="max-md:px-3" disabled={previewing} onClick={openPreview}>
      <Browser size={16} className="max-md:hidden" aria-hidden="true" />
      Preview
    </Button>
  );
  const keepButton = (
    <Button variant={previewPrimary ? "secondary" : "primary"} className="max-md:px-3" disabled={keeping} onClick={() => void keep()}>
      <Check size={16} className="max-md:hidden" aria-hidden="true" />
      {keeping ? "Keeping…" : "Keep this version"}
    </Button>
  );

  const placeholder =
    waiting !== null
      ? `${who} is waiting for your answer above`
      : busy
        ? `${who} is working…`
        : isPhone()
          ? `Message ${who}`
          : commandsEnabled ? `Message ${who} — / for commands, @ for files` : `Message ${who} — @ for files`;
  // While the AI works, the round button is always Stop. Enter with text queues the message (see the card above the box).
  const hasDraft = draft.trim() !== "" || attachments.length > 0 || points.length > 0;

  /** Sends the problems to the AI, then reads the chat again so the new message shows. */
  const fixProblems = async () => {
    setFixing(true);
    try {
      await askToFix(workspaceId, problems);
      refreshProblems();
      repoll();
    } catch (e) {
      toast.error(`Couldn't send that to ${who}. ${(e as Error).message}`);
    } finally {
      setFixing(false);
    }
  };
  /** Hides this list of problems until something new goes wrong (the key changes). */
  const notNow = () => {
    try {
      localStorage.setItem(`kohlab:problem-hidden:${workspaceId}`, problemKey);
    } catch {
      /* not remembered: it shows again on the next visit */
    }
    setProblemHidden(problemKey);
  };

  return (
    <WorkspaceCtx.Provider value={workspaceId}>
    <AgentCtx.Provider value={who}>
      <div className="flex h-full min-h-0" style={keyboard ? { paddingBottom: keyboard } : undefined}>
        <div className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col", empty && "justify-start pt-[max(0px,calc(12vh-52px))]")}>
          {/* An empty chat puts its heading where Home's is (12vh plus Home's own 28px, less the 56px project header and the column's 24px padding above it; there is no header-height variable to use, the header is a fixed h-14); the first message docks the composer at the bottom. */}
          <div className={cn("relative min-h-0", empty ? "flex-none" : "flex-1")}>
            <div
              ref={scrollRef}
              onScroll={onScroll}
              onWheel={(e) => {
                if (e.deltaY < 0) scrollUp();
              }}
              onTouchStart={(e) => {
                touchY.current = e.touches[0]?.clientY ?? 0;
              }}
              onTouchMove={(e) => {
                const y = e.touches[0]?.clientY ?? 0;
                if (y > touchY.current + 4) scrollUp();
                touchY.current = y;
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") scrollUp();
              }}
              className={cn(empty ? "relative" : "absolute inset-0", "overflow-y-auto overscroll-contain")}
            >
              <div
                ref={columnRef}
                role="log"
                aria-live="polite"
                aria-label={`Conversation with ${who}`}
                className={cn(
                  "flex w-full flex-col gap-6 px-4 pt-6 pb-8 max-md:gap-5 max-md:pt-4 max-md:pb-4",
                  compact ? "pt-4" : "mx-auto max-w-[720px] shell:px-6",
                )}
              >
                {empty ? (
                  <div className="flex flex-col items-center gap-2 px-2 text-center">
                    <h2 className="text-2xl font-medium tracking-tight text-text-primary">{`What should ${who} build?`}</h2>
                    <p className="text-base text-text-muted">{`Describe it in your own words. ${who} will ask before changing anything important.`}</p>
                  </div>
                ) : null}
                {turns.map((turn, ti) => {
                  // Everything Claude wrote in this turn, as its markdown source, for Copy.
                  // Only Claude text that is actually shown earns a Copy: a blank reply under a question has nothing to copy.
                  const replies = turn.flat().flatMap((e) => (e.kind === "assistant" && e.text.trim() !== "" ? [e.text] : []));
                  const turnKey = turn[0][0].kind === "user" ? turn[0][0].n : 0;
                  // Not under the turn still running: a done line that arrives late can belong to the turn before it.
                  const worked = busy && ti === turns.length - 1 ? null : workedLine(doneByTurn.get(turnKey) ?? {});
                  const renderRow = (row: ChatEvent[]) => (
                        <Fragment key={row[0].n}>
                          {isToolLine(row[0]) ? (
                            <ToolRun lines={row} results={results} />
                          ) : row.length > 1 ? (
                            <AnsweredGroup events={row} answers={answers} />
                          ) : (
                            renderEvent(row[0])
                          )}
                          {row[0].n === events.at(-1)?.n && row[0].kind === "error" && !busy && can && lastRequest ? (
                            <div>
                              <Button variant="secondary" disabled={sending} onClick={() => void sendText(lastRequest)}>
                                Try again
                              </Button>
                            </div>
                          ) : null}
                        </Fragment>
                  );
                  let tail = turn.length;
                  while (tail > 1 && turn[tail - 1][0].kind === "note") tail--;
                  return (
                    <div key={turn[0][0].n} className="group flex min-w-0 flex-col gap-3">
                      {turn.slice(0, tail).map(renderRow)}
                      {worked ? <p className="text-xs text-text-muted">{worked}</p> : null}
                      {/* Copy only under a finished reply that ends in text: not mid-turn, not under a tool run. */}
                      {replies.length > 0 && !(busy && ti === turns.length - 1) && turn[tail - 1][0].kind === "assistant" ? (
                        <CopyReply text={replies.join("\n\n")} latest={ti === turns.length - 1} />
                      ) : null}
                      {turn.slice(tail).map(renderRow)}
                    </div>
                  );
                })}
                {busy && streamed ? (
                  // aria-live off: the reply is announced once, when its assistant message arrives.
                  <div aria-live="off">
                    <Prose text={streamed} streaming />
                  </div>
                ) : null}
                {!compact && !busy && hasChanges && can ? (
                  <ReadyCard
                    changed={changed}
                    previewPrimary={previewPrimary}
                    previewButton={previewButton}
                    keepButton={keepButton}
                    previewOpen={previewOpen}
                    sending={sending}
                    undoing={undoing}
                    readyHint={readyHint}
                    onCheck={() => void sendText(CHECK_TEXT)}
                    onUndo={() => setConfirmUndo(true)}
                  />
                ) : null}
                {!compact && !busy && can && problems.length > 0 && problemHidden !== problemKey ? (
                  <section aria-label="Problem with the page" className="flex flex-col gap-3 rounded-card bg-surface-raised px-5 py-[18px]">
                    <p className="text-base font-semibold text-text-primary">The page has a problem</p>
                    <p className="text-small text-text-muted">{problemSummary(problems)}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="primary" disabled={fixing} aria-busy={fixing} onClick={() => void fixProblems()}>
                        {`Ask ${who} to fix it`}
                      </Button>
                      <Button variant="quiet" className="text-text-secondary" onClick={notNow}>
                        Not now
                      </Button>
                    </div>
                  </section>
                ) : null}
                {todos.length > 0 ? <Checklist todos={todos} /> : null}
                {working ? (
                  <WorkingLine
                    action={currentAction}
                    step={step}
                    since={busySince}
                    background={background}
                    tasksOpen={tasksOpen}
                    onTasks={() => setTasksOpen((o) => !o)}
                    helpers={helpers}
                    helpersOpen={run.open}
                    onHelpers={run.toggle}
                  />
                ) : null}
                {!busy && background > 0 ? (
                  <button
                    type="button"
                    aria-expanded={tasksOpen}
                    onClick={() => setTasksOpen((o) => !o)}
                    className="flex min-h-11 items-center gap-2 rounded-lg px-1 text-left text-small text-text-muted hover:bg-surface-hover hover:text-text-primary shell:min-h-8"
                  >
                    <span className="pulse-dot size-1.5 shrink-0 rounded-full bg-text-muted" aria-hidden="true" />
                    {background === 1 ? "1 task still running in the background" : `${background} tasks still running in the background`}
                  </button>
                ) : null}
                {tasksOpen && background > 0 ? <TaskList tasks={tasks} stopping={stopping} onStop={(id) => void stopTask(id)} /> : null}
              </div>
            </div>
            {/* A subtle fade under the tab bar, so scrolled text does not hit the edge. */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-[linear-gradient(var(--surface-base),transparent)]" />
            {/* The same fade above the composer, on phones. */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-6 bg-[linear-gradient(transparent,var(--surface-base))] max-md:block" />
          </div>
          {/* Outside the scroll area, so the button never covers prose. */}
          {farFromEnd ? (
            <div className={cn("flex shrink-0 justify-center px-3 pt-2", !compact && "mx-auto w-full max-w-[720px]")}>
              <Button variant="secondary" iconOnly aria-label="Scroll to latest" title="Scroll to latest" onClick={scrollToLatest}>
                <ArrowDown size={18} aria-hidden="true" />
              </Button>
            </div>
          ) : null}
  
          {can ? (
            <div className="shrink-0 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-md:pb-[max(12px,var(--safe-bottom,env(safe-area-inset-bottom)))] shell:px-6">
              <div className={compact ? "w-full" : "mx-auto w-full max-w-[720px]"}>
                {sendError ? (
                  <p role="alert" className="mb-2 text-sm text-status-danger">
                    {sendError}
                  </p>
                ) : null}

                {editing ? (
                  <p className="mb-2 flex flex-wrap items-center gap-x-2 text-sm text-text-muted">
                    <span>{editing.tree ? "Editing your last message" : "Editing your last message (files stay as they are)"}</span>
                    <span aria-hidden="true">·</span>
                    <Button
                      variant="quiet"
                      size="sm"
                      className="text-xs text-text-secondary"
                      onClick={() => {
                        // The text stays in the box as an ordinary draft; only the edit ends.
                        setEditing(null);
                        taRef.current?.focus();
                      }}
                    >
                      Cancel
                    </Button>
                  </p>
                ) : null}
  
                {attachNote ? (
                  <p role="alert" className="mb-2 text-sm text-status-danger">
                    {attachNote}
                  </p>
                ) : null}
  
                {terminalProject && terminalOpen && !busy && waiting === null ? (
                  <p className="mb-2 text-xs text-text-muted">
                    {`Sending from here closes ${who}'s terminal screen. The conversation carries on here, and in Terminal when you switch back.`}
                  </p>
                ) : null}
                {slashOn ? (
                  <PickList
                    id="slash-menu"
                    label="Commands"
                    active={slashActive}
                    onPick={(i) => pickCommand(slashMatches[i])}
                    options={slashMatches.map((c) => ({
                      key: c.name,
                      title: (
                        <>
                          <span className="font-medium">/{c.name}</span>
                          {c.argumentHint ? <span className="text-text-faint"> {c.argumentHint}</span> : null}
                        </>
                      ),
                      detail: c.description || undefined,
                    }))}
                  />
                ) : null}
                {slashLoading ? (
                  <div role="status" className="menu mb-2 px-2.5 py-2 text-sm text-text-muted">
                    Loading commands…
                  </div>
                ) : null}
                {mentionOn ? (
                  <PickList
                    id="mention-menu"
                    label="Files"
                    active={mentionActive}
                    onPick={(i) => pickFile(mentionFiles[i])}
                    options={mentionFiles.map((p) => ({ key: p, title: p }))}
                  />
                ) : null}
  
                {showBanner ? (
                  <section aria-label="This chat is getting long" className="mb-2 flex flex-col gap-3 rounded-card bg-surface-raised px-4 py-3">
                    <p className="text-small text-text-secondary">This chat is getting long. Continue with a fresh memory? Nothing is lost.</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Button variant="secondary" size="sm" onClick={() => setFreshOpen(true)}>
                        Continue fresh
                      </Button>
                      <Button variant="quiet" size="sm" className="text-text-secondary" onClick={() => setBannerSnooze(ctxPercent)}>
                        Not now
                      </Button>
                      <label className="flex min-h-8 cursor-pointer items-center gap-2 text-xs text-text-muted pointer-coarse:min-h-11" htmlFor="banner-auto-fresh">
                        <input id="banner-auto-fresh" type="checkbox" className="size-4 shrink-0 accent-accent" checked={autoFresh} onChange={(e) => void setAutoFresh(e.target.checked)} />
                        Do it for me
                      </label>
                    </div>
                  </section>
                ) : null}
                {strip}
                <Composer
                  ariaLabel="Message"
                  // The reading column pads 24px from 900px up (px-6), so the box's text starts where the messages do.
                  className={compact ? undefined : "shell:px-6"}
                  textareaRef={taRef}
                  value={draft}
                  onChange={(v) => {
                    setDraft(v);
                    setSlashIndex(0);
                    setSlashShut(false);
                    setMentionShut(false);
                  }}
                  placeholder={placeholder}
                  disabled={waiting !== null}
                  textareaAria={{
                    ...COMPOSER_MARK,
                    "aria-autocomplete": "list",
                    "aria-expanded": slashOn || mentionOn,
                    "aria-controls": slashOn ? "slash-menu" : mentionOn ? "mention-menu" : undefined,
                    "aria-activedescendant": slashOn ? `slash-menu-opt-${slashActive}` : mentionOn ? `mention-menu-opt-${mentionActive}` : undefined,
                  }}
                  onKeyDown={onKeyDown}
                  phoneOneRow
                  onSubmit={() => void send()}
                  onSaveLater={saveForLater}
                  onPaste={(e) => {
                    if (e.clipboardData.files.length > 0) {
                      e.preventDefault();
                      takeFiles(e.clipboardData.files, true);
                      return;
                    }
                    const text = e.clipboardData.getData("text/plain");
                    const asText = plainPaste.current;
                    plainPaste.current = false;
                    if (asText || text.length < BIG_PASTE) return;
                    // A big paste becomes a .txt file in the box, sent like any other attachment.
                    e.preventDefault();
                    takeFiles([new File([text], pastedName("text/plain", Date.now()), { type: "text/plain" })]);
                  }}
                  onDropFiles={(files) => takeFiles(files)}
                  attachments={
                    attachments.length > 0 || points.length > 0 ? (
                      <>
                      {points.length > 0 ? (
                        <ul aria-label="Pointed at" className="flex flex-wrap gap-2 pt-1">
                          {points.map((p) => {
                            const label = pointChipText(pointLine(p.pick));
                            return (
                              <li key={p.key} className="flex max-w-full items-center gap-2 rounded-xl bg-surface-active py-1 pr-1 pl-2.5 text-sm text-text-secondary">
                                <span className="min-w-0 truncate" title={label}>
                                  {label}
                                </span>
                                <button
                                  type="button"
                                  aria-label={`Remove ${label}`}
                                  disabled={uploading}
                                  onClick={() => setPoints((list) => list.filter((x) => x.key !== p.key))}
                                  className="flex size-8 shrink-0 items-center justify-center rounded-full text-text-muted hover:text-text-primary max-md:size-11 disabled:opacity-40"
                                >
                                  <X size={12} aria-hidden="true" />
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                      {attachments.length > 0 ? (
                      <ul aria-label="Files to send" className="flex flex-wrap gap-2 pt-1">
                        {attachments.map((a) => (
                          <li key={a.key} className="flex max-w-full items-center gap-2 rounded-xl bg-surface-active py-1 pr-1 pl-1.5 text-sm text-text-secondary">
                            {a.url ? (
                              <img src={a.url} alt="" className="size-8 shrink-0 rounded-md object-cover" />
                            ) : (
                              <Paperclip size={14} aria-hidden="true" className="shrink-0" />
                            )}
                            <span className="min-w-0 truncate">{a.file.name}</span>
                            <button
                              type="button"
                              aria-label={`Remove ${a.file.name}`}
                              disabled={uploading}
                              onClick={() => removeAttachment(a.key)}
                              className="flex size-8 shrink-0 items-center justify-center rounded-full text-text-muted hover:text-text-primary max-md:size-11 disabled:opacity-40"
                            >
                              <X size={12} aria-hidden="true" />
                            </button>
                          </li>
                        ))}
                      </ul>
                      ) : null}
                      </>
                    ) : null
                  }
                  leading={
                    <>
                      <input
                        ref={fileRef}
                        type="file"
                        multiple
                        aria-label="Add files"
                        className="hidden"
                        onChange={(e) => {
                          takeFiles(e.target.files ?? []);
                          e.target.value = "";
                        }}
                      />
                      <ComposerChip
                        iconOnly
                        aria-label="Add files"
                        title="Add files"
                        icon={<Paperclip size={14} aria-hidden="true" />}
                        disabled={waiting !== null || sending || uploading}
                        onClick={() => fileRef.current?.click()}
                      />
                      {draft.trim() !== "" ? <SaveLaterChip onClick={saveForLater} /> : null}
                      <SavedChip onPick={(text) => {
                        setDraft(text);
                        taRef.current?.focus();
                      }} />
                      {commandsEnabled ? (
                        <Menu
                          side="top"
                          align="start"
                          label="Commands"
                          trigger={
                            <ComposerChip
                              iconOnly
                              aria-label="Commands"
                              className="max-md:hidden"
                              title={commands.length === 0 ? `Commands load when ${who} starts` : "Commands (type /)"}
                              icon={<span aria-hidden="true" className="text-base leading-none">/</span>}
                              disabled={commands.length === 0}
                            />
                          }
                        >
                          <CommandChoices commands={commands} onPick={insertCommand} />
                        </Menu>
                      ) : null}
                      <ModelPicker
                        agent={agent}
                        accountId={accountId}
                        modelText={modelText}
                        currentMenu={modelMenu}
                        canSwitch={!terminalProject && !!ws?.chat}
                        busy={busy}
                        noModels={models.length === 0}
                        onPickOther={(a, m, acc) => void pickOther(a, m, acc)}
                      />
                      <Menu side="top" align="start" label={`Mode: ${modeText}`} trigger={<ComposerChip className="max-w-48 shrink-0 max-md:hidden" label={modeText} menu />}>
                        {modeBody}
                      </Menu>
                      {/* Phones: a shield alone; the strip above the box says the word. */}
                      <Menu
                        side="top"
                        align="start"
                        label={`Mode: ${modeText}`}
                        trigger={<ComposerChip iconOnly className="md:hidden" aria-label={`Mode: ${modeText}`} title={`Mode: ${modeText}`} icon={<ShieldCheck size={16} aria-hidden="true" />} />}
                      >
                        {modeBody}
                      </Menu>
                    </>
                  }
                  trailing={
                    <>
                      {isClaude && usage?.context && usage.context.percent >= 50 ? (
                        <ComposerChip
                          className="min-w-0 shrink"
                          label={usage.context.percent >= 85 ? "Chat almost full" : `Chat ${usage.context.percent}% full`}
                          onClick={() => setUsageOpen(true)}
                        />
                      ) : null}
                      {busy ? (
                        <Button variant="secondary" iconOnly className="shrink-0" aria-label="Stop" title="Stop" onClick={() => void stop()}>
                          <Stop size={16} aria-hidden="true" />
                        </Button>
                      ) : (
                        <Button
                          variant="primary"
                          iconOnly
                          className="shrink-0"
                          aria-label="Send"
                          title="Send"
                          disabled={waiting !== null || sending || uploading || !hasDraft}
                          onClick={() => void send()}
                        >
                          <ArrowUp size={18} aria-hidden="true" />
                        </Button>
                      )}
                    </>
                  }
                />
                {working && draft.trim() !== "" && !isPhone() ? (
                  <p className="mt-1 px-4 text-xs text-text-muted">{`Enter adds to the queue · ${isApple ? "Cmd" : "Ctrl"}+Enter stops and sends now`}</p>
                ) : null}
              </div>
            </div>
          ) : strip ? (
            <div className="shrink-0 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] shell:px-6">
              <div className="mx-auto w-full max-w-[720px]">{strip}</div>
            </div>
          ) : null}
  
        </div>

        <RunPanel
          docked={run.docked}
          open={run.open}
          onClose={() => run.setOpen(false)}
          workspaceId={workspaceId}
          agent={agent}
          who={who}
          isClaude={isClaude}
          busy={busy}
          waiting={waiting}
          since={working ? busySince : null}
          background={background}
          helperTree={helperTree}
          skew={skewRef.current}
          canMutate={can}
          owner={owner}
          stopping={stopping}
          onStopHelper={(id) => void stopTask(id)}
          nowExtra={
            <>
              {todos.length > 0 ? <Checklist todos={todos} /> : null}
              {background > 0 ? <TaskList tasks={tasks} stopping={stopping} onStop={(id) => void stopTask(id)} /> : null}
            </>
          }
          events={events}
          info={runInfo}
          infoFailed={runFailed}
          onReload={reloadRun}
          canSet={can && !terminalProject && !!ws?.chat}
          modelText={modelText}
          models={models}
          menus={{ ai: pickerBody, account: accountMenu, model: pickerBody, effort: levels.length > 0 ? <EffortChoices value={effort} levels={levels} onPick={(v) => void pick("effort", v, effort, setEffort)} /> : null, mode: modeBody }}
          onReset={(field) => void resetField(field)}
          autoFresh={autoFresh}
          onAutoFresh={(on) => void setAutoFresh(on)}
          onContinueFresh={() => setFreshOpen(true)}
          ctxPercent={ctxPercent}
        />

        <FullAccessDialog open={fullAsk} onOpenChange={setFullAsk} note={runInfo?.accessNote} onConfirm={() => void allowFull()} />

        {freshOpen ? (
          <FreshDialog
            workspaceId={workspaceId}
            who={who}
            onClose={() => setFreshOpen(false)}
            onDone={() => {
              setFreshOpen(false);
              repoll();
              void refresh();
            }}
          />
        ) : null}

        {changesOf !== null ? (
          <ChangesDialog
            workspaceId={workspaceId}
            n={changesOf.n}
            onOpenChange={(v) => {
              if (!v) setChangesOf(null);
            }}
          />
        ) : null}
        <ConfirmDialog
          open={backTo !== null}
          onOpenChange={(v) => {
            if (!v) setBackTo(null);
          }}
          title="Go back to before this message?"
          description="Your files return to how they were before you sent it. You can undo this from Earlier versions."
          confirmLabel="Go back"
          tone="commit"
          busy={goingBack}
          onConfirm={() => void confirmGoBack()}
        />
        <ConfirmDialog
          open={confirmUndo}
          onOpenChange={(v) => {
            if (!v) setConfirmUndo(false);
          }}
          title="Undo the changes?"
          description={`Everything ${who} changed since you last pressed Keep will be removed. This can't be reversed.`}
          confirmLabel="Undo"
          tone="danger"
          busy={undoing}
          onConfirm={() => void undo()}
        />
      </div>
    </AgentCtx.Provider>
    </WorkspaceCtx.Provider>
  );
}
