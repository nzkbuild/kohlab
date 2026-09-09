import { useEffect, useRef } from "react";
import { Toaster } from "sonner";
import { useApp } from "./store";
import AuthGate from "./components/AuthGate";
import Sidebar from "./components/Sidebar";
import WorkspaceDetail from "./components/WorkspaceDetail";
import Onboarding from "./components/Onboarding";
import Dashboard from "./components/Dashboard";
import Settings from "./components/Settings";
import CommandPalette from "./components/CommandPalette";
import { api } from "./api";

const baseTitle = document.title || "kohlab";

export default function App() {
  const { authed, setAuthed, selectedId, view, refresh } = useApp();
  const notified = useRef<Set<string>>(new Set());

  useEffect(() => {
    // If the server has no access key configured, skip the login gate entirely.
    // Only prompt when auth is actually required.
    void api.authRequired().then((required) => {
      if (required) {
        const key = new URLSearchParams(location.search).get("key") || localStorage.getItem("kohlab_key");
        if (key) {
          void api.testKey(key).then((ok) => {
            if (ok) setAuthed(true);
          });
        }
      } else {
        setAuthed(true);
      }
    });
  }, [setAuthed]);

  useEffect(() => {
    if (authed) void refresh();
  }, [authed, refresh]);

  // done-ping: the server broadcasts `workspace.done` over a WebSocket when an
  // agent finishes. This listener uses its OWN socket — the cockpit terminal
  // keeps its own ws — and reconnects at most every 3s, so a dropped link
  // can't turn into a retry storm. Non-JSON frames (raw terminal bytes) are
  // ignored.
  useEffect(() => {
    if (!authed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";

    const wsUrl = `${proto}//${location.host}`;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        let msg: { type?: string; id?: string; task?: string } | null = null;
        try {
          msg = JSON.parse(ev.data) as { type?: string; id?: string; task?: string };
        } catch {
          return;
        }
        if (msg?.type !== "workspace.done" || !msg.id) return;
        if (notified.current.has(msg.id)) return;
        notified.current.add(msg.id);
        void refresh();
        document.title = `✓ ${msg.id} finished — needs review`;
        setTimeout(() => {
          document.title = baseTitle;
        }, 5000);
        if ("Notification" in window) {
          const ping = () => new Notification("kohlab — needs review", { body: msg?.task || `${msg.id} finished` });
          if (Notification.permission === "granted") ping();
          else if (Notification.permission === "default") void Notification.requestPermission().then((p) => p === "granted" && ping());
        }
      };
      ws.onclose = () => {
        if (closed) return;
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [authed, refresh]);
  if (!authed) return <AuthGate />;

  return (
    <>
      <CommandPalette />
      <Toaster
        theme="dark"
        position="bottom-right"
        richColors
        toastOptions={{ style: { background: "#151517", border: "1px solid #27272a", color: "#e4e4e7" } }}
      />
      <div className="flex h-full bg-background text-foreground">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          {view === "dashboard" && <Dashboard />}
          {view === "settings" && <Settings />}
          {view === "workspaces" &&
            (selectedId ? (
              <WorkspaceDetail workspaceId={selectedId} />
            ) : (
              <Onboarding />
            ))}
        </main>
      </div>
    </>
  );
}