import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../store";
import { MODEL_LABEL, modelOf } from "../lib/projectActions";
import { isApple } from "../lib/platform";
import { Kbd } from "./ui";

/**
 * Power mode's strip along the bottom of the shell. A layout row, not an
 * overlay, so it never covers content; desktop only, from the 900px breakpoint.
 */
export default function StatusBar() {
  const route = useApp((s) => s.route);
  const workspaces = useApp((s) => s.workspaces);
  const [connected, setConnected] = useState<boolean | null>(null);

  // Read once when the bar appears: no polling. A failed read shows nothing rather than a guess.
  useEffect(() => {
    let alive = true;
    api
      .agentsStatus()
      .then((status) => {
        if (alive) setConnected(!!status.claude && status.claudeSignedIn !== false);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const w = route.kind === "workspace" ? workspaces.find((x) => x.id === route.id) : undefined;

  return (
    <footer className="hidden h-[26px] shrink-0 items-center gap-4 bg-surface-sidebar px-3 text-xs text-text-faint min-[56.25rem]:flex">
      {connected === null ? null : <span>{connected ? "Claude connected" : "Claude isn't connected"}</span>}
      {w ? <span className="shrink-0">{MODEL_LABEL[modelOf(w)]}</span> : null}
      {w ? <span className="mono min-w-0 truncate">{w.path}</span> : null}
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <span className="flex items-center gap-1.5">
          <Kbd>Ctrl `</Kbd> Terminal
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>{isApple ? "⌘K" : "Ctrl K"}</Kbd> Commands
        </span>
      </span>
    </footer>
  );
}
