import { useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import { durationText, stripText } from "../lib/aiHub";
import { cn } from "../lib/utils";

interface Props {
  ai: string;
  account: string | null;
  model: string | null;
  mode: string | null;
  /** "Ready", "Working", "Waiting for you", "In the background" */
  state: string;
  /** While the AI works: when the turn started (ms on this device), so the line can say how long. */
  since?: number | null;
  /** "2 helpers working" */
  extra?: string | null;
  /** The model the next message alone will use: named in the line, with a small button to drop it. */
  next?: { label: string; onClear: () => void } | null;
  /** The Run panel is open (docked or as a sheet). */
  expanded: boolean;
  onToggle: () => void;
  className?: string;
}

/**
 * The one line above the composer that names the AI, its account, model and mode, and what it is doing. Text only: no fill, chip,
 * icon or animation. The whole line is a button that opens the Run panel. The timer ticks only while the AI works.
 */
export default function RunStrip({ ai, account, model, mode, state, since = null, extra = null, next = null, expanded, onToggle, className }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [since]);
  const timed = since !== null ? `${state} ${durationText(now - since)}` : state;
  const parts = { ai, account, model, mode, state: timed, stateShort: state, extra, next: next?.label ?? null };
  return (
    <div className={cn("mb-1 flex w-full min-w-0 items-center", className)}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Run details. ${stripText({ ...parts, state, extra })}`}
        onClick={onToggle}
        className="flex min-h-8 min-w-0 flex-1 items-center rounded-lg px-4 text-left text-sm text-text-muted transition-colors hover:text-text-primary focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11 motion-reduce:transition-none"
      >
        <span className="hidden truncate md:block">{stripText(parts)}</span>
        <span className="block truncate md:hidden">{stripText(parts, true)}</span>
      </button>
      {next ? (
        <button
          type="button"
          aria-label={`Don't use ${next.label} for the next message`}
          title="Use the usual model for the next message"
          onClick={next.onClear}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-text-muted hover:text-text-primary focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:size-11"
        >
          <X size={12} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
