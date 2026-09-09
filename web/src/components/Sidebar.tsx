import { useEffect, useState } from "react";
import { Plus, FolderOpen, GithubLogo, SquaresFour, GearSix, TerminalWindow, SidebarSimple, CaretDoubleRight } from "@phosphor-icons/react";
import { api } from "../api";
import { useApp } from "../store";
import { withToast } from "../lib/actions";
import { cn } from "../lib/utils";
import { workspaceStatus, STATUS_DOT, STATUS_LABEL } from "../lib/status";

/**
 * Collapsible rail. ONE moving part: the aside width (60px ↔ 300px, 150ms).
 * Every icon/dot keeps a FIXED x-position in both states (constant px + gap,
 * no justify-center swap), so nothing slides horizontally on toggle. Labels
 * fade with opacity — delayed 75ms on expand so text appears as the rail
 * reveals it, never popping in mid-animation.
 */
export default function Sidebar() {
  const { workspaces, selectedId, view, select, setView, refresh } = useApp();
  const [open, setOpen] = useState(true);
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
    { key: "dashboard" as const, label: "Dashboard", icon: SquaresFour },
    { key: "settings" as const, label: "Settings", icon: GearSix },
  ];

  // `showForm` pins the rail open while the create form is visible.
  const expanded = open || showForm;

  // Label fade — the only inner animation. Icons never move.
  const label = (children: React.ReactNode) => (
    <span
      className={cn(
        "min-w-0 flex-1 truncate whitespace-nowrap transition-opacity duration-150",
        expanded ? "opacity-100 delay-75" : "pointer-events-none opacity-0",
      )}
    >
      {children}
    </span>
  );

  const row = "flex h-9 w-full items-center gap-2.5 px-2.5 rounded-lg";

  const inputCls = "w-full bg-[#111113] border border-[#27272a] rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-emerald-400";

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar transition-[width] duration-150 ease-out",
        expanded ? "w-[300px]" : "w-[60px]",
      )}
    >
      {/* header — brand fades, toggle pinned right at a fixed x */}
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-3">
        <span
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-md bg-emerald-400 text-[#06231a] transition-opacity duration-150",
            expanded ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <TerminalWindow size={14} weight="bold" />
        </span>
        {label(<span className="font-bold tracking-tight">kohlab</span>)}
        <button
          onClick={() => setOpen((v) => !v)}
          title={expanded ? "collapse sidebar" : "expand sidebar"}
          className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-[#a1a1aa] transition-colors hover:bg-sidebar-accent hover:text-[#e4e4e7]"
        >
          {expanded ? <SidebarSimple size={16} weight="bold" /> : <CaretDoubleRight size={16} weight="bold" />}
        </button>
      </header>

      {/* nav */}
      <nav className="flex flex-col gap-0.5 p-2">
        {nav.map((n) => {
          const active = view === n.key;
          return (
            <button
              key={n.key}
              onClick={() => setView(n.key)}
              title={n.label}
              className={cn(
                row,
                "transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-[#a1a1aa] hover:bg-sidebar-accent/60 hover:text-[#e4e4e7]",
              )}
            >
              <n.icon size={18} weight={active ? "fill" : "regular"} className="shrink-0" />
              {label(<span>{n.label}</span>)}
            </button>
          );
        })}
      </nav>

      {/* new workspace */}
      <div className="px-2 pb-2">
        <button
          onClick={() => {
            setOpen(true);
            setShowForm((v) => !v);
          }}
          title="new workspace"
          className={cn(
            "flex h-9 w-full items-center gap-2.5 rounded-lg bg-emerald-400 px-2.5 font-semibold text-[#06231a] transition hover:brightness-110 active:scale-[0.98]",
          )}
        >
          <Plus size={18} weight="bold" className="shrink-0" />
          {label(<span className="truncate">new workspace</span>)}
        </button>
      </div>

      {/* create form */}
      {showForm && expanded && (
        <form onSubmit={create} className="mx-2 mb-2 flex flex-col gap-2 rounded-xl border border-[#27272a] bg-[#151517] p-3">
          <input value={task} onChange={(e) => setTask(e.target.value)} placeholder="task description" required className={inputCls} />
          {ghAuthed && ghRepos.length > 0 && (
            <select
              defaultValue=""
              onChange={(e) => {
                const ownerRepo = e.target.value.split("\t")[0];
                if (ownerRepo) setRepo(`https://github.com/${ownerRepo}.git`);
              }}
              className={inputCls}
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
                className={cn(inputCls, "pr-8")}
              />
              <GithubLogo size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
            </div>
            <select value={agent} onChange={(e) => setAgent(e.target.value)} className={cn(inputCls, "w-24 shrink-0")}>
              {["omp", "claude", "codex", "opencode", "pi", "gemini", "sh"].map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <input value={maxMem} onChange={(e) => setMaxMem(e.target.value)} placeholder="max mem MB" inputMode="numeric" className={inputCls} />
            <input value={timeout} onChange={(e) => setTimeoutSec(e.target.value)} placeholder="timeout s" inputMode="numeric" className={inputCls} />
          </div>
          <button type="submit" disabled={busy || !task} className="rounded-lg border border-[#27272a] bg-[#1c1c1f] py-1.5 text-sm transition hover:border-emerald-400 disabled:opacity-40">
            {busy ? "creating..." : "create"}
          </button>
        </form>
      )}

      {/* workspace list */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden p-2">
        {expanded && workspaces.length > 0 && (
          <div className="px-2.5 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-[#a1a1aa]">workspaces</div>
        )}
        {workspaces.length === 0 && (
          <div className={cn("px-2.5 pt-4 text-xs leading-5 text-zinc-400", !expanded && "sr-only")}>
            no workspaces yet — create one to launch your first agent
          </div>
        )}
        {workspaces.map((w) => (
          <div
            key={w.id}
            onClick={() => goWorkspace(w.id)}
            title={`${w.id} — ${STATUS_LABEL[workspaceStatus(w)]}`}
            className={cn(
              row,
              "mb-0.5 cursor-pointer border border-transparent transition-colors",
              w.id === selectedId ? "border-sidebar-border bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
            )}
          >
            <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[workspaceStatus(w)])} />
            {label(
              <span className="text-[13px]">
                <span className="font-medium">{w.id}</span>
                <span className="text-[#a1a1aa]"> · {w.agent}</span>
              </span>,
            )}
          </div>
        ))}
      </nav>

      {/* footer */}
      <footer className="flex h-11 shrink-0 items-center gap-2.5 border-t border-sidebar-border px-3">
        <div className="grid size-6 shrink-0 place-items-center rounded-full border border-sidebar-border bg-sidebar-accent text-[#a1a1aa]">
          <FolderOpen size={12} />
        </div>
        {label(<span className="text-xs text-[#a1a1aa]">workspaces persist on this server</span>)}
      </footer>
    </aside>
  );
}