import { useEffect, useState } from "react";
import { Pulse, CheckCircle, PlayCircle, Cpu, FolderOpen, ArrowRight } from "@phosphor-icons/react";
import { useApp } from "@/store";
import { api } from "../api";
import { workspaceStatus, STATUS_DOT, ACTIVITY_DOT } from "../lib/status";
import type { AgentStatus } from "../types";
import type { ActivityKind } from "../lib/status";

/** Command-center dashboard: KPIs, review queue, activity timeline, agents. */
export default function Dashboard() {
  const { workspaces, select } = useApp();
  const [agents, setAgents] = useState<AgentStatus | null>(null);

  useEffect(() => {
    void api.agentsStatus().then(setAgents).catch(() => {});
  }, []);

  const review = workspaces.filter((w) => workspaceStatus(w) === "needs-review");
  const running = workspaces.filter((w) => workspaceStatus(w) === "running");
  const agentNames = Object.keys(agents ?? {});

  // activity feed derived from workspace timestamps — newest first
  const activity = workspaces
    .flatMap((w) => {
      const out: { id: string; message: string; time: number; kind: ActivityKind }[] = [];
      out.push({ id: `${w.id}-c`, message: `Created workspace for "${w.task}"`, time: w.created, kind: "created" });
      if (w.started) out.push({ id: `${w.id}-s`, message: `Started ${w.id}`, time: w.started, kind: "start" });
      if (workspaceStatus(w) === "needs-review" && w.stopped) {
        out.push({ id: `${w.id}-r`, message: `${w.id} finished — needs review`, time: w.stopped, kind: "review" });
      } else if (w.stopped) {
        out.push({ id: `${w.id}-x`, message: `Finished ${w.id}`, time: w.stopped, kind: "stop" });
      }
      if (w.lastCommitAt) out.push({ id: `${w.id}-m`, message: `Committed ${w.id}`, time: w.lastCommitAt, kind: "commit" });
      return out;
    })
    .sort((a, b) => b.time - a.time)
    .slice(0, 12);

  const fmtTime = (t: number) =>
    new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

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
        {card("Running", running.length, <PlayCircle size={16} />, "bg-emerald-400/10 text-emerald-400")}
        {card("Needs review", review.length, <CheckCircle size={16} />, "bg-amber-400/10 text-amber-400")}
        {card("Workspaces", workspaces.length, <FolderOpen size={16} />, "bg-[#1c1c1f] text-[#a1a1aa]")}
        {card("Agents installed", agentNames.length, <Cpu size={16} />, "bg-emerald-400/10 text-emerald-300")}
      </div>

      {review.length > 0 && (
        <section className="mb-5 rounded-xl border border-amber-400/40 bg-[#111113]">
          <div className="flex items-center gap-2 border-b border-[#27272a] px-4 py-2.5 text-xs text-amber-400">
            <Pulse size={14} /> Review queue
          </div>
          <div className="p-2">
            {review.map((w) => (
              <div key={w.id} className="flex items-center gap-3 rounded-lg px-3 py-2 transition hover:bg-[#151517]">
                <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT["needs-review"]}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-[#e4e4e7]">{w.id}</div>
                  <div className="truncate text-xs text-[#a1a1aa]">{w.task}</div>
                </div>
                <span className="text-xs text-[#a1a1aa]">{w.agent}</span>
                <button
                  onClick={() => select(w.id)}
                  className="flex items-center gap-1 rounded-lg border border-amber-400/40 px-2.5 py-1 text-xs text-amber-400 transition hover:bg-amber-400/10"
                >
                  review <ArrowRight size={11} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid lg:grid-cols-2 gap-5">
        {/* Active workspaces */}
        <section className="rounded-xl border border-[#27272a] bg-[#111113]">
          <div className="flex items-center gap-2 border-b border-[#27272a] px-4 py-2.5 text-xs text-[#a1a1aa]">
            <Pulse size={14} /> Workspaces
          </div>
          <div className="p-2">
            {workspaces.length === 0 && <div className="p-4 text-sm text-[#a1a1aa]">no workspaces yet — create one to launch an agent</div>}
            {workspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => select(w.id)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-[#151517] transition"
              >
                <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[workspaceStatus(w)]}`} />
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
            <CheckCircle size={14} /> Recent activity
          </div>
          <div className="divide-y divide-[#151517]">
            {activity.length === 0 && <div className="p-4 text-sm text-[#a1a1aa]">nothing yet</div>}
            {activity.map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className={`size-1.5 shrink-0 rounded-full ${ACTIVITY_DOT[a.kind]}`} />
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
          <Cpu size={14} /> Agents on this server
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