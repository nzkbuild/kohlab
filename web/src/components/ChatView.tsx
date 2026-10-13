import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowCounterClockwise, ArrowUp, CaretRight, Check, Eye, Stop, Warning, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../api";
import type { ChatEvent as StoredChatEvent } from "../types";
import { toastAction } from "../lib/actions";
import { announce } from "../lib/announce";
import { findWorkspace, useApp, useCan } from "../store";
import { workspaceStatus } from "../lib/status";
import { cn } from "../lib/utils";
import ConfirmDialog from "./ConfirmDialog";
import PreviewPanel from "./PreviewPanel";
import { Button } from "./ui";

/** An event as chat.ts writes it. `why` is the AI's one-line reason for a command (on ask events). */
type ChatEvent = StoredChatEvent & { why?: string };
type ToolEvent = Extract<ChatEvent, { kind: "tool" }>;
type AskEvent = Extract<ChatEvent, { kind: "ask" }>;

interface Props {
  workspaceId: string;
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Merge a fresh batch into the list by sequence number, so a repeated event never shows twice. */
function mergeEvents(prev: ChatEvent[], next: ChatEvent[]): ChatEvent[] {
  const seen = new Set(prev.map((e) => e.n));
  const fresh = next.filter((e) => !seen.has(e.n));
  if (fresh.length === 0) return prev;
  return [...prev, ...fresh].sort((a, b) => a.n - b.n);
}

/** **bold** and `code` as elements, never as HTML. Anything else stays plain text. */
function inlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/).map((part, i) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="mono rounded bg-surface-sunken px-1 py-0.5 text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

/** Prose blocks: paragraphs, "- " or "* " bullets, and "1. " numbers. */
type Block = { kind: "p"; lines: string[] } | { kind: "ul" | "ol"; items: string[] };

function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] | null = null;
  for (const line of text.split("\n")) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const number = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet || number) {
      para = null;
      const kind = bullet ? "ul" : "ol";
      const item = (bullet ?? number)?.[1] ?? "";
      const last = blocks[blocks.length - 1];
      if (last && last.kind !== "p" && last.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
    } else if (line.trim() === "") {
      para = null;
    } else if (para) {
      para.push(line);
    } else {
      para = [line];
      blocks.push({ kind: "p", lines: para });
    }
  }
  return blocks;
}

