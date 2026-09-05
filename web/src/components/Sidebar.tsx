import { useEffect, useState } from "react";
import { PlusCircle, FolderOpen, GithubLogo } from "@phosphor-icons/react";
import { api } from "../api";
import { useApp } from "../store";
import { withToast } from "../lib/actions";
import type { Workspace } from "../types";

function statusDot(w: Workspace) {
  if (w.running) return <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />;
  if (w.stopped) return <span className="w-2 h-2 rounded-full bg-amber-400" />;
  return <span className="w-2 h-2 rounded-full bg-zinc-600" />;
}

export default function Sidebar() {
  const { workspaces, selectedId, view, select, setView, refresh } = useApp();
  const [task, setTask] = useState("");
  const [repo, setRepo] = useState("");
  const [agent, setAgent] = useState("omp");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [ghRepos, setGhRepos] = useState<string[]>([]);
  const [ghAuthed, setGhAuthed] = useState(false);

  useEffect(() => {
    void refresh();
    void api.ghRepos().then((result) => {
      setGhAuthed(result.authed);
      setGhRepos(result.repos);
    });
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const goWorkspace = (id: string) => {
    setView("workspaces");
    select(id);
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!task.trim()) return;
    setBusy(true);
    try {
      const isUrl = /^https?:\/\//.test(repo.trim());
      const w = await withToast("Creating workspace", async () =>
        isUrl
          ? api.clone({ url: repo.trim(), task: task.trim(), agent })
          : api.create({ task: task.trim(), repo: repo.trim() || undefined, agent }),
      );
      setTask("");
      await refresh();
      setView("workspaces");
      goWorkspace(w.id);
    } catch (err) {
      console.error(err);
    }
    setBusy(false);
  };

  return (
    <aside className="w-72 min-w-72 bg-[#0f141d] border-r border-[#232d42] flex flex-col">
      <div className="px-4 py-3.5 border-b border-[#232d42] flex items-center gap-2.5">
        <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-[0_0_10px_#34d399]" />
        <span className="font-bold tracking-tight">kohlab</span>
        <span className="text-zinc-500 text-[10px] ml-auto">agent workspaces</span>
      </div>

      <div className="flex gap-1 mx-3 mt-2">
        <button
          onClick={() => setView("dashboard")}
          className={`flex-1 py-1.5 rounded-lg text-xs transition ${
            view === "dashboard" ? "bg-[#182032] text-[#d7e0ee]" : "text-[#7a869c] hover:bg-[#131926]"
          }`}
        >
          dashboard
        </button>
        <button
          onClick={() => setView("settings")}
          className={`flex-1 py-1.5 rounded-lg text-xs transition ${
            view === "settings" ? "bg-[#182032] text-[#d7e0ee]" : "text-[#7a869c] hover:bg-[#131926]"
          }`}
        >
          settings
        </button>
      </div>

      <button
        onClick={() => setShowForm((v) => !v)}
        className="mx-3 mt-3 flex items-center justify-center gap-2 py-2 rounded-lg bg-emerald-400 text-[#04120b] font-semibold text-sm hover:brightness-110 active:scale-[0.98] transition"
      >
        <PlusCircle weight="bold" size={16} />
        new workspace
      </button>

      {showForm && (
        <form onSubmit={create} className="mx-3 mt-2 p-3 rounded-xl bg-[#131926] border border-[#232d42] flex flex-col gap-2">
          <input
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="task description"
            required
            className="bg-[#0f141d] border border-[#232d42] rounded-lg px-2.5 py-2 text-sm outline-none focus:border-emerald-400"
          />
          {ghAuthed && ghRepos.length > 0 && (
            <select
              defaultValue=""
              onChange={(e) => {
                const ownerRepo = e.target.value.split("\t")[0];
                if (ownerRepo) setRepo(`https://github.com/${ownerRepo}.git`);
              }}
              className="bg-[#0f141d] border border-[#232d42] rounded-lg px-2.5 py-2 text-sm outline-none focus:border-emerald-400"
            >
              <option value="">choose a GitHub repo</option>
              {ghRepos.map((entry) => {
                const [name, description] = entry.split("\t");
                return <option key={name} value={entry}>{name}{description ? ` - ${description}` : ""}</option>;
              })}
            </select>
          )}
          {!ghAuthed && (
            <div className="text-[11px] text-amber-400">GitHub not connected. Run `gh auth login` on the server.</div>
          )}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="repo path or GitHub URL"
                className="w-full bg-[#0f141d] border border-[#232d42] rounded-lg px-2.5 py-2 text-sm outline-none focus:border-emerald-400"
              />
              <GithubLogo size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600" />
            </div>
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              className="bg-[#0f141d] border border-[#232d42] rounded-lg px-2 py-2 text-sm outline-none focus:border-emerald-400"
            >
              {["omp", "claude", "codex", "opencode", "pi", "gemini", "sh"].map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={busy || !task}
            className="py-1.5 rounded-lg bg-[#1a2130] border border-[#232d42] text-sm hover:border-emerald-400 disabled:opacity-40 transition"
          >
            {busy ? "creating..." : "create"}
          </button>
        </form>
      )}

      <nav className="flex-1 overflow-y-auto p-2">
        {workspaces.length === 0 && (
          <div className="text-zinc-500 text-xs text-center mt-10 px-4 leading-5">
            no workspaces yet
            <br />
            create one to launch your first agent
          </div>
        )}
        {workspaces.map((w) => (
          <div
            key={w.id}
            onClick={() => goWorkspace(w.id)}
            className={`px-2.5 py-2 rounded-lg cursor-pointer border border-transparent transition ${
              w.id === selectedId ? "bg-[#182032] border-[#2c3a55]" : "hover:bg-[#131926]"
            }`}
          >
            <div className="flex items-center gap-2">
              {statusDot(w)}
              <span className="font-medium text-[13px] truncate">{w.id}</span>
            </div>
            <div className="mt-0.5 text-[11px] text-zinc-500 flex gap-2 items-center truncate">
              <span className="text-zinc-300 truncate">{w.task}</span>
              <span className="shrink-0">{w.agent}</span>
            </div>
          </div>
        ))}
      </nav>

      <div className="px-4 py-2.5 border-t border-[#232d42] text-[10px] text-zinc-600 flex items-center gap-1.5">
        <FolderOpen size={12} />
        <span className="truncate">workspaces persist on this server</span>
      </div>
    </aside>
  );
}
