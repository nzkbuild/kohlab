/** Tool lines and runs, the working line, note lines, and the detail disclosure. */
import { Fragment, useEffect, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import { cn } from "../../lib/utils";
import { ChatEvent, ToolEvent, ToolResult } from "./types";
import { WROTE_LINE, summarizeTools, cap, formatElapsed } from "./text";
import { isToolLine } from "./events";

/** The working line: a pulsing dot, the current action, how long the turn has run, helpers working and background tasks (buttons that open their lists). The timer ticks only while this line is shown. */
export function WorkingLine({
  action,
  step,
  since,
  background,
  tasksOpen,
  onTasks,
  helpers,
  helpersOpen,
  onHelpers,
}: {
  action: string;
  /** "step 2 of 5" while Claude has a checklist, else null */
  step: string | null;
  since: number | null;
  background: number;
  tasksOpen: boolean;
  onTasks: () => void;
  helpers: string[];
  helpersOpen: boolean;
  onHelpers: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <p className="flex items-center gap-2 text-small text-text-muted">
      <span className="pulse-dot size-1.5 shrink-0 rounded-full bg-text-muted" aria-hidden="true" />
      <span className="shimmer-text min-w-0">{action}</span>
      {step ? <span className="shrink-0 tabular-nums">· {step}</span> : null}
      {/* aria-hidden: the timer changes every second and must not be read out */}
      {since !== null ? <span aria-hidden="true" className="tabular-nums text-text-faint">{formatElapsed(now - since)}</span> : null}
      {helpers.length > 0 ? (
        <button type="button" aria-expanded={helpersOpen} onClick={onHelpers} className="rounded px-1 hover:bg-surface-hover hover:text-text-primary">
          · {helpers.length} {helpers.length === 1 ? "helper" : "helpers"} working
        </button>
      ) : null}
      {background > 0 ? (
        <button type="button" aria-expanded={tasksOpen} onClick={onTasks} className="rounded px-1 hover:bg-surface-hover hover:text-text-primary">
          · {background} in background
        </button>
      ) : null}
    </p>
  );
}

/** A run of tool actions: one muted line; the caret opens the list of each action. Collapsed while live too: the working line shows the current step. */
export function ToolRun({ lines, results }: { lines: ChatEvent[]; results: Map<string, ToolResult> }) {
  const [open, setOpen] = useState(false);
  const tools = lines.filter(isToolLine);
  const failed = tools.filter((e) => e.toolId !== undefined && results.get(e.toolId)?.failed).length;
  const summary = summarizeTools(tools.map((e) => e.text)) + (failed ? `, ${failed} failed` : "");
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 items-center gap-2 rounded-lg px-1 text-left text-small text-text-muted hover:bg-surface-hover hover:text-text-primary shell:min-h-8"
      >
        <CaretRight size={14} aria-hidden="true" className={cn("shrink-0 motion-safe:transition-transform", open && "rotate-90")} />
        {cap(summary)}
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-1 pl-6 text-sm text-text-muted">
          {tools.map((e) => (
            <ToolLine key={e.n} e={e} result={e.toolId !== undefined ? results.get(e.toolId) : undefined} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One action in an expanded run: its line, and on a click what it did (the command or the change) and what it gave back. A failed one says so. */
function ToolLine({ e, result }: { e: ToolEvent; result?: ToolResult }) {
  const [open, setOpen] = useState(false);
  if (!e.detail && !result?.output)
    return (
      <li className="flex items-center gap-2 pl-6">
        <span className="min-w-0 flex-1">{e.text}</span>
        {result?.failed ? <span className="shrink-0 text-xs font-medium text-status-danger">Failed</span> : null}
      </li>
    );
  // an edit or a new file: its "+ " and "- " lines are coloured as in the diff
  const isChange = WROTE_LINE.test(e.text);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center gap-2 rounded-lg px-1 text-left hover:bg-surface-hover hover:text-text-primary shell:min-h-8"
      >
        <CaretRight size={14} aria-hidden="true" className={cn("shrink-0 motion-safe:transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1">{e.text}</span>
        {result?.failed ? <span className="shrink-0 text-xs font-medium text-status-danger">Failed</span> : null}
      </button>
      {open ? (
        <div className="mb-1 mt-1 rounded-card bg-surface-sunken">
          {e.detail ? (
            <pre tabIndex={0} className="mono overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 text-xs text-text-secondary">
              {isChange
                ? e.detail.split("\n").map((line, i) => (
                    <Fragment key={i}>
                      {i > 0 ? "\n" : null}
                      <span className={line.startsWith("+ ") ? "text-status-running" : line.startsWith("- ") ? "text-status-danger" : undefined}>{line}</span>
                    </Fragment>
                  ))
                : e.detail}
            </pre>
          ) : null}
          {result?.output ? (
            <>
              <p className="px-3 pt-2 text-xs text-text-muted">Output</p>
              <pre tabIndex={0} className="mono overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 text-xs text-text-secondary">
                {result.output}
              </pre>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The command behind an ask (and its reason, when the card does not already show it), behind a disclosure. */
export function Details({ detail, why, className }: { detail?: string; why?: string; className?: string }) {
  return (
    <details className={cn("text-sm text-text-muted", className)}>
      <summary className="flex min-h-11 cursor-pointer select-none items-center hover:text-text-primary shell:min-h-8">Show details</summary>
      {why ? <p className="pb-2 text-text-secondary">{why}</p> : null}
      {detail ? (
        <pre className="mono mb-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-surface-sunken px-3 py-2 text-sm text-text-secondary">
          {detail}
        </pre>
      ) : null}
    </details>
  );
}

/** A quiet line in the chat, such as "Switched to Hermes": centred, muted, with room above and below. It is not a message. */
export function NoteLine({ text }: { text: string }) {
  return <p className="px-4 text-center text-xs text-text-muted">{text}</p>;
}
