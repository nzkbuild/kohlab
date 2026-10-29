/** The checklist and the background task list shown in the chat. */
import { useState } from "react";
import { CaretRight, CheckCircle, Circle } from "@phosphor-icons/react";
import { cn } from "../../lib/utils";
import { Button } from "../ui";

/** Claude's checklist (its TodoWrite list): one row with the count and the active item, the full list when opened. */
export type Todo = { text: string; status: "pending" | "active" | "done" };
export function Checklist({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(false);
  const done = todos.filter((t) => t.status === "done").length;
  const active = todos.find((t) => t.status === "active");
  return (
    <div className="rounded-card bg-surface-raised px-4 py-2.5 text-sm">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full min-w-0 items-center gap-2 text-left text-text-secondary">
        <span className="shrink-0 tabular-nums">{done} of {todos.length} done</span>
        {active ? <span className="min-w-0 flex-1 truncate text-text-primary">{active.text}</span> : <span className="flex-1" />}
        <CaretRight size={14} aria-hidden="true" className={cn("shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <ul aria-label="Checklist" className="mt-2 flex flex-col gap-2">
          {todos.map((t, i) => (
            <li
              key={i}
              className={cn(
                "flex min-w-0 items-center gap-2",
                t.status === "done" ? "text-text-muted line-through" : t.status === "active" ? "font-medium text-text-primary" : "text-text-muted",
              )}
            >
              {t.status === "done" ? (
                <CheckCircle size={16} className="shrink-0" aria-hidden="true" />
              ) : t.status === "active" ? (
                <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
                  <span className="size-2 rounded-full bg-text-primary motion-safe:animate-pulse" />
                </span>
              ) : (
                <Circle size={16} className="shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 truncate">{t.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A background task the CLI runs: its id (to stop it), its kind and what it does. */
export interface BgTask {
  id: string;
  type: string;
  description: string;
}

/** The background tasks, each with a Stop. Opened from the "in background" text. */
export function TaskList({ tasks, stopping, onStop }: { tasks: BgTask[]; stopping: string | null; onStop: (id: string) => void }) {
  return (
    <ul aria-label="Background tasks" className="flex flex-col gap-1 pl-5 text-sm text-text-muted">
      {tasks.map((t) => (
        <li key={t.id} className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{t.description || "A background task"}</span>
          <Button
            variant="quiet"
            size="sm"
            className="text-xs text-text-secondary"
            disabled={stopping !== null}
            aria-label={`Stop ${t.description || "background task"}`}
            onClick={() => onStop(t.id)}
          >
            Stop
          </Button>
        </li>
      ))}
    </ul>
  );
}
