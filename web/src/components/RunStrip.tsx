import { useEffect, useState } from "react";
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
  /** The Run panel is open (docked or as a sheet). */
  expanded: boolean;
  onToggle: () => void;
  className?: string;
}

/**
 * The one line above the composer that names the AI, its account, model and mode, and what it is doing. Text only: no fill, chip,
 * icon or animation. The whole line is a button that opens the Run panel. The timer ticks only while the AI works.
 */
export default function RunStrip({ ai, account, model, mode, state, since = null, extra = null, expanded, onToggle, className }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [since]);
  const timed = since !== null ? `${state} ${durationText(now - since)}` : state;
  const parts = { ai, account, model, mode, state: timed, stateShort: state, extra };
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`Run details. ${stripText({ ...parts, state, extra })}`}
      onClick={onToggle}
      className={cn(
        "mb-1 flex min-h-8 items-center w-full min-w-0 rounded-lg px-4 text-left text-sm text-text-muted transition-colors hover:text-text-primary focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11 motion-reduce:transition-none",
        className,
      )}
    >
      <span className="hidden truncate md:block">{stripText(parts)}</span>
      <span className="block truncate md:hidden">{stripText(parts, true)}</span>
    </button>
  );
}
