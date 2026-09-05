import { useEffect } from "react";
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

export default function App() {
  const { authed, setAuthed, selectedId, view, refresh } = useApp();

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

  if (!authed) return <AuthGate />;

  return (
    <>
      <CommandPalette />
      <Toaster theme="dark" position="bottom-right" />
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
