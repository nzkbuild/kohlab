import { lazy, Suspense, useState } from "react";
import { Play, Stop, ArrowsClockwise, ShareNetwork, Trash, Terminal, Files, GitDiff, Plus, X, Scroll } from "@phosphor-icons/react";
import { api } from "../api";
import { toastAction } from "../lib/actions";
import { useApp } from "../store";
import TerminalView, { disposeWorkspaceTerminals } from "./TerminalView";
import BrowseView from "./BrowseView";
import LogView from "./LogView";
// Monaco is heavy (~600 KB) — load it only when files/diff are actually opened
const DiffView = lazy(() => import("./DiffView"));

type Tab = "terminal" | "files" | "diff" | "log";

export default function WorkspaceDetail({ workspaceId }: { workspaceId: string }) {
  const { workspaces, refresh, select } = useApp();
  const [tab, setTab] = useState<Tab>("terminal");
  const [terminals, setTerminals] = useState([{ id: "main", label: "agent" }]);
  const [activeTerminal, setActiveTerminal] = useState("main");
  const w = workspaces.find((x) => x.id === workspaceId);

  const act = async (action: string) => {
    try {
      await toastAction(workspaceId, action);
      await refresh();
    } catch (e) {
      console.error(e);
    }
  };

  if (!w) return <div className="flex-1 flex items-center justify-center text-zinc-500">loading...</div>;

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="flex items-center gap-2 px-3.5 py-2 border-b border-[#232d42] bg-[#0f141d]">
        <span className="font-semibold text-sm truncate">{w.id}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${w.running ? "text-emerald-400 border-emerald-400/40 bg-emerald-400/10" : "text-zinc-500 border-zinc-700"}`}>
          {w.running ? "running" : w.stopped ? "done" : "stopped"}
        </span>
        <span className="text-zinc-600 text-xs truncate hidden md:block">{w.path}</span>
        <div className="flex-1" />
        <button onClick={() => void act("start")} disabled={w.running} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-emerald-400/40 text-emerald-400 text-xs disabled:opacity-35 hover:bg-emerald-400/10 transition" title="start">
          <Play size={12} weight="fill" /> start
        </button>
        <button onClick={() => void act("restart")} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[#232d42] text-xs hover:border-emerald-400 transition" title="restart">
          <ArrowsClockwise size={12} /> restart
        </button>
        <button
          onClick={async () => {
            try {
              const s = await api.share(workspaceId);
              const link = `${location.origin}/?share=${s.share}`;
              await navigator.clipboard.writeText(link).catch(() => {});
            } catch (e) {
              console.error(e);
            }
          }}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[#232d42] text-xs hover:border-emerald-400 transition" title="copy share link"
        >
          <ShareNetwork size={12} /> share
        </button>
        <button onClick={() => void act("stop")} disabled={!w.running} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-red-400/40 text-red-400 text-xs disabled:opacity-35 hover:bg-red-400/10 transition" title="stop">
          <Stop size={12} weight="fill" /> stop
        </button>
        <button
          onClick={async () => {
            if (!confirm("delete this workspace? worktree will be removed")) return;
            disposeWorkspaceTerminals(workspaceId);
            await act("delete");
            select(null);
          }}
        >
          <Trash size={12} /> delete
        </button>
      </div>

      <div className="flex gap-1 px-2 border-b border-[#232d42] bg-[#0f141d]">
        {([["terminal", Terminal], ["files", Files], ["diff", GitDiff], ["log", Scroll]] as [Tab, typeof Terminal][]).map(([t, Icon]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs border-b-2 transition ${tab === t ? "text-zinc-100 border-emerald-400" : "text-zinc-500 border-transparent hover:text-zinc-300"}`}
          >
            <Icon size={13} /> {t}
          </button>
        ))}
      </div>
      {tab === "terminal" && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[#232d42] bg-[#0a0e14] overflow-x-auto">
          {terminals.map((term) => (
            <button
              key={term.id}
              onClick={() => setActiveTerminal(term.id)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] border transition ${activeTerminal === term.id ? "bg-[#182032] border-[#2c3a55] text-zinc-200" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
            >
              <Terminal size={12} />
              {term.label}
              {term.id !== "main" && (
                <X
                  size={11}
                  onClick={(e) => {
                    e.stopPropagation();
                    setTerminals((items) => items.filter((item) => item.id !== term.id));
                    if (activeTerminal === term.id) setActiveTerminal("main");
                  }}
                />
              )}
            </button>
          ))}
          <button
            onClick={() => {
              const id = `terminal-${Date.now()}`;
              setTerminals((items) => [...items, { id, label: `shell ${items.length}` }]);
              setActiveTerminal(id);
            }}
            className="p-1 rounded text-zinc-500 hover:text-emerald-400 hover:bg-[#131926] transition"
            title="new terminal"
          >
            <Plus size={13} />
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {tab === "terminal" && <TerminalView key={`${workspaceId}:${activeTerminal}`} workspaceId={workspaceId} terminalId={activeTerminal} />}
        {tab === "files" && <BrowseView workspaceId={workspaceId} />}
        {tab === "log" && <LogView workspaceId={workspaceId} />}
        {tab === "diff" && (
          <Suspense fallback={<div className="p-4 text-zinc-500 text-sm">loading diff...</div>}>
            <DiffView workspaceId={workspaceId} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
