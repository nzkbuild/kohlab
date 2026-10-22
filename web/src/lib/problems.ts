import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Problem } from "../types";
import { problemsMessage } from "./problemText";

/** How often a screen that shows problems asks the server again. */
const POLL_MS = 5000;

/**
 * The project's problems, polled while `active`. `key` identifies this exact
 * list, so a "Not now" can hide it until something new goes wrong.
 */
export function useProblems(id: string, active: boolean): { problems: Problem[]; key: string; refresh: () => void } {
  const [state, setState] = useState<{ id: string; problems: Problem[]; key: string }>({ id, problems: [], key: "" });

  const load = useCallback(() => {
    api
      .problems(id)
      .then((r) => setState((s) => (s.id === id && s.key === r.key ? s : { id, problems: r.problems, key: r.key })))
      .catch(() => {
        /* a failed read keeps the last list; the next poll tries again */
      });
  }, [id]);

  useEffect(() => {
    if (!active) return;
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  // A list from another project is never shown here.
  const mine = state.id === id;
  return { problems: mine ? state.problems : [], key: mine ? state.key : "", refresh: load };
}

/** Sends the problems to the AI as a message, then clears them. The caller shows errors and moves to the chat. */
export async function askToFix(id: string, problems: Problem[]): Promise<void> {
  await api.chatSend(id, problemsMessage(problems));
  await api.clearProblems(id);
}
