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

  // done-ping (v1.10): the server broadcasts `workspace.done` over the shared
  // WebSocket when an agent finishes. Ping once per workspace: refresh the
  // list, flash the title, and (on first grant) a browser notification.
  useEffect(() => {
    if (!authed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      ws = new WebSocket(`${proto}//${location.host}`);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { type?: string; id?: string; task?: string };
          if (msg.type !== "workspace.done" || !msg.id) return;
          if (notified.current.has(msg.id)) return;
          notified.current.add(msg.id);
          void refresh();
          document.title = `✓ ${msg.id} finished — needs review`;
          setTimeout(() => {
            document.title = baseTitle;
          }, 5000);
          if ("Notification" in window) {
            const ping = () => new Notification("kohlab — needs review", { body: msg.task || `${msg.id} finished` });
            if (Notification.permission === "granted") ping();
            else if (Notification.permission === "default") void Notification.requestPermission().then((p) => p === "granted" && ping());
          }
        } catch {
          // non-JSON frames are terminal bytes, never push messages
        }
      };
      ws.onclose = () => {
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
      <div className="h-full flex">
        <Sidebar />
        <main className="flex-1 min-w-0 flex flex-col">
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