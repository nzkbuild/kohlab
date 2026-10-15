import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { ArrowCounterClockwise, ArrowUp, CaretRight, Check, Copy, Eye, Paperclip, Warning, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../api";
import type { ChatEvent as StoredChatEvent } from "../types";
import { toastAction } from "../lib/actions";
import { announce } from "../lib/announce";
import { splitAttached, pastedName, safeAttachName, withSuffix } from "../lib/attach";
import { copyText } from "../lib/clipboard";
import { findWorkspace, useApp, useCan } from "../store";
import { workspaceStatus } from "../lib/status";
import { inline, parseBlocks, type Inline } from "../lib/markdown";
import { cn } from "../lib/utils";
import ConfirmDialog from "./ConfirmDialog";
import { Button, Tooltip } from "./ui";

/** An event as chat.ts writes it. `why` is the AI's one-line reason for a command (on ask events). */
type ChatEvent = StoredChatEvent & { why?: string };
type ToolEvent = Extract<ChatEvent, { kind: "tool" }>;
type AskEvent = Extract<ChatEvent, { kind: "ask" }>;

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
  onPreview: () => void;
  previewing: boolean;
  previewOpen: boolean;
  /** Called when Claude's turn ends, so an open preview can reload. */
  onTurnEnd?: () => void;
}

/** The tool lines of one run, as one plain sentence: "looked at 3 files, wrote 2 and ran 1 command". Prefixes come from describeTool in chat.ts. */
function summarizeTools(lines: string[]): string {
  let read = 0;
  let ran = 0;
  let searched = 0;
  let looked = 0;
  let helped = 0;
  let other = 0;
  const wrote = new Set<string>();
  for (const t of lines) {
    if (t.startsWith("Created ") || t.startsWith("Edited ")) wrote.add(t.slice(t.indexOf(" ") + 1));
    else if (t.startsWith("Read ")) read++;
    else if (t.startsWith("Ran: ")) ran++;
    else if (t.startsWith("Searched the web") || t.startsWith("Opened ")) looked++;
    else if (t.startsWith("Searched")) searched++;
    else if (t.startsWith("Asked a helper")) helped++;
    else other++;
  }
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts: string[] = [];
  if (read) parts.push(`looked at ${n(read, "file", "files")}`);
  if (wrote.size) parts.push(`wrote ${n(wrote.size, "file", "files")}`);
  if (ran) parts.push(`ran ${n(ran, "command", "commands")}`);
  if (searched) parts.push(`searched ${n(searched, "time", "times")}`);
  if (looked) parts.push(`looked up ${n(looked, "page", "pages")}`);
  if (helped) parts.push(`asked ${n(helped, "helper", "helpers")}`);
  if (other) parts.push(`did ${n(other, "other thing", "other things")}`);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Present-tense version of a describeTool line for the working line: "Created a.html" -> "Writing a.html". */
function workingLine(t: string): string {
  const rest = (n: number) => t.slice(n);
  if (t.startsWith("Created ")) return `Writing ${rest(8)}`;
  if (t.startsWith("Edited ")) return `Editing ${rest(7)}`;
  if (t.startsWith("Read ")) return `Reading ${rest(5)}`;
  if (t.startsWith("Ran: ")) return "Running a command";
  if (t.startsWith("Searched the web")) return "Searching the web";
  if (t.startsWith("Searched")) return "Searching the files";
  if (t.startsWith("Opened ")) return "Opening a page";
  if (t.startsWith("Asked a helper")) return "Asking a helper";
  return "Working";
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Merge a fresh batch into the list by sequence number, so a repeated event never shows twice. */
function mergeEvents(prev: ChatEvent[], next: ChatEvent[]): ChatEvent[] {
  const seen = new Set(prev.map((e) => e.n));
  const fresh = next.filter((e) => !seen.has(e.n));
  if (fresh.length === 0) return prev;
  return [...prev, ...fresh].sort((a, b) => a.n - b.n);
}

/** Inline pieces as elements, never as HTML: bold, `code`, links. Anything else stays plain text. */
function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "strong":
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case "code":
        return (
          <code key={i} className="mono rounded bg-surface-sunken px-1 py-0.5 text-[0.85em]">
            {node.text}
          </code>
        );
      case "link":
        return (
          <a
            key={i}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-primary underline decoration-line-strong underline-offset-[3px] hover:decoration-line-accent"
          >
            {node.text}
          </a>
        );
    }
  });
}

