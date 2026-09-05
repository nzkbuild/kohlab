import { Server } from "lucide-react";
import AgentInstaller from "./AgentInstaller";
import Team from "./Team";

/** Settings: agent management + server info. */
export default function Settings() {
  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <div className="border-b border-[#27272a] px-5 py-3 flex items-center gap-2">
        <Server className="size-4 text-[#a1a1aa]" />
        <h1 className="text-lg font-semibold">Settings</h1>
      </div>
      <div className="p-5 max-w-2xl">
        <section className="rounded-xl border border-[#27272a] bg-[#111113]">
          <div className="border-b border-[#27272a] px-4 py-2.5 text-xs text-[#a1a1aa]">Agents</div>
          <div className="p-2">
            <AgentInstaller />
          </div>
        </section>

        <section className="mt-4 rounded-xl border border-[#27272a] bg-[#111113]">
          <div className="border-b border-[#27272a] px-4 py-2.5 text-xs text-[#a1a1aa]">Server</div>
          <dl className="divide-y divide-[#151517] text-sm">
            <div className="flex items-center justify-between px-4 py-2.5">
              <dt className="text-[#a1a1aa]">Address</dt>
              <dd className="font-mono text-xs">{location.host}</dd>
            </div>
            <div className="flex items-center justify-between px-4 py-2.5">
              <dt className="text-[#a1a1aa]">Workspaces persist on this server</dt>
              <dd className="text-xs text-emerald-400">yes</dd>
            </div>
          </dl>
        </section>

        <Team />
      </div>
    </div>
  );
}