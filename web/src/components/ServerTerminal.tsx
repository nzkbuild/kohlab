import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Plus, Terminal, X } from "@phosphor-icons/react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { Button, SkeletonRows } from "./ui";

// xterm is large: the page loads it only when it opens, as the project terminal does.
const TerminalView = lazy(() => import("./TerminalView"));

interface Tab {
  id: string;
  label: string;
}

/**
 * The owner's shell on the server, not a project. Its terminal workspace is created on first use
 * (POST /api/server-shell); its tabs are plain terminals on that workspace, like the project panel's.
 */
export default function ServerTerminal() {
  const [serverId, setServerId] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([{ id: "main", label: "Terminal 1" }]);
  const [active, setActive] = useState("main");
  const seq = useRef(1);

  useEffect(() => {
    let alive = true;
    api.serverShell().then(
      ({ id }) => alive && setServerId(id),
      (e: Error) => alive && setFailed(e.message),
    );
    return () => {
      alive = false;
    };
  }, []);

  const addTab = () => {
    seq.current += 1;
    const id = `shell-${Date.now()}`;
    setTabs((items) => [...items, { id, label: `Terminal ${seq.current}` }]);
    setActive(id);
  };

  // Closing a tab ends its shell on the server too. The last tab closed gives a fresh one, so the page is never empty.
  const closeTab = (id: string) => {
    if (serverId) void api.closeTerminal(serverId, id).catch(() => {});
    const rest = tabs.filter((t) => t.id !== id);
    if (rest.length === 0) {
      seq.current += 1;
      const fresh = { id: `shell-${Date.now()}`, label: `Terminal ${seq.current}` };
      setTabs([fresh]);
      setActive(fresh.id);
      return;
    }
    setTabs(rest);
    if (active === id) setActive(rest[rest.length - 1].id);
  };

  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <div className="cockpit max-md:overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 pb-2">
          <h1 className="m-0 text-base font-medium text-text-primary">Terminal on the server</h1>
          <p className="m-0 min-w-0 flex-1 truncate text-sm text-text-muted">A shell on the server itself, not in a project. It runs as the server&apos;s user.</p>
        </header>

        {serverId ? (
          <div className="flex shrink-0 items-center gap-1 px-3 pb-1.5">
            <div role="group" aria-label="Terminals" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {tabs.map((tab) => {
                const isActive = tab.id === current.id;
                return (
                  <span key={tab.id} className={cn("flex shrink-0 items-center gap-0.5 rounded-lg pr-0.5", isActive && "bg-surface-active")}>
                    <button
                      type="button"
                      aria-pressed={isActive}
                      onClick={() => setActive(tab.id)}
                      className={cn(
                        "inline-flex h-8 items-center gap-2 rounded-lg px-2.5 text-sm whitespace-nowrap",
                        isActive ? "text-text-primary" : "text-text-muted hover:text-text-primary",
                      )}
                    >
                      {isActive ? <Terminal size={14} aria-hidden="true" /> : null}
                      {tab.label}
                    </button>
                    <Button variant="quiet" size="sm" iconOnly aria-label={`Close ${tab.label}`} onClick={() => closeTab(tab.id)}>
                      <X size={12} aria-hidden="true" />
                    </Button>
                  </span>
                );
              })}
            </div>
            <Button variant="quiet" size="sm" iconOnly aria-label="New terminal" onClick={addTab}>
              <Plus size={14} aria-hidden="true" />
            </Button>
          </div>
        ) : null}

        {/* The terminal sits in the same calm dark panel as a project's Terminal tab. */}
        <div className="mx-3 mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] bg-surface-terminal">
          {failed ? (
            <p role="alert" className="m-0 px-5 pt-3 text-sm text-text-secondary">
              {`The server terminal can't open. ${failed}`}
            </p>
          ) : serverId ? (
            <div className="min-h-0 flex-1">
              <Suspense fallback={<SkeletonRows rows={3} className="p-4" />}>
                <TerminalView key={`${serverId}:${current.id}`} workspaceId={serverId} terminalId={current.id} onExit={() => closeTab(current.id)} autoFocus />
              </Suspense>
            </div>
          ) : (
            <SkeletonRows rows={3} className="p-4" />
          )}
        </div>
      </div>
    </div>
  );
}
