import { useEffect, useState } from "react";
import { CheckCircle, CircleNotch, DownloadSimple } from "@phosphor-icons/react";
import { api } from "../api";
import { AGENT_CATALOG } from "../types";
import type { AgentInfo } from "../types";

interface Props {
  compact?: boolean;
}

export default function AgentInstaller({ compact }: Props) {
  const [agents, setAgents] = useState<AgentInfo[]>(AGENT_CATALOG.map((a) => ({ ...a, installed: false })));
  const [running, setRunning] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);

  const load = async () => {
    try {
      const st = await api.agentsStatus();
      setAgents(AGENT_CATALOG.map((a) => ({ ...a, installed: !!st[a.name] })));
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const install = async (a: AgentInfo) => {
    if (!a.installCmd) return;
    setRunning(a.name);
    setLog(null);
    try {
      const res = await api.installAgent(a.name, a.installCmd);
      setLog(`installed ${a.name}${res.output ? `\n${res.output.slice(0, 300)}` : ""}`);
      await load();
    } catch (e) {
      setLog(`install failed: ${(e as Error).message}`);
    }
    setRunning(null);
  };

  const installed = agents.filter((a) => a.installed);
  const missing = agents.filter((a) => !a.installed);

  return (
    <div className={compact ? "text-left" : "p-6"}>
      {!compact && <h3 className="text-lg font-semibold mb-3">Agents</h3>}
      {installed.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {installed.map((a) => (
            <span key={a.name} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-400/10 border border-emerald-400/30 text-emerald-400 text-xs">
              <CheckCircle size={13} weight="fill" /> {a.name}
            </span>
          ))}
        </div>
      )}
      {missing.map((a) => (
        <div key={a.name} className="flex items-center gap-3 p-3 rounded-xl bg-[#131926] border border-[#232d42] mb-2">
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm">{a.name}</div>
            <div className="text-[11px] text-zinc-500 truncate">{a.setupHint}</div>
            <code className="block mt-1 text-[10px] text-zinc-600 truncate">{a.installCmd}</code>
          </div>
          <button
            onClick={() => void install(a)}
            disabled={running === a.name}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-400 text-[#04120b] text-xs font-semibold disabled:opacity-50 hover:brightness-110 transition"
          >
            {running === a.name ? <CircleNotch size={13} className="animate-spin" /> : <DownloadSimple size={13} />}
            install
          </button>
        </div>
      ))}
      {missing.length === 0 && <div className="text-xs text-zinc-500">all agents installed</div>}
      {log && <pre className="mt-2 p-2 bg-[#0a0e14] rounded-lg text-[10px] text-emerald-400 whitespace-pre-wrap">{log}</pre>}
    </div>
  );
}
