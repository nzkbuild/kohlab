import { useEffect } from "react";
import { useApp } from "./store";
import AuthGate from "./components/AuthGate";
import Sidebar from "./components/Sidebar";
import WorkspaceDetail from "./components/WorkspaceDetail";
import AgentInstaller from "./components/AgentInstaller";
import { api } from "./api";

export default function App() {
  const { authed, setAuthed, selectedId, refresh } = useApp();

  useEffect(() => {
    const key = new URLSearchParams(location.search).get("key") || localStorage.getItem("kohlab_key");
    if (key) {
      void api.testKey(key).then((ok) => {
        if (ok) setAuthed(true);
      });
    }
  }, [setAuthed]);

  useEffect(() => {
    if (authed) void refresh();
  }, [authed, refresh]);

  if (!authed) return <AuthGate />;

  return (
    <div className="h-full flex">
      <Sidebar />
      <main className="flex-1 min-w-0 flex flex-col">
        {selectedId ? (
          <WorkspaceDetail workspaceId={selectedId} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-zinc-500">
            <div className="text-center">
              <div className="text-lg mb-2">select a workspace</div>
              <AgentInstaller compact />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
