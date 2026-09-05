import { useEffect, useState } from "react";
import { Activity, CheckCircle2, Circle, PlayCircle, Cpu, FolderOpen } from "lucide-react";
import { useApp } from "@/store";
import { api } from "../api";
import type { AgentStatus } from "../types";

/** Command-center dashboard: KPIs, agent availability, recent workspace activity. */
export default function Dashboard() {
  const { workspaces, select } = useApp();
  const [agents, setAgents] = useState<AgentStatus | null>(null);

  useEffect(() => {
    void api.agentsStatus().then(setAgents).catch(() => {});
  }, []);

  const running = workspaces.filter((w) => w.running);
  const done = workspaces.filter((w) => !w.running && w.stopped);

  // activity feed derived from workspace timestamps — newest first
  const activity = workspaces
    .flatMap((w) => {
      const out: { id: string; message: string; time: number; kind: "start" | "stop" | "created" }[] = [];
      out.push({ id: `${w.id}-c`, message: `Created workspace for "${w.task}"`, time: w.created, kind: "created" });
      if (w.started) out.push({ id: `${w.id}-s`, message: `Started ${w.id}`, time: w.started, kind: "start" });
      if (w.stopped) out.push({ id: `${w.id}-x`, message: `Finished ${w.id}`, time: w.stopped, kind: "stop" });
      return out;
    })
    .sort((a, b) => b.time - a.time)
    .slice(0, 12);

  const fmtTime = (t: number) =>
    new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const agentNames = Object.keys(agents ?? {});

  const card = (label: string, value: number | string, icon: React.ReactNode, accent: string) => (
    <div className="rounded-xl border border-[#27272a] bg-[#111113] p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-[#a1a1aa]">{label}</span>
        <span className={`rounded-md p-1.5 ${accent}`}>{icon}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );

  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-5">
      <h1 className="text-lg font-semibold mb-4">Command center</h1>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {card("Running", running.length, <PlayCircle className="size-4" />, "bg-emerald-400/10 text-emerald-400")}
        {card("Done today", done.length, <CheckCircle2 className="size-4" />, "bg-amber-400/10 text-amber-400")}
        {card("Workspaces", workspaces.length, <FolderOpen className="size-4" />, "bg-blue-400/10 text-blue-400")}
        {card("Agents installed", agentNames.length, <Cpu className="size-4" />, "bg-purple-400/10 text-purple-400")}
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        {/* Active workspaces */}
        <section className="rounded-xl border border-[#27272a] bg-[#111113]">
          <div className="flex items-center gap-2 border-b border-[#27272a] px-4 py-2.5 text-xs text-[#a1a1aa]">
            <Activity className="size-3.5" /> Workspaces
          </div>
          <div className="p-2">
            {workspaces.length === 0 && <div className="p-4 text-sm text-[#a1a1aa]">no workspaces yet — create one to launch an agent</div>}
            {workspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => select(w.id)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-[#151517] transition"
              >
                {w.running ? <PlayCircle className="size-4 shrink-0 text-emerald-400" /> : w.stopped ? <CheckCircle2 className="size-4 shrink-0 text-amber-400" /> : <Circle className="size-4 shrink-0 text-zinc-400" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[#e4e4e7]">{w.id}</span>
                  <span className="block truncate text-xs text-[#a1a1aa]">{w.task}</span>
                </span>
                <span className="text-xs text-[#a1a1aa]">{w.agent}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Activity feed */}
        <section className="rounded-xl border border-[#27272a] bg-[#111113]">
          <div className="flex items-center gap-2 border-b border-[#27272a] px-4 py-2.5 text-xs text-[#a1a1aa]">
            <CheckCircle2 className="size-3.5" /> Recent activity
          </div>
          <div className="divide-y divide-[#151517]">
            {activity.length === 0 && <div className="p-4 text-sm text-[#a1a1aa]">nothing yet</div>}
            {activity.map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className={`size-1.5 shrink-0 rounded-full ${a.kind === "start" ? "bg-emerald-400" : a.kind === "stop" ? "bg-amber-400" : "bg-blue-400"}`} />
                <span className="flex-1 truncate text-[#e4e4e7]">{a.message}</span>
                <span className="shrink-0 text-xs text-[#a1a1aa]">{fmtTime(a.time)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Agent availability */}
      <section className="mt-5 rounded-xl border border-[#27272a] bg-[#111113]">
        <div className="flex items-center gap-2 border-b border-[#27272a] px-4 py-2.5 text-xs text-[#a1a1aa]">
          <Cpu className="size-3.5" /> Agents on this server
        </div>
        <div className="flex flex-wrap gap-2 p-4">
          {!agents && <span className="text-sm text-[#a1a1aa]">checking…</span>}
          {agentNames.map((name) => (
            <span
              key={name}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                agents?.[name]
                  ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-400"
                  : "border-[#27272a] bg-[#151517] text-[#a1a1aa]"
              }`}
            >
              <span className={`size-1.5 rounded-full ${agents?.[name] ? "bg-emerald-400" : "bg-zinc-600"}`} />
              {name}
              {agents?.[name] ? " installed" : " missing"}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}