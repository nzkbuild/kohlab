import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, FileText, Pause, Play } from "@phosphor-icons/react";
import { api } from "../api";
import { useApp } from "../store";
import { workspaceStatus } from "../lib/status";
import { Button, EmptyState, StatusChip } from "./ui";

interface Props {
  workspaceId: string;
}

const POLL_MS = 3000;
/** Below this many px from the bottom the tail counts as "pinned". */
const PIN_THRESHOLD_PX = 24;

/** Terminal control sequences are noise in a plain-text tail. */
const OSC = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const CSI = /\u001B\[[0-?]*[ -\/]*[@-~]/g;
const ESC = /\u001B[@-Z\\-_]/g;
/** A leading timestamp, if the process prints one. */
const LEADING_TIME = /^\[?(\d{4}-\d{2}-\d{2}[T ])?(\d{2}:\d{2}:\d{2})(?:[.,]\d{1,6})?\]?\s*/;

interface LogLine {
  /** 1-based line number — the gutter keeps a hold on the reader's place. */
  n: number;
  time: string | null;
  text: string;
}

function parseLog(log: string): LogLine[] {
  if (!log) return [];
  const rows = log.replace(OSC, "").replace(CSI, "").replace(ESC, "").split("\n");
  if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows.map((row, i) => {
    // A carriage return rewrites the row in place, so the LAST segment is what
    // the terminal is showing for a spinner or progress bar.
    const raw = row.includes("\r") ? (row.split("\r").pop() ?? "") : row;
    const match = LEADING_TIME.exec(raw);
    return { n: i + 1, time: match ? match[2] : null, text: match ? raw.slice(match[0].length) : raw };
  });
}

/**
 * Session log tail. Polls the same endpoint on the same cadence as before, but
 * (a) does no work while the tab is hidden and (b) never moves the viewport out
 * from under someone reading scrollback.
 */
export default function LogView({ workspaceId }: Props) {
  const workspace = useApp((s) => s.workspaces.find((w) => w.id === workspaceId));
  const running = workspace?.running ?? false;

  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [pinned, setPinned] = useState(true);
  const [pending, setPending] = useState(0);
  const [nonce, setNonce] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedCountRef = useRef(0);
  const primedRef = useRef(false);

  const lines = useMemo(() => parseLog(log), [log]);

  useEffect(() => {
    let cancelled = false;
    // A backgrounded tab renders nothing anyone can read; polling it is pure
    // server load. The same function doubles as the visibilitychange listener.
    const load = () => {
      if (document.hidden) return;
      api
        .log(workspaceId)
        .then((res) => {
          if (cancelled) return;
          setLog(res.log);
          setError(null);
        })
        .catch((e) => {
          if (!cancelled) setError((e as Error).message);
        });
    };
    load();
    const t = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", load);
    };
  }, [workspaceId, nonce]);

  // Following is an assignment, never a smooth scroll: the tail is a live edge
  // and an animation would fight the bytes arriving behind it.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const count = lines.length;
    const previous = pinnedCountRef.current;
    pinnedCountRef.current = count;

    if (!primedRef.current) {
      primedRef.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (follow && pinned) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (count > previous) setPending((p) => p + (count - previous));
  }, [lines, follow, pinned]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    setFollow(true);
    setPending(0);
    setPinned(true);
    if (el) el.scrollTop = el.scrollHeight;
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
    setPinned(atBottom);
    if (atBottom) setPending(0);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-10 flex-wrap items-center gap-2 border-b border-line-subtle px-3 py-1.5">
        <StatusChip status={workspace ? workspaceStatus(workspace) : "stopped"} />
        <span className="text-2xs text-text-muted">
          {running ? "session log · tailing every 3s" : "session log · not running"}
        </span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant={follow ? "secondary" : "primary"}
          aria-pressed={follow}
          onClick={() => (follow ? setFollow(false) : scrollToBottom())}
        >
          {follow ? <Pause size={12} aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}
          {follow ? "following" : "paused"}
        </Button>
      </div>

      {error ? (
        <div role="alert" className="flex items-center gap-2 border-b border-line-subtle px-3 py-1.5 text-xs text-status-danger">
          <span className="min-w-0 flex-1">log unavailable — {error}</span>
          <Button size="sm" variant="secondary" onClick={() => setNonce((n) => n + 1)}>
            retry
          </Button>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {/* A plain scroll region: the log role is an implicit live region, and
            one line per poll would be read aloud forever. */}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          tabIndex={0}
          aria-label={`Session log for ${workspaceId}`}
          className="h-full overflow-auto"
        >
          {lines.length === 0 ? (
            <EmptyState
              icon={<FileText size={18} />}
              title="No output yet"
              description={
                running
                  ? "The agent is running but has not written anything to the session log yet."
                  : "Nothing has been logged. Start the workspace to attach a terminal and produce output."
              }
            />
          ) : (
            lines.map((line) => (
              <div key={line.n} className="log-line text-xs">
                <span className="log-time w-10 shrink-0 select-none text-right" aria-hidden="true">
                  {line.n}
                </span>
                {line.time ? (
                  <time className="log-time tnum">{line.time}</time>
                ) : null}
                <span className="log-text text-text-secondary">{line.text || " "}</span>
              </div>
            ))
          )}
        </div>

        {pending > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <Button size="sm" variant="primary" className="pointer-events-auto" onClick={scrollToBottom}>
              {pending} new {pending === 1 ? "line" : "lines"}
              <ArrowDown size={12} aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
