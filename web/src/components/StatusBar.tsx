import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../store";
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

  return (
    <footer className="hidden h-[26px] shrink-0 items-center gap-4 bg-surface-sidebar px-3 text-xs text-text-faint min-[56.25rem]:flex">
      {connected === null ? null : <span>{connected ? `${who} connected` : `${who} isn't connected`}</span>}
      {w ? <span className="mono min-w-0 truncate">{w.path}</span> : null}
      {isTouchOnly() ? null : (
        <span className="ml-auto flex shrink-0 items-center gap-3 whitespace-nowrap">
          <span className="flex items-center gap-1.5">
            <Kbd>Ctrl `</Kbd> Terminal
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>{isApple ? "⌘K" : "Ctrl K"}</Kbd> Commands
          </span>
        </span>
      )}
    </footer>
  );
}