const rich = (text: string) => renderInline(inline(text));

/** Copy with a check mark for 1.5 s. A failed copy says so. */
function useCopied(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async (text: string) => {
    try {
      await copyText(text);
      setCopied(true);
      announce("Copied");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy");
    }
  };
  return [copied, copy];
}

/** The action row under a reply. Hidden until the reply is hovered or focused; always shown on touch and on the latest reply. */
function CopyReply({ text, latest }: { text: string; latest: boolean }) {
  const [copied, copy] = useCopied();
  const Icon = copied ? Check : Copy;
  return (
    <div className="-ml-2.5 -mt-1 flex">
      <Tooltip content="Copy">
        <Button
          variant="quiet"
          iconOnly
          aria-label="Copy reply"
          className={cn(
            "size-8 text-text-faint hover:text-text-primary max-md:size-11 [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:opacity-100",
            "motion-safe:transition-opacity",
            latest ? "opacity-100" : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
          )}
          onClick={() => void copy(text)}
        >
          <Icon size={16} aria-hidden="true" />
        </Button>
      </Tooltip>
    </div>
  );
}

/** A fenced block: mono code that scrolls sideways, with its language and a Copy of the code only. */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, copy] = useCopied();
  const Icon = copied ? Check : Copy;
  return (
    <div className="overflow-hidden rounded-[10px] border border-line-subtle bg-surface-sunken">
      <div className="flex items-center justify-between gap-3 border-b border-line-subtle py-0.5 pr-1 pl-3.5">
        <span className="mono min-w-0 truncate text-[12px] text-text-muted">{lang}</span>
        <Button
          variant="quiet"
          size="sm"
          aria-label="Copy code"
          className="text-[12px] text-text-secondary max-md:min-h-11 [@media(pointer:coarse)]:min-h-11"
          onClick={() => void copy(code)}
        >
          <Icon size={14} aria-hidden="true" />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="mono overflow-x-auto px-3.5 py-3 text-[13px] leading-5 text-text-primary">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** What Claude said, in a measure a person can read without losing their place. */
function Prose({ text }: { text: string }) {
  return (
    <div className="flex max-w-[66ch] min-w-0 flex-col gap-3 text-[15px] leading-6 text-text-primary max-md:max-w-none max-md:w-full max-md:text-base">
      {parseBlocks(text).map((block, i) => {
        if (block.kind === "p") return <p key={i} className="whitespace-pre-line">{rich(block.lines.join("\n"))}</p>;
        if (block.kind === "h") return <p key={i} className="text-[16px] font-semibold text-text-primary">{rich(block.text)}</p>;
        if (block.kind === "hr") return <hr key={i} className="border-line-subtle" />;
        if (block.kind === "code") return <CodeBlock key={i} lang={block.lang} code={block.code} />;
        if (block.kind === "ul") {
          return (
            <ul key={i} className="space-y-1.5">
              {block.items.map((item, j) => (
                <li
                  key={j}
                  className="relative pl-[18px] before:absolute before:top-[10px] before:left-[4px] before:size-[5px] before:rounded-full before:bg-text-muted before:content-['']"
                >
                  {rich(item)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <ol key={i} className="list-decimal space-y-1.5 pl-[18px] marker:text-text-muted">
            {block.items.map((item, j) => (
              <li key={j}>{rich(item)}</li>
            ))}
          </ol>
        );
      })}
    </div>
  );
}

/** A run of tool actions: one muted line; the caret opens the list of each action. */
function ToolRun({ lines }: { lines: ChatEvent[] }) {
  const [open, setOpen] = useState(false);
  const tools = lines.filter((e): e is ToolEvent => e.kind === "tool");
  const summary = summarizeTools(tools.map((e) => e.text));
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 items-center gap-1.5 rounded-lg px-1 text-left text-[14px] text-text-muted hover:bg-surface-hover hover:text-text-primary shell:min-h-8"
      >
        <CaretRight size={14} weight="bold" aria-hidden="true" className={cn("shrink-0 motion-safe:transition-transform", open && "rotate-90")} />
        {cap(summary)}
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-1 pl-6 text-[13px] text-text-muted">
          {tools.map((e) => (
            <li key={e.n}>{e.text}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The question Claude asked, and the answer, once given: one muted line. */
function AnsweredAsk({ e, allowed }: { e: AskEvent; allowed: boolean }) {
  // "Claude wants to create the file index.html" reads as "You allowed Claude to create index.html".
  const what = e.text.replace(/^Claude wants to /, "").replace(/^(create|change) the file /, "$1 ");
  const Icon = allowed ? Check : X;
  return (
    <div className="text-[14px] text-text-muted">
      <p className="flex items-start gap-1.5">
        <Icon size={14} className="mt-[5px] shrink-0" aria-hidden="true" />
        <span className="min-w-0">{allowed ? `You allowed Claude to ${what}` : `You didn't allow Claude to ${what}`}</span>
      </p>
      {e.detail || e.why ? (
        <div className="ml-5">
          <Details detail={e.detail} why={e.why} />
        </div>
      ) : null}
    </div>
  );
}

/** Several answered asks in a row (and the tool runs between them) as one line: "You allowed 3 changes to index.html". */
function AnsweredGroup({ events, answers }: { events: ChatEvent[]; answers: Map<string, boolean> }) {
  const asks = events.filter((e): e is AskEvent => e.kind === "ask");
  const allowed = asks.filter((a) => answers.get(a.requestId));
  const denied = asks.length - allowed.length;
  const files = new Set<string>();
  let changes = 0;
  let commands = 0;
  let others = 0;
  for (const a of allowed) {
    const f = /^Claude wants to (?:create|change) the file (.+)$/.exec(a.text);
    if (f) {
      changes++;
      files.add(f[1]);
    } else if (a.text === "Claude wants to run a command") commands++;
    else others++;
  }
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts: string[] = [];
  if (changes) parts.push(n(changes, "change", "changes"));
  if (commands) parts.push(n(commands, "command", "commands"));
  if (others) parts.push(n(others, "other step", "other steps"));
  let text = parts.length === 0 ? "" : `You allowed ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`}`;
  if (files.size === 1 && changes && !commands && !others) text += ` to ${[...files][0]}`;
  if (denied) text += `${text ? ", and you" : "You"} didn't allow ${n(denied, "step", "steps")}`;
  return (
    <div className="text-[14px] text-text-muted">
      <p className="flex items-start gap-1.5">
        <Check size={14} className="mt-[5px] shrink-0" aria-hidden="true" />
        <span className="min-w-0">{text}</span>
      </p>
      <details className="ml-5 text-[13px] text-text-muted">
        <summary className="flex min-h-11 cursor-pointer select-none items-center hover:text-text-primary shell:min-h-8">Show details</summary>
        <ul className="mb-2 flex flex-col gap-1">
          {events.map((e) =>
            e.kind === "ask" ? (
              <li key={e.n}>
                {answers.get(e.requestId) ? "Allowed: " : "Not allowed: "}
                {e.text.replace(/^Claude wants to /, "")}
                {e.detail ? <span className="mono block break-all text-text-secondary">{e.detail}</span> : null}
              </li>
            ) : e.kind === "tool" ? (
              <li key={e.n}>{e.text}</li>
            ) : null,
          )}
        </ul>
      </details>
    </div>
  );
}

/** The command behind an ask (and its reason, when the card does not already show it), behind a disclosure. */
function Details({ detail, why, className }: { detail?: string; why?: string; className?: string }) {
  return (
    <details className={cn("text-[13px] text-text-muted", className)}>
      <summary className="flex min-h-11 cursor-pointer select-none items-center hover:text-text-primary shell:min-h-8">Show details</summary>
      {why ? <p className="pb-2 text-text-secondary">{why}</p> : null}
      {detail ? (
        <pre className="mono mb-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-surface-sunken px-3 py-2 text-[13px] text-text-secondary">
          {detail}
        </pre>
      ) : null}
    </details>
  );
}

function groupRows(events: ChatEvent[]): ChatEvent[][] {
  const rows: ChatEvent[][] = [];
  for (const e of events) {
    if (e.kind === "done" || e.kind === "answer") continue;
    const last = rows[rows.length - 1];
    if (e.kind === "tool" && last?.[0].kind === "tool") last.push(e);
    else rows.push([e]);
  }
  return rows;
}

export default function ChatView({ workspaceId, onPreview, previewing, previewOpen, onTurnEnd }: Props) {
  const refresh = useApp((s) => s.refresh);
  const workspaces = useApp((s) => s.workspaces);
  const can = useCan().mutate;
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  // Claude's reply as it is being written (streamed by the server, not yet an event).
  const [streamed, setStreamed] = useState("");
  const [kick, setKick] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [keeping, setKeeping] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachNote, setAttachNote] = useState<string | null>(null);
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
  const nearBottomRef = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Poll: 0.5 s while the AI is working, 1 s while it waits for an answer, 4 s otherwise. Paused while the
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
        setWaiting(res.waiting);
        setStreamed(res.draft);
        schedule(res.busy ? 500 : res.waiting !== null ? 1000 : 4000);
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

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const phone = window.matchMedia("(max-width: 767.98px)").matches;
      const hidden = Math.round(window.innerHeight - vv.height - vv.offsetTop);
      const lift = phone && document.activeElement === taRef.current && hidden > 80 ? hidden : 0;
      setKeyboard(lift);
      if (lift && nearBottomRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
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
    if (wasBusy.current && !busy) turnEndRef.current?.();
    wasBusy.current = busy;
  }, [busy, refresh]);

  // Announce new assistant text. Bursts are coalesced by announce() itself.
  useEffect(() => {
    for (const e of events) {
      if (e.kind === "assistant" && e.n > announcedRef.current) announce(e.text);
    }
    announcedRef.current = Math.max(announcedRef.current, events.reduce((m, e) => Math.max(m, e.n), 0));
  }, [events]);

  const answers = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const e of events) if (e.kind === "answer") m.set(e.requestId, e.allow);
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
    () => (pendingAsk ? rows.filter((row) => !(row[0].kind === "tool" && row[0].n > lastUserN && row[0].n < pendingN)) : rows),
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
    const isAnswered = (row: ChatEvent[]) => row.length === 1 && row[0].kind === "ask" && answers.has(row[0].requestId);
    return out.map((turn) => {
      const merged: ChatEvent[][] = [];
      for (let i = 0; i < turn.length; i++) {
        if (!isAnswered(turn[i])) {
          merged.push(turn[i]);
          continue;
        }
        let end = i;
        for (let j = i + 1; j < turn.length && (isAnswered(turn[j]) || turn[j][0].kind === "tool"); j++) if (isAnswered(turn[j])) end = j;
        merged.push(turn.slice(i, end + 1).flat());
        i = end;
      }
      return merged;
    });
  }, [visibleRows, answers]);

  // Keep the newest message in view, but only while the reader is already at the bottom.
  // On open, start at the latest user message rather than mid-reply.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!openedRef.current) {
      if (events.length === 0) return;
      openedRef.current = true;
      const start = el.querySelector<HTMLElement>("[data-turn-start]");
      if (start) el.scrollTop += start.getBoundingClientRect().top - el.getBoundingClientRect().top - 24;
      else el.scrollTop = el.scrollHeight;
      nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      return;
    }
    if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [events, busy, waiting, streamed]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Grow the composer with its text, up to about eight lines.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lines = window.matchMedia("(max-width: 767.98px)").matches ? 5 : 8;
    const max = (parseFloat(getComputedStyle(el).lineHeight) || 24) * lines;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [draft]);

  // Sends one message. Returns true when the server took it.
  const sendText = async (text: string): Promise<boolean> => {
    setSending(true);
    setSendError(null);
    try {
      await api.chatSend(workspaceId, text);
      setBusy(true);
      nearBottomRef.current = true;
      return true;
    } catch (e) {
      // 409 "still working": Claude is busy, so the composer locks until it is not.
      setSendError((e as Error).message);
      setBusy(true);
      return false;
    } finally {
      setSending(false);
      repoll();
    }
  };

  /** Adds picked, pasted or dropped files to the composer, within the count and size limits. */
  const takeFiles = (list: FileList | File[], pasted = false) => {
    if (busy || sending || uploading) return;
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
    if ((!text && attachments.length === 0) || busy || sending || uploading) return;
    let message = text;
    if (attachments.length > 0) {
      setUploading(true);
      setSendError(null);
      let paths: string[];
      try {
        paths = await uploadAll();
      } catch (e) {
        setSendError((e as Error).message);
        return;
      } finally {
        setUploading(false);
      }
      const line = `Attached: ${paths.join(", ")}`;
      message = text ? `${text}\n\n${line}` : line;
    }
    if (await sendText(message)) {
      setDraft("");
      clearAttachments();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Touch keyboards have no Shift+Enter: Enter is a newline there, and the send button sends.
    const touch = window.matchMedia("(pointer: coarse)").matches;
    if (e.key === "Enter" && !touch && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const answer = async (requestId: string, allow: boolean) => {
    setAnswering(requestId);
    try {
      await api.chatAnswer(workspaceId, requestId, allow);
      repoll();
    } catch (e) {
      toast.error(`Could not answer, ${(e as Error).message}`);
    } finally {
      setAnswering(null);
    }
  };

  const stop = async () => {
    try {
      await toastAction(workspaceId, "stop");
      await refresh();
      announce("Claude stopped");
    } catch {
      announce("Claude could not stop");
    } finally {
      repoll();
    }
  };

  const working = busy && waiting === null;
  // The line under the last message: the newest tool line of this turn if the code has one, else "Working".
  const lastUserAllN = Math.max(0, ...events.filter((e) => e.kind === "user").map((e) => e.n));
  const latestTool = [...events].reverse().find((e): e is ToolEvent => e.kind === "tool" && e.n > lastUserAllN);
  const currentAction = latestTool ? workingLine(latestTool.text) : "Working";

  // Keep / Undo only while the AI's changes are waiting to be kept or undone.
  const ws = findWorkspace(workspaces, workspaceId);
  const hasChanges = ws !== null && workspaceStatus(ws) === "needs-review";
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

  const keep = async () => {
    setKeeping(true);
    try {
      await api.commit(workspaceId, keepMessage);
      await refresh();
      toast.success("Saved");
    } catch (e) {
      toast.error(`Could not save, ${(e as Error).message}`);
    } finally {
      setKeeping(false);
    }
  };

  const undo = async () => {
    setUndoing(true);
    try {
      await api.action(workspaceId, "discard");
      await refresh();
      toast.success("Changes undone");
    } catch (e) {
      toast.error(`Could not undo, ${(e as Error).message}`);
    } finally {
      setUndoing(false);
      setConfirmUndo(false);
    }
  };

  const renderEvent = (e: ChatEvent) => {
    switch (e.kind) {
      case "user": {
        const { body, files } = splitAttached(e.text);
        return (
          <div className="flex justify-end" data-turn-start={e.n === lastUserN ? "" : undefined}>
            <div className="max-w-[70%] break-words whitespace-pre-wrap rounded-[20px] bg-surface-bubble px-[18px] py-[10px] text-[15px] leading-6 text-text-primary max-md:text-base">
              {body}
              {files.length > 0 ? (
                <ul className="mt-1 flex flex-wrap gap-1.5 whitespace-normal">
                  {files.map((name, i) => (
                    <li key={i} className="flex max-w-full items-center gap-1 rounded-lg bg-surface-raised px-2 py-0.5 text-[13px] text-text-secondary">
                      <Paperclip size={12} aria-hidden="true" className="shrink-0" />
                      <span className="truncate">{name}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        );
      }
      case "assistant":
        return <Prose text={e.text} />;
      case "ask": {
        const answered = answers.get(e.requestId);
        if (answered !== undefined) return <AnsweredAsk e={e} allowed={answered} />;
        if (pendingAsk?.requestId !== e.requestId) {
          // The newest question, with nothing said after it, can be asked again: the server restart lost the process that was waiting.
          const latestAskN = Math.max(0, ...events.filter((x) => x.kind === "ask").map((x) => x.n));
          const repeatable = e.n === latestAskN && !events.some((x) => x.kind === "user" && x.n > e.n) && !busy && waiting === null && can;
          return (
            <div className="flex flex-col items-start gap-3">
              <p className="text-[14px] text-text-muted">Kohlab restarted before you answered, so Claude stopped here.</p>
              {repeatable ? (
                <Button variant="secondary" className="min-h-11 rounded-full shell:min-h-9" disabled={sending} onClick={() => void sendText("Please carry on with what you were doing.")}>
                  Ask Claude again
                </Button>
              ) : null}
            </div>
          );
        }
        return (
          <section aria-label="Claude is asking" className="rounded-2xl border border-line-subtle px-5 py-[18px]">
            <p className="text-base font-medium text-text-primary">{e.text}</p>
            {e.why ? <p className="mt-1 text-[14px] leading-5 text-text-muted">{e.why}</p> : null}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {can ? (
                <>
                  <Button
                    variant="primary"
                    className="min-h-11 rounded-full shell:min-h-9"
                    disabled={answering !== null}
                    onClick={() => void answer(e.requestId, true)}
                  >
                    Allow
                  </Button>
                  <Button
                    variant="secondary"
                    className="min-h-11 rounded-full shell:min-h-9"
                    disabled={answering !== null}
                    onClick={() => void answer(e.requestId, false)}
                  >
                    {"Don't allow"}
                  </Button>
                </>
              ) : (
                <p className="text-[14px] text-text-muted">Waiting for an answer.</p>
              )}
              {e.detail ? <Details className="ml-auto" detail={e.detail} /> : null}
            </div>
          </section>
        );
      }
      case "error":
        return (
          <p className="flex items-center gap-1.5 text-[13px] text-status-danger">
            <Warning size={12} aria-hidden="true" />
            {e.text}
          </p>
        );
      default:
        return null;
    }
  };

  const placeholder = waiting !== null ? "Claude is waiting for your answer above" : busy ? "Claude is working…" : "Ask Claude for a change…";

  return (
    <div className="flex h-full min-h-0" style={keyboard ? { paddingBottom: keyboard } : undefined}>
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} onScroll={onScroll} className="absolute inset-0 overflow-y-auto overscroll-contain">
            <div
              role="log"
              aria-live="polite"
              aria-label="Conversation with Claude"
              className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-4 pt-6 pb-8 max-md:gap-5 max-md:pt-4 max-md:pb-4 shell:px-6"
            >
              {events.length === 0 && !busy ? (
                <div className="flex flex-col items-center gap-2 px-2 pt-[18vh] text-center">
                  <h2 className="text-xl font-semibold text-text-primary">What should Claude build?</h2>
                  <p className="text-[15px] text-text-muted">Describe it in your own words. Claude will ask before changing anything important.</p>
                </div>
              ) : null}
              {turns.map((turn, ti) => {
                // Everything Claude wrote in this turn, as its markdown source, for Copy.
                const replies = turn.flat().filter((e) => e.kind === "assistant").map((e) => e.text);
                return (
                  <div key={turn[0][0].n} className="group flex min-w-0 flex-col gap-3">
                    {turn.map((row) => (
                      <Fragment key={row[0].n}>
                        {row[0].kind === "tool" ? (
                          <ToolRun lines={row} />
                        ) : row.length > 1 ? (
                          <AnsweredGroup events={row} answers={answers} />
                        ) : (
                          renderEvent(row[0])
                        )}
                        {row[0].n === events.at(-1)?.n && row[0].kind === "error" && !busy && can && lastRequest ? (
                          <div>
                            <Button variant="secondary" className="min-h-11 rounded-full shell:min-h-9" disabled={sending} onClick={() => void sendText(lastRequest)}>
                              Try again
                            </Button>
                          </div>
                        ) : null}
                      </Fragment>
                    ))}
                    {replies.length > 0 ? <CopyReply text={replies.join("\n\n")} latest={ti === turns.length - 1} /> : null}
                  </div>
                );
              })}
              {busy && streamed ? (
                // aria-live off: the reply is announced once, when its assistant message arrives.
                <div aria-live="off">
                  <Prose text={streamed} />
                </div>
              ) : null}
              {!busy && hasChanges && can ? (
            <div role="region" aria-label="Changes to check" className="flex flex-col gap-3">
              <p className="text-[14px] text-text-muted">
                {changed === null ? "Changes to check" : `Changed ${changed} ${changed === 1 ? "file" : "files"}`}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button variant="primary" className="min-h-11 rounded-full max-md:px-3 shell:min-h-9" disabled={keeping} onClick={() => void keep()}>
                  <Check size={14} className="max-md:hidden" aria-hidden="true" />
                  Keep this version
                </Button>
                {previewOpen ? null : (
                  <Button variant="secondary" className="min-h-11 rounded-full max-md:px-3 shell:min-h-9" disabled={previewing} onClick={onPreview}>
                    <Eye size={14} className="max-md:hidden" aria-hidden="true" />
                    Preview
                  </Button>
                )}
                <Button variant="quiet" className="min-h-11 text-text-secondary max-md:px-2.5 shell:min-h-9" disabled={undoing} onClick={() => setConfirmUndo(true)}>
                  <ArrowCounterClockwise size={14} aria-hidden="true" />
                  Undo
                </Button>
              </div>
            </div>
              ) : null}
              {working ? (
                <p className="flex items-center gap-2 text-[14px] text-text-muted">
                  <span className="size-1.5 shrink-0 rounded-full bg-text-muted" aria-hidden="true" />
                  {currentAction}
                </p>
              ) : null}
            </div>
          </div>
          {/* A subtle fade under the tab bar, so scrolled text does not hit the edge. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-[linear-gradient(var(--surface-base),transparent)]" />
        </div>

        {can ? (
          <div className="shrink-0 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-md:pb-[max(12px,var(--safe-bottom,env(safe-area-inset-bottom)))] shell:px-6">
            <div className="mx-auto w-full max-w-[720px]">
              {sendError ? (
                <p role="alert" className="mb-2 text-[13px] text-status-danger">
                  {sendError}
                </p>
              ) : null}

              {attachNote ? (
                <p role="alert" className="mb-2 text-[13px] text-status-danger">
                  {attachNote}
                </p>
              ) : null}
              {attachments.length > 0 ? (
                <ul aria-label="Files to send" className="mb-2 flex flex-wrap gap-1.5">
                  {attachments.map((a) => (
                    <li key={a.key} className="flex max-w-full items-center gap-2 rounded-xl bg-surface-raised py-1 pr-1 pl-1.5 text-[13px] text-text-secondary">
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

              <div
                className="flex items-end gap-2 rounded-3xl bg-surface-raised py-2.5 pr-2.5 pl-5 focus-within:outline-1 focus-within:outline-offset-0 focus-within:outline-line-strong"
                onDragOver={(e: DragEvent<HTMLDivElement>) => {
                  if (e.dataTransfer.types.includes("Files")) e.preventDefault();
                }}
                onDrop={(e: DragEvent<HTMLDivElement>) => {
                  if (e.dataTransfer.files.length === 0) return;
                  e.preventDefault();
                  takeFiles(e.dataTransfer.files);
                }}
              >
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    takeFiles(e.target.files ?? []);
                    e.target.value = "";
                  }}
                />
                <Button
                  variant="quiet"
                  iconOnly
                  aria-label="Attach a file"
                  title="Attach a file"
                  className="-ml-3 size-11 shrink-0 rounded-full text-text-secondary shell:size-9"
                  disabled={busy || sending || uploading}
                  onClick={() => fileRef.current?.click()}
                >
                  <Paperclip size={18} aria-hidden="true" />
                </Button>
                <textarea
                  ref={taRef}
                  aria-label="Message Claude"
                  className="block min-h-9 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-6 text-text-primary placeholder:text-text-muted outline-none! disabled:cursor-not-allowed max-md:text-base"
                  rows={1}
                  value={draft}
                  disabled={busy}
                  placeholder={placeholder}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                  onPaste={(e: ClipboardEvent<HTMLTextAreaElement>) => {
                    if (e.clipboardData.files.length === 0) return;
                    e.preventDefault();
                    takeFiles(e.clipboardData.files, true);
                  }}
                />
                {waiting !== null ? null : busy ? (
                  <Button variant="primary" iconOnly aria-label="Stop Claude" title="Stop Claude" className="size-11 shrink-0 rounded-full shell:size-9" onClick={() => void stop()}>
                    <span aria-hidden="true" className="size-[11px] rounded-[2px] bg-current" />
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    iconOnly
                    aria-label="Send"
                    title="Send"
                    className="size-11 shrink-0 rounded-full shell:size-9 disabled:opacity-40"
                    disabled={sending || uploading || (draft.trim() === "" && attachments.length === 0)}
                    onClick={() => void send()}
                  >
                    <ArrowUp size={18} weight="bold" aria-hidden="true" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmUndo}
        onOpenChange={(v) => {
          if (!v) setConfirmUndo(false);
        }}
        title="Undo the changes?"
        description="Everything Claude changed since you last pressed Keep will be removed. This can't be reversed."
        confirmLabel="Undo"
        busy={undoing}
        onConfirm={() => void undo()}
      />
    </div>
  );
}
