import { useEffect, useState } from "react";
import { Terminal, GithubLogo, Rocket } from "@phosphor-icons/react";
import { api } from "../api";
import { useApp } from "../store";
import { withToast } from "../lib/actions";
import AgentInstaller from "./AgentInstaller";

/** First-run guided flow: install an agent → create a workspace → launch. */
export default function Onboarding() {
  const { refresh, select, setView } = useApp();
  const [installed, setInstalled] = useState<string[]>([]);
  const [task, setTask] = useState("");
  const [repo, setRepo] = useState("");
  const [agent, setAgent] = useState("omp");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [share, setShare] = useState<string | null>(null);

  useEffect(() => {
    void api.agentsStatus().then((st) => setInstalled(Object.keys(st).filter((k) => st[k])));
  }, []);

  const hasAgent = installed.length > 0;

  const create = async () => {
    if (!task.trim()) return;
    setBusy(true);
    try {
      const isUrl = /^https?:\/\//.test(repo.trim());
      const w = await withToast("Creating workspace", async () =>
        isUrl
          ? api.clone({ url: repo.trim(), task: task.trim(), agent })
          : api.create({ task: task.trim(), repo: repo.trim() || undefined, agent }),
      );
      await refresh();
      setView("workspaces");
      select(w.id);
      setCreated(w.id);
    } catch (e) {
      console.error(e);
    }
    setBusy(false);
  };

  const makeShare = async (id: string) => {
    try {
      const s = await api.share(id);
      const url = `${location.origin}/?share=${s.share}`;
      setShare(url);
      navigator.clipboard.writeText(url).catch(() => {});
    } catch (e) {
      console.error(e);
    }
  };

  const Step = ({ n, title, active, done, children }: { n: number; title: string; active: boolean; done: boolean; children: React.ReactNode }) => (
    <section className={`rounded-xl border p-4 transition ${active ? "border-emerald-400/50 bg-[#111113]" : "border-[#27272a] bg-[#0d0d0f]"}`}>
      <div className="flex items-center gap-2.5 mb-3">
        <span className={`flex size-5 items-center justify-center rounded-full text-xs font-bold ${done ? "bg-emerald-400 text-[#06231a]" : active ? "bg-emerald-400/20 text-emerald-400" : "bg-[#1c1c1f] text-[#a1a1aa]"}`}>
          {done ? "✓" : n}
        </span>
        <span className="text-sm font-semibold text-[#e4e4e7]">{title}</span>
      </div>
      <div className={active || done ? "" : "opacity-50 pointer-events-none"}>{children}</div>
    </section>
  );

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="w-full max-w-xl flex flex-col gap-3">
        <div className="mb-2">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Terminal size={20} className="text-emerald-400" /> get your first agent running
          </h1>
          <p className="text-[#a1a1aa] text-sm mt-1">three steps — install an agent, point at a repo, launch.</p>
        </div>

        <Step n={1} title="Install an agent" active={!hasAgent} done={hasAgent}>
          {hasAgent ? (
            <div className="text-sm text-emerald-400">✓ {installed.join(", ")} installed</div>
          ) : (
            <div className="text-sm text-[#a1a1aa] mb-3">pick one to install, or skip if you already run one.</div>
          )}
          <AgentInstaller compact />
        </Step>

        <Step n={2} title="Create a workspace" active={hasAgent} done={false}>
          <div className="flex flex-col gap-2">
            <input
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="what should the agent do? e.g. fix the billing bug"
              className="bg-[#111113] border border-[#27272a] rounded-lg px-3 py-2 text-sm outline-none focus:border-emerald-400"
            />
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="repo path or GitHub URL"
                  className="w-full bg-[#111113] border border-[#27272a] rounded-lg px-3 py-2 text-sm outline-none focus:border-emerald-400"
                />
                <GithubLogo size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400" />
              </div>
              <select
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                className="bg-[#111113] border border-[#27272a] rounded-lg px-2 py-2 text-sm outline-none focus:border-emerald-400"
              >
                {installed.length ? [...installed, "sh"].map((a) => <option key={a} value={a}>{a}</option>) : <option value="sh">sh</option>}
              </select>
            </div>
            <button
              onClick={() => void create()}
              disabled={busy || !task.trim() || !hasAgent}
              className="flex items-center justify-center gap-2 py-2 rounded-lg bg-emerald-400 text-[#06231a] font-semibold text-sm disabled:opacity-40 hover:brightness-110 active:scale-[0.98] transition"
            >
              <Rocket size={15} weight="fill" />
              {busy ? "creating..." : "create & launch"}
            </button>
            {created && (
              <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/5 p-3 text-xs flex flex-col gap-1.5">
                <div className="text-[#a1a1aa]">workspace <span className="font-mono text-[#e4e4e7]">{created}</span> is open in the terminal tab. Next:</div>
                <button onClick={() => void makeShare(created)} className="text-left text-emerald-400 hover:brightness-110 transition">
                  {share ? "share link ready — click to copy" : "get a share link"}
                </button>
              </div>
            )}
          </div>
        </Step>

        <Step n={3} title="Monitor & merge" active={false} done={false}>
          <div className="text-sm text-[#a1a1aa]">after it starts, watch the terminal live and review the diff before committing.</div>
        </Step>

        <button onClick={() => setView("dashboard")} className="text-center text-xs text-[#a1a1aa] hover:text-emerald-400 transition">
          skip — just show the dashboard
        </button>
      </div>
    </div>
  );
}
