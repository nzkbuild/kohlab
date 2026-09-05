import { Server } from "lucide-react";
import AgentInstaller from "./AgentInstaller";

/** Settings: agent management + server info. */
export default function Settings() {
  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <div className="border-b border-[#232d42] px-5 py-3 flex items-center gap-2">
        <Server className="size-4 text-[#7a869c]" />
        <h1 className="text-lg font-semibold">Settings</h1>
      </div>
      <div className="p-5 max-w-2xl">
        <section className="rounded-xl border border-[#232d42] bg-[#0f141d]">
          <div className="border-b border-[#232d42] px-4 py-2.5 text-xs text-[#7a869c]">Agents</div>
          <div className="p-2">
            <AgentInstaller />
          </div>
        </section>

        <section className="mt-4 rounded-xl border border-[#232d42] bg-[#0f141d]">
          <div className="border-b border-[#232d42] px-4 py-2.5 text-xs text-[#7a869c]">Server</div>
          <dl className="divide-y divide-[#131926] text-sm">
            <div className="flex items-center justify-between px-4 py-2.5">
              <dt className="text-[#7a869c]">Address</dt>
              <dd className="font-mono text-xs">{location.host}</dd>
            </div>
            <div className="flex items-center justify-between px-4 py-2.5">
              <dt className="text-[#7a869c]">Workspaces persist on this server</dt>
              <dd className="text-xs text-emerald-400">yes</dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}