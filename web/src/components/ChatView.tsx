import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowCounterClockwise, Eye, PaperPlaneRight, Check, Stop, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../api";
import type { ChatEvent } from "../types";
import { toastAction } from "../lib/actions";
import { announce } from "../lib/announce";
import { findWorkspace, useApp, useCan } from "../store";
import { workspaceStatus } from "../lib/status";
import ConfirmDialog from "./ConfirmDialog";
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

  // A turn that just ended may have changed files: refresh so the Keep / Undo bar sees it.
  useEffect(() => {
    if (!busy) void refresh();
  }, [busy, refresh]);

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

  // Keep / Undo only while the AI's changes are waiting to be kept or undone.
  const ws = findWorkspace(workspaces, workspaceId);
  const hasChanges = ws !== null && workspaceStatus(ws) === "needs-review";
  // The commit message is the user's last request: its first line, cut to 72 characters.
  const lastRequest = [...events].reverse().find((e) => e.kind === "user")?.text ?? "";
  const keepMessage = (lastRequest.split("\n")[0] ?? "").trim().slice(0, 72).trim() || "Changes from chat";

  const preview = async () => {
    setPreviewing(true);
    // Opened inside the click so popup blockers allow it; pointed at the page once the server answers.
    const tab = window.open("", "_blank");
    try {
      const { url } = await api.preview(workspaceId);
      if (tab) {
        tab.opener = null;
        tab.location.href = location.origin + url;
      } else window.open(location.origin + url, "_blank", "noopener");
    } catch (e) {
      tab?.close();
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
          <div className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-surface-active px-4 py-2.5 text-sm text-text-primary">{e.text}</div>
          </div>
        );
      case "assistant":
        return <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-primary">{inlineMarkdown(e.text)}</p>;
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
          {!busy ? (
            <div role="toolbar" aria-label="Project actions" className="mb-2 flex flex-wrap items-center gap-2">
              {hasChanges ? <p className="mr-auto min-w-0 text-sm text-text-secondary">The AI changed your project.</p> : null}
              <Button variant="secondary" size="sm" className="min-h-11" disabled={previewing} onClick={() => void preview()}>
                <Eye size={14} aria-hidden="true" />
                Preview
              </Button>
              {hasChanges ? (
                <>
                  <Button variant="primary" size="sm" className="min-h-11" disabled={keeping} onClick={() => void keep()}>
                    <Check size={14} aria-hidden="true" />
                    Keep
                  </Button>
                  <Button variant="quiet" size="sm" className="min-h-11 text-status-danger" disabled={undoing} onClick={() => setConfirmUndo(true)}>
                    <ArrowCounterClockwise size={14} aria-hidden="true" />
                    Undo
                  </Button>
                </>
              ) : null}
            </div>
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
      <ConfirmDialog
        open={confirmUndo}
        onOpenChange={(v) => {
          if (!v) setConfirmUndo(false);
        }}
        title="Undo the changes?"
        description="Everything the AI changed since you last pressed Keep will be removed. This can't be reversed."
        confirmLabel="Undo"
        busy={undoing}
        onConfirm={() => void undo()}
      />
    </div>
  );
}
