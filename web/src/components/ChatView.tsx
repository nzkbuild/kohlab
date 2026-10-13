import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { PaperPlaneRight, Check, Stop, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../api";
import type { ChatEvent } from "../types";
import { toastAction } from "../lib/actions";
import { announce } from "../lib/announce";
import { useApp, useCan } from "../store";
import { Button } from "./ui";

interface Props {
  workspaceId: string;
}

/** Merge a fresh batch into the list by sequence number, so a repeated event never shows twice. */
function mergeEvents(prev: ChatEvent[], next: ChatEvent[]): ChatEvent[] {
  const seen = new Set(prev.map((e) => e.n));
  const fresh = next.filter((e) => !seen.has(e.n));
  if (fresh.length === 0) return prev;
  return [...prev, ...fresh].sort((a, b) => a.n - b.n);
}

/**
 * Tool lines group tightly; every other entry stands alone. `done` and `answer`
 * never render as rows: `done` only ends a turn, and `answer` is shown on its ask.
 */
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
  const can = useCan().mutate;
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [kick, setKick] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);

  const afterRef = useRef(0);
  const primedRef = useRef(false);
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

  // Announce new assistant text. Bursts are coalesced by announce() itself.
  useEffect(() => {
    for (const e of events) {
      if (e.kind === "assistant" && e.n > announcedRef.current) announce(e.text);
    }
    announcedRef.current = Math.max(announcedRef.current, events.reduce((m, e) => Math.max(m, e.n), 0));
  }, [events]);

  // Keep the newest message in view, but only while the reader is already at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
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
    const max = (parseFloat(getComputedStyle(el).lineHeight) || 20) * 8 + 20;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [draft]);

  const answers = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const e of events) if (e.kind === "answer") m.set(e.requestId, e.allow);
    return m;
  }, [events]);

  const rows = useMemo(() => groupRows(events), [events]);

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
      // 409 "still working": the AI is busy, so the composer locks until it is not.
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
      announce(`${workspaceId} stopped`);
    } catch {
      announce(`${workspaceId} could not stop`);
    } finally {
      repoll();
    }
  };

  const working = busy && waiting === null;

  const renderEvent = (e: ChatEvent) => {
    switch (e.kind) {
      case "user":
        return (
          <div className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-surface-active px-4 py-2.5 text-sm text-text-primary">{e.text}</div>
          </div>
        );
      case "assistant":
        return <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-primary">{e.text}</p>;
      case "tool":
        return (
          <p className="flex items-center gap-1.5 text-xs text-text-muted">
            <Check size={12} aria-hidden="true" />
            {e.text}
          </p>
        );
      case "ask": {
        const answered = answers.get(e.requestId);
        const pending = answered === undefined && waiting === e.requestId;
        return (
          <div className="rounded-xl border border-line-strong bg-surface-raised p-4">
            <p className="text-sm font-semibold text-text-primary">{e.text}</p>
            {e.detail ? (
              <pre className="mono mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-line-subtle bg-surface-sunken px-3 py-2 text-xs text-text-secondary">
                {e.detail}
              </pre>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {answered !== undefined ? (
                <span className="text-sm text-text-muted">{answered ? "Allowed" : "Not allowed"}</span>
              ) : pending && can ? (
                <>
                  <Button variant="primary" disabled={answering !== null} onClick={() => void answer(e.requestId, true)}>
                    Allow
                  </Button>
                  <Button variant="secondary" disabled={answering !== null} onClick={() => void answer(e.requestId, false)}>
                    {"Don't allow"}
                  </Button>
                </>
              ) : pending ? (
                <span className="text-sm text-text-muted">Waiting for an answer.</span>
              ) : (
                <span className="text-sm text-text-muted">This question expired.</span>
              )}
            </div>
          </div>
        );
      }
      case "error":
        return (
          <p className="flex items-center gap-1.5 text-xs text-status-danger">
            <Warning size={12} aria-hidden="true" />
            {e.text}
          </p>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div
          role="log"
          aria-live="polite"
          aria-label="Conversation with the AI"
          className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-6"
        >
          {events.length === 0 ? <p className="py-12 text-center text-sm text-text-muted">Tell the AI what to build.</p> : null}
          {rows.map((row) =>
            row[0].kind === "tool" ? (
              <div key={row[0].n} className="flex flex-col gap-1">
                {row.map((e) => (
                  <div key={e.n}>{renderEvent(e)}</div>
                ))}
              </div>
            ) : (
              <div key={row[0].n}>{renderEvent(row[0])}</div>
            ),
          )}
          {working ? (
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <span className="size-2 shrink-0 rounded-full bg-text-muted motion-safe:animate-pulse" aria-hidden="true" />
              <span className="min-w-0 flex-1">Working…</span>
              {can ? (
                <Button variant="quiet" size="sm" onClick={() => void stop()}>
                  <Stop size={13} weight="fill" aria-hidden="true" />
                  Stop
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {can ? (
      <div className="border-t border-line-subtle bg-surface-raised px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-[760px]">
          {sendError ? (
            <p role="alert" className="mb-1.5 text-xs text-status-danger">
              {sendError}
            </p>
          ) : null}
          <div className="flex items-end gap-2">
            <textarea
              ref={taRef}
              aria-label="Message the AI"
              className="field-textarea min-w-0 flex-1 resize-none"
              rows={1}
              value={draft}
              disabled={busy}
              placeholder={busy ? "The AI is working…" : "Ask for a change, or describe what to build next…"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <Button
              variant="primary"
              iconOnly
              aria-label="Send"
              className="min-h-11 min-w-11"
              disabled={busy || sending || draft.trim() === ""}
              onClick={() => void send()}
            >
              <PaperPlaneRight size={16} weight="fill" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
      ) : null}
    </div>
  );
}
