import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp, useCan } from "../store";
import { isApple, isTouchOnly } from "../lib/platform";
import { agentName, isAiAgent } from "../lib/agentName";
import type { AgentStatus } from "../types";
import { Kbd } from "./ui";

/**
 * Power mode's strip along the bottom of the shell. A layout row, not an
 * overlay, so it never covers content; desktop only, from the 900px breakpoint.
 */
export default function StatusBar() {
  const route = useApp((s) => s.route);
  const workspaces = useApp((s) => s.workspaces);
  const navigate = useApp((s) => s.navigate);
  const requestPanel = useApp((s) => s.requestPanel);
  const can = useCan();
  const [status, setStatus] = useState<AgentStatus | null>(null);

  // Read once when the bar appears: no polling. A failed read shows nothing rather than a guess.
  useEffect(() => {
    let alive = true;
    api
      .agentsStatus()
      .then((status) => {
        if (alive) setStatus(status);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const w = route.kind === "workspace" ? workspaces.find((x) => x.id === route.id) : undefined;
  // The AI of the open project, or Claude on the other pages.
  const key = isAiAgent(w?.agent) ? w!.agent : "claude";
  const connected = status === null ? null : key === "claude" ? !!status.claude && status.claudeSignedIn !== false : status[key] === true && (key !== "codex" || status.codexSignedIn !== false);
  const who = agentName(key);

  // In a project, the hint opens its terminal panel; anywhere else, the owner's server terminal.
  const openTerminal = () => {
    if (route.kind === "workspace") requestPanel({ workspaceId: route.id, action: "terminal" });
    else if (route.kind !== "terminal") navigate({ kind: "terminal" });
  };
  const canTerminal = route.kind === "workspace" ? can.mutate : can.own;

  return (
    <footer className="hidden h-[26px] shrink-0 items-center gap-4 bg-surface-sidebar px-3 text-xs text-text-faint min-[56.25rem]:flex">
      {connected === null ? null : <span>{connected ? `${who} connected` : `${who} isn't connected`}</span>}
      {w ? <span className="mono min-w-0 truncate">{w.path}</span> : null}
      {isTouchOnly() ? null : (
        <span className="ml-auto flex shrink-0 items-center gap-3 whitespace-nowrap">
          <span className="flex items-center gap-2">
            {canTerminal ? (
              <button type="button" className="rounded-row hover:text-text-secondary" onClick={openTerminal}>
                <Kbd>Ctrl `</Kbd> Terminal
              </button>
            ) : (
              <span>
                <Kbd>Ctrl `</Kbd> Terminal
              </span>
            )}
          </span>
          <span className="flex items-center gap-2">
            <Kbd>{isApple ? "⌘K" : "Ctrl K"}</Kbd> Commands
          </span>
        </span>
      )}
    </footer>
  );
}