/** What Claude said, in a measure a person can read without losing their place. */
function Prose({ text }: { text: string }) {
  return (
    <div className="flex max-w-[66ch] flex-col gap-3 text-[15px] leading-6 text-text-primary">
      {blocksOf(text).map((block, i) => {
        if (block.kind === "p") return <p key={i} className="whitespace-pre-line">{inlineMarkdown(block.lines.join("\n"))}</p>;
        if (block.kind === "ul") {
          return (
            <ul key={i} className="space-y-1.5">
              {block.items.map((item, j) => (
                <li
                  key={j}
                  className="relative pl-[18px] before:absolute before:top-[10px] before:left-[4px] before:size-[5px] before:rounded-full before:bg-text-muted before:content-['']"
                >
                  {inlineMarkdown(item)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <ol key={i} className="list-decimal space-y-1.5 pl-[18px] marker:text-text-muted">
            {block.items.map((item, j) => (
              <li key={j}>{inlineMarkdown(item)}</li>
            ))}
          </ol>
        );
      })}
    </div>
  );
}

/** A run of tool actions: one muted line; the caret opens the list of each action. */
function ToolRun({ lines, live }: { lines: ChatEvent[]; live: boolean }) {
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
        {live ? `Working… ${summary}` : cap(summary)}
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
function Details({ detail, why }: { detail?: string; why?: string }) {
  return (
    <details className="text-[13px] text-text-muted">
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

export default function ChatView({ workspaceId }: Props) {
  const refresh = useApp((s) => s.refresh);
  const workspaces = useApp((s) => s.workspaces);
  const can = useCan().mutate;
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [kick, setKick] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  // Desktop: the preview opens beside the chat. Phones open it as a full-screen sheet.
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  const [pane, setPane] = useState<{ url: string; t: number } | null>(null);
  const paneOpen = wide && pane !== null;
  const sheetOpen = !wide && pane !== null;

  const afterRef = useRef(0);
  const primedRef = useRef(false);
  const openedRef = useRef(false);
  const announcedRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Poll: 1 s while the AI is working or asking, 4 s otherwise. Paused while the
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
        schedule(res.busy || res.waiting !== null ? 1000 : 4000);
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
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setWide(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // A cache-busting reload of the preview (the ?t= makes the browser fetch again).
  const reloadPane = () => setPane((p) => (p ? { ...p, t: Date.now() } : p));
  const closePreview = () => setPane(null);

  // A turn that just ended may have changed files: refresh so the Keep / Undo bar sees it,
  // and reload the preview so it shows the new version.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (!busy) void refresh();
    if (wasBusy.current && !busy) reloadPane();
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
  }, [events, busy, waiting]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Grow the composer with its text, up to about eight lines.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = (parseFloat(getComputedStyle(el).lineHeight) || 24) * 8;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [draft]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await api.chatSend(workspaceId, text);
      setDraft("");
      setBusy(true);
      nearBottomRef.current = true;
    } catch (e) {
      // 409 "still working": Claude is busy, so the composer locks until it is not.
      setSendError((e as Error).message);
      setBusy(true);
    } finally {
      setSending(false);
      repoll();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
      toast.error(`could not answer, ${(e as Error).message}`);
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
  const lastVisible = visibleRows[visibleRows.length - 1];
  // The newest tool run already reads "Working…", so no separate line is needed then.
  const lastIsTool = lastVisible?.[0].kind === "tool";

  // Keep / Undo only while the AI's changes are waiting to be kept or undone.
  const ws = findWorkspace(workspaces, workspaceId);
  const hasChanges = ws !== null && workspaceStatus(ws) === "needs-review";
  // The commit message is the user's last request: its first line, cut to 72 characters.
  const lastRequest = [...events].reverse().find((e) => e.kind === "user")?.text ?? "";
  const keepMessage = (lastRequest.split("\n")[0] ?? "").trim().slice(0, 72).trim() || "Changes from chat";

  const preview = async () => {
    setPreviewing(true);
    try {
      const { url } = await api.preview(workspaceId);
      setPane({ url, t: Date.now() });
    } catch (e) {
      toast.error(`could not open the preview, ${(e as Error).message}`);
    } finally {
      setPreviewing(false);
    }
  };

  const keep = async () => {
    setKeeping(true);
    try {
      await api.commit(workspaceId, keepMessage);
      await refresh();
      toast.success("Saved");
    } catch (e) {
      toast.error(`could not save, ${(e as Error).message}`);
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
      toast.error(`could not undo, ${(e as Error).message}`);
    } finally {
      setUndoing(false);
      setConfirmUndo(false);
    }
  };

  const renderEvent = (e: ChatEvent) => {
    switch (e.kind) {
      case "user":
        return (
          <div className="flex justify-end" data-turn-start={e.n === lastUserN ? "" : undefined}>
            <div className="max-w-[80%] whitespace-pre-wrap rounded-[18px] bg-bubble-user px-4 py-3 text-[15px] leading-6 text-text-primary">{e.text}</div>
          </div>
        );
      case "assistant":
        return <Prose text={e.text} />;
      case "ask": {
        const answered = answers.get(e.requestId);
        if (answered !== undefined) return <AnsweredAsk e={e} allowed={answered} />;
        if (pendingAsk?.requestId !== e.requestId) return <p className="text-[14px] text-text-muted">This question expired.</p>;
        return (
          <section aria-label="Claude is asking" className="rounded-[14px] border border-line-subtle bg-surface-raised px-[18px] py-4">
            <p className="text-base font-semibold text-text-primary">{e.text}</p>
            {e.why ? <p className="mt-1 text-[15px] leading-6 text-text-secondary">{e.why}</p> : null}
            {e.detail ? <Details detail={e.detail} /> : null}
            {can ? (
              <div className="mt-4 flex flex-col gap-2 shell:flex-row">
                <Button
                  variant="primary"
                  className="min-h-11 w-full rounded-[10px] shell:w-auto"
                  disabled={answering !== null}
                  onClick={() => void answer(e.requestId, true)}
                >
                  Allow
                </Button>
                <Button
                  variant="secondary"
                  className="min-h-11 w-full rounded-[10px] shell:w-auto"
                  disabled={answering !== null}
                  onClick={() => void answer(e.requestId, false)}
                >
                  {"Don't allow"}
                </Button>
              </div>
            ) : (
              <p className="mt-3 text-[14px] text-text-muted">Waiting for an answer.</p>
            )}
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
  const paneWidth = "w-[clamp(360px,42%,640px)]";

  return (
    <div className="flex h-full min-h-0">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} onScroll={onScroll} className="absolute inset-0 overflow-y-auto">
            <div
              role="log"
              aria-live="polite"
              aria-label="Conversation with Claude"
              className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-4 pt-6 pb-8 shell:px-6"
            >
              {events.length === 0 && !busy ? (
                <div className="flex flex-col items-center gap-2 px-2 pt-[18vh] text-center">
                  <h2 className="text-xl font-semibold text-text-primary">What should Claude build?</h2>
                  <p className="text-[15px] text-text-muted">Describe it in your own words. Claude will ask before changing anything important.</p>
                </div>
              ) : null}
              {turns.map((turn) => {
                const firstReply = turn.findIndex((row) => row[0].kind !== "user");
                return (
                  <div key={turn[0][0].n} className="flex flex-col gap-3">
                    {turn.map((row, ri) => {
                      const live = working && row === lastVisible;
                      return (
                        <Fragment key={row[0].n}>
                          {ri === firstReply ? <p className="text-[13px] font-semibold text-text-secondary">Claude</p> : null}
                          {row[0].kind === "tool" ? (
                            <ToolRun lines={row} live={live} />
                          ) : row.length > 1 ? (
                            <AnsweredGroup events={row} answers={answers} />
                          ) : (
                            renderEvent(row[0])
                          )}
                        </Fragment>
                      );
                    })}
                  </div>
                );
              })}
              {working && !lastIsTool ? (
                <p className="flex items-center gap-2 text-[14px] text-text-muted">
                  <span className="size-2 shrink-0 rounded-full bg-text-muted motion-safe:animate-pulse" aria-hidden="true" />
                  Working…
                </p>
              ) : null}
            </div>
          </div>
          {/* A subtle fade under the tab bar, so scrolled text does not hit the edge. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-[linear-gradient(var(--surface-base),transparent)]" />
        </div>

        {can ? (
          <div className="shrink-0 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] shell:px-6">
            <div className="mx-auto w-full max-w-[720px]">
              {sendError ? (
                <p role="alert" className="mb-2 text-[13px] text-status-danger">
                  {sendError}
                </p>
              ) : null}
              {!busy && hasChanges ? (
                <div
                  role="region"
                  aria-label="Changes to check"
                  className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[14px] border border-line-subtle bg-surface-raised px-4 py-3"
                >
                  <p className="mr-auto min-w-0 text-[15px] text-text-primary">Look at the preview. If you like it, keep it. If not, undo it.</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {paneOpen ? null : (
                      <Button variant="secondary" size="sm" className="min-h-11 shell:min-h-9" disabled={previewing} onClick={() => void preview()}>
                        <Eye size={14} aria-hidden="true" />
                        Preview
                      </Button>
                    )}
                    <Button variant="primary" size="sm" className="min-h-11 shell:min-h-9" disabled={keeping} onClick={() => void keep()}>
                      <Check size={14} aria-hidden="true" />
                      Keep this version
                    </Button>
                    <Button variant="quiet" size="sm" className="min-h-11 text-text-secondary shell:min-h-9" disabled={undoing} onClick={() => setConfirmUndo(true)}>
                      <ArrowCounterClockwise size={14} aria-hidden="true" />
                      Undo
                    </Button>
                  </div>
                </div>
              ) : !busy && !paneOpen ? (
                <div className="mb-2 flex justify-end">
                  <Button variant="secondary" size="sm" className="min-h-11 shell:min-h-9" disabled={previewing} onClick={() => void preview()}>
                    <Eye size={14} aria-hidden="true" />
                    Preview
                  </Button>
                </div>
              ) : null}

              <div className="flex flex-col gap-2 rounded-[18px] border border-line-strong bg-surface-raised p-3 pl-4 focus-within:border-line-accent">
                <textarea
                  ref={taRef}
                  aria-label="Message Claude"
                  className="block min-h-12 w-full resize-none bg-transparent text-[15px] leading-6 text-text-primary placeholder:text-text-muted outline-none disabled:cursor-not-allowed"
                  rows={1}
                  value={draft}
                  disabled={busy}
                  placeholder={placeholder}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                />
                <div className="flex items-center gap-3">
                  <span className="hidden text-[13px] text-text-muted shell:inline">Enter to send, Shift+Enter for a new line</span>
                  <div className="ml-auto flex items-center">
                    {waiting !== null ? null : busy ? (
                      <Button variant="primary" iconOnly aria-label="Stop Claude" title="Stop Claude" className="size-11 rounded-full shell:size-9" onClick={() => void stop()}>
                        <Stop size={16} weight="fill" aria-hidden="true" />
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        iconOnly
                        aria-label="Send"
                        title="Send"
                        className="size-11 rounded-full shell:size-9"
                        disabled={sending || draft.trim() === ""}
                        onClick={() => void send()}
                      >
                        <ArrowUp size={18} weight="bold" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {paneOpen && pane ? (
        <aside aria-label="Preview" className={cn("flex h-full min-h-0 shrink-0 flex-col border-l border-line-subtle bg-surface-raised", paneWidth)}>
          <PreviewPanel url={pane.url} t={pane.t} variant="pane" onReload={reloadPane} onClose={closePreview} />
        </aside>
      ) : null}

      {sheetOpen && pane ? (
        <div className="fixed inset-0 z-(--z-overlay) flex flex-col bg-surface-raised pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
          <PreviewPanel url={pane.url} t={pane.t} variant="sheet" onReload={reloadPane} onClose={closePreview} />
        </div>
      ) : null}

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
