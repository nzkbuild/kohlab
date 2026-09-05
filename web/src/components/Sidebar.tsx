import { useEffect, useState } from "react";
import { Plus, FolderOpen, GithubLogo, SquaresFour, GearSix, TerminalWindow } from "@phosphor-icons/react";
import { api } from "../api";
import { useApp } from "../store";
import { withToast } from "../lib/actions";
import { cn } from "../lib/utils";
import type { Workspace } from "../types";

function statusDot(w: Workspace) {
  if (w.running) return <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399] shrink-0" />;
  if (w.stopped) return <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />;
  return <span className="w-2 h-2 rounded-full bg-zinc-600 shrink-0" />;
}

/**
 * Collapsible icon rail. Collapsed (60px) shows icons only; hovering expands to
 * 300px with labels. Replaces the fixed-width sidebar without losing any of its
 * functions (dashboard/settings nav, workspace list, create form, persist footer).
 */
export default function Sidebar() {
  const { workspaces, selectedId, view, select, setView, refresh } = useApp();
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState("");
  const [repo, setRepo] = useState("");
  const [agent, setAgent] = useState("omp");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [ghRepos, setGhRepos] = useState<string[]>([]);
  const [ghAuthed, setGhAuthed] = useState(false);
  const [maxMem, setMaxMem] = useState("");
  const [timeout, setTimeoutSec] = useState("");

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
      const limits = { timeoutSec: timeout ? Number(timeout) : undefined, maxMemoryMb: maxMem ? Number(maxMem) : undefined };
      const anyLimit = limits.timeoutSec || limits.maxMemoryMb;
      const w = await withToast("Creating workspace", async () =>
        isUrl
          ? api.clone({ url: repo.trim(), task: task.trim(), agent, limits: anyLimit ? limits : undefined })
          : api.create({ task: task.trim(), repo: repo.trim() || undefined, agent, limits: anyLimit ? limits : undefined }),
      );
      setTask("");
      setShowForm(false);
      await refresh();
      setView("workspaces");
      goWorkspace(w.id);
    } catch (err) {
      console.error(err);
    }
    setBusy(false);
  };

  const nav = [
    { key: "dashboard" as const, label: "Dashboard", icon: <SquaresFour className="size-5 shrink-0 text-[#a1a1aa] group-hover/side:text-[#e4e4e7]" /> },
    { key: "settings" as const, label: "Settings", icon: <GearSix className="size-5 shrink-0 text-[#a1a1aa] group-hover/side:text-[#e4e4e7]" /> },
  ];

  const label = (show: boolean, children: React.ReactNode) => (
    <span
      className={cn(
        "text-sm whitespace-nowrap overflow-hidden transition-[max-width,opacity,margin] duration-200 ease-out",
        show ? "opacity-100 max-w-[200px] ml-2" : "opacity-0 max-w-0 ml-0",
      )}
    >
      {children}
    </span>
  );

  // `open` is the hover state; `expanded` pins it open while the create form is
  // visible so a transient mouse-leave can't collapse the form mid-typing.
  const expanded = open || showForm;

  return (
    <aside
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => { if (!showForm) setOpen(false); }}
      className={cn(
        "h-full flex flex-col bg-[#111113] border-r border-[#27272a] shrink-0 overflow-hidden transition-[width] duration-150",
        expanded ? "w-[300px]" : "w-[60px]",
      )}
    >
      {/* logo */}
      <div className="px-3 h-12 flex items-center border-b border-[#27272a] overflow-hidden">
        <span className={cn("grid place-items-center rounded-md bg-emerald-400 text-[#06231a]", expanded ? "h-6 w-6" : "h-6 w-6 mx-auto")}>
          <TerminalWindow size={14} weight="bold" />
        </span>
        {label(expanded, <span className="font-bold tracking-tight whitespace-nowrap">kohlab</span>)}
      </div>

      {/* nav icons */}
      <div className="flex flex-col gap-1 p-2">
        {nav.map((n) => (
          <button
            key={n.key}
            onClick={() => setView(n.key)}
            title={n.label}
            className={cn(
              "group/side flex items-center h-9 px-2 rounded-lg hover:bg-[#151517] transition overflow-hidden justify-start",
              view === n.key && "bg-[#1c1c1f]",
            )}
          >
            {n.icon}
            {label(expanded, <span className={cn("whitespace-nowrap", view === n.key ? "text-[#e4e4e7]" : "text-[#a1a1aa]")}>{n.label}</span>)}
          </button>
        ))}
      </div>

      {/* new workspace */}
      <div className="px-2 pb-2">
        <button
          onClick={() => { setShowForm((v) => !v); setOpen(true); }}
          title="new workspace"
          className="w-full flex items-center justify-start h-9 px-2 rounded-lg bg-emerald-400 text-[#06231a] font-semibold hover:brightness-110 active:scale-[0.98] transition overflow-hidden"
        >
          <Plus className={cn("size-5 shrink-0", expanded ? "" : "mx-auto")} />
          {label(expanded, <span className="whitespace-nowrap text-sm">new workspace</span>)}
        </button>
      </div>

      {/* create form */}
      {showForm && expanded && (
        <form onSubmit={create} className="mx-2 mb-2 p-3 rounded-xl bg-[#151517] border border-[#27272a] flex flex-col gap-2">
          <input
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="task description"
            required
            className="bg-[#111113] border border-[#27272a] rounded-lg px-2.5 py-2 text-sm outline-none focus:border-emerald-400"
          />
          {ghAuthed && ghRepos.length > 0 && (
            <select
              defaultValue=""
              onChange={(e) => {
                const ownerRepo = e.target.value.split("\t")[0];
                if (ownerRepo) setRepo(`https://github.com/${ownerRepo}.git`);
              }}
              className="bg-[#111113] border border-[#27272a] rounded-lg px-2.5 py-2 text-sm outline-none focus:border-emerald-400"
            >
              <option value="">choose a GitHub repo</option>
              {ghRepos.map((entry) => {
                const [name, description] = entry.split("\t");
                return <option key={name} value={entry}>{name}{description ? ` - ${description}` : ""}</option>;
              })}
            </select>
          )}
          {!ghAuthed && (
            <div className="text-xs text-amber-400">GitHub not connected. Run `gh auth login` on the server.</div>
          )}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="repo path or GitHub URL"
                className="w-full bg-[#111113] border border-[#27272a] rounded-lg px-2.5 py-2 text-sm outline-none focus:border-emerald-400"
              />
              <GithubLogo size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400" />
            </div>
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              className="bg-[#111113] border border-[#27272a] rounded-lg px-2 py-2 text-sm outline-none focus:border-emerald-400"
            >
              {["omp", "claude", "codex", "opencode", "pi", "gemini", "sh"].map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <input value={maxMem} onChange={(e) => setMaxMem(e.target.value)} placeholder="max mem MB" inputMode="numeric" className="flex-1 bg-[#111113] border border-[#27272a] rounded-lg px-2.5 py-2 text-sm outline-none focus:border-emerald-400" />
            <input value={timeout} onChange={(e) => setTimeoutSec(e.target.value)} placeholder="timeout s" inputMode="numeric" className="flex-1 bg-[#111113] border border-[#27272a] rounded-lg px-2.5 py-2 text-sm outline-none focus:border-emerald-400" />
          </div>
          <button type="submit" disabled={busy || !task} className="py-1.5 rounded-lg bg-[#1c1c1f] border border-[#27272a] text-sm hover:border-emerald-400 disabled:opacity-40 transition">
            {busy ? "creating..." : "create"}
          </button>
        </form>
      )}

      {/* workspace list */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden p-2">
        {workspaces.length === 0 && (
          <div className={cn("text-zinc-400 text-xs text-center leading-5", expanded ? "px-2 mt-8" : "mt-4")}>
            {expanded ? (<>no workspaces yet<br />create one to launch your first agent</>) : <span className="text-zinc-400">—</span>}
          </div>
        )}
        {workspaces.map((w) => (
          <div
            key={w.id}
            onClick={() => goWorkspace(w.id)}
            title={w.id}
            className={cn(
              "group/side flex items-center h-9 rounded-lg cursor-pointer border border-transparent transition overflow-hidden",
              expanded ? "px-2 justify-start" : "px-2 justify-center",
              w.id === selectedId ? "bg-[#1c1c1f] border-[#333338]" : "hover:bg-[#151517]",
            )}
          >
            {statusDot(w)}
            {label(expanded, (
              <span className="text-[13px] truncate">
                <span className="font-medium">{w.id}</span>
                <span className="text-zinc-400"> · {w.agent}</span>
              </span>
            ))}
          </div>
        ))}
      </nav>

      {/* persist footer / avatar */}
      <div className={cn("border-t border-[#27272a] flex items-center overflow-hidden", expanded ? "px-3 h-11 justify-start gap-2" : "h-11 justify-center")}>
        <div className="size-6 shrink-0 rounded-full bg-[#1c1c1f] border border-[#333338] grid place-items-center">
          <FolderOpen size={12} className="text-[#a1a1aa]" />
        </div>
        {label(expanded, <span className="text-xs text-zinc-400 whitespace-nowrap">workspaces persist on this server</span>)}
      </div>
    </aside>
  );
}
