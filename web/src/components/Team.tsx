import { useEffect, useState } from "react";
import { Users, UserPlus, Trash } from "@phosphor-icons/react";
import { api } from "../api";
import type { TeamUser, AuditEvent } from "../api";

const ACTION_DOT: Record<string, string> = {
  start: "bg-emerald-400",
  stop: "bg-zinc-600",
  delete: "bg-zinc-600",
  commit: "bg-emerald-300/70",
  create: "bg-emerald-300/70",
  clone: "bg-emerald-300/70",
  share: "bg-emerald-300/70",
  "agent.install": "bg-amber-400",
  "user.add": "bg-emerald-300/70",
  "user.remove": "bg-zinc-600",
};

/** Team management: member list + audit for everyone; add/revoke only for owners. */
export default function Team() {
  const [users, setUsers] = useState<TeamUser[] | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("member");
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [u, a] = await Promise.all([
      api.users().catch(() => null),
      api.audit().catch(() => null),
    ]);
    // /api/users is owner-only: members and viewers get null and the
    // management controls stay hidden; the audit tail is owner+member.
    if (u) { setUsers(u.users); setCanManage(true); }
    if (a) setAudit(a.events);
  };

  useEffect(() => { void load(); }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id.trim() || !name.trim()) return;
    setBusy(true);
    try {
      const res = await api.addUser({ id: id.trim(), name: name.trim(), role });
      setFreshKey(res.key);
      setId(""); setName("");
      void load();
    } catch (err) {
      console.error(err);
    }
    setBusy(false);
  };

  const remove = async (uid: string) => {
    await api.removeUser(uid).catch(console.error);
    void load();
  };

  if (users === null && audit.length === 0) return null; // viewer/anonymous — no team surface

  return (
    <section className="mt-4 rounded-xl border border-[#27272a] bg-[#111113]">
      <div className="flex items-center gap-2 border-b border-[#27272a] px-4 py-2.5 text-xs text-[#a1a1aa]">
        <Users size={14} /> Team
      </div>

      <div className="p-4">
        {/* user list + add/revoke are owner-only */}
        {canManage && users!.length === 0 && (
          <div className="text-sm text-[#a1a1aa] mb-3">no teammates yet — add one to share this server.</div>
        )}
        {canManage && users!.map((u) => (
          <div key={u.id} className="flex items-center gap-3 py-2 border-b border-[#151517] last:border-0">
            <span className="font-mono text-sm">{u.id}</span>
            <span className="text-xs text-[#a1a1aa]">{u.name}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded-full border ${u.role === "owner" ? "text-purple-400 border-purple-400/40" : u.role === "member" ? "text-emerald-400 border-emerald-400/40" : "text-zinc-400 border-zinc-700"}`}>
              {u.role}
            </span>
            <div className="flex-1" />
            <button onClick={() => void remove(u.id)} className="text-zinc-400 hover:text-red-400 transition" title="revoke">
              <Trash size={13} />
            </button>
          </div>
        ))}
        {canManage && (
          <form onSubmit={add} className="flex gap-2 mt-3">
            <input value={id} onChange={(e) => setId(e.target.value)} placeholder="username" className="flex-1 bg-[#111113] border border-[#27272a] rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-emerald-400" />
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="display name" className="flex-1 bg-[#111113] border border-[#27272a] rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-emerald-400" />
            <select value={role} onChange={(e) => setRole(e.target.value)} className="bg-[#111113] border border-[#27272a] rounded-lg px-2 py-1.5 text-sm outline-none">
              <option value="owner">owner</option>
              <option value="member">member</option>
              <option value="viewer">viewer</option>
            </select>
            <button type="submit" disabled={busy || !id || !name} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-400 text-[#06231a] text-xs font-semibold disabled:opacity-40 hover:brightness-110 transition">
              <UserPlus size={13} /> add
            </button>
          </form>
        )}
        {canManage && freshKey && (
          <div className="mt-3 p-2 rounded-lg bg-amber-400/10 border border-amber-400/30 text-amber-300 text-xs">
            <div>key for {id || "user"} (shown once — copy it now):</div>
            <code className="block mt-1 font-mono break-all">{freshKey}</code>
          </div>
        )}

        {/* audit tail */}
        <div className="mt-4 border-t border-[#151517] pt-3">
          <div className="text-xs text-[#a1a1aa] mb-2">recent activity</div>
          {audit.length === 0 && <div className="text-sm text-[#a1a1aa]">no events yet</div>}
          {audit.slice(0, 12).map((e, i) => (
            <div key={i} className="flex items-center gap-2 py-1 text-xs font-mono">
              <span className={`size-1.5 shrink-0 rounded-full ${ACTION_DOT[e.action] ?? "bg-zinc-600"}`} />
              <span className="text-zinc-400">{new Date(e.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <span className="text-zinc-400">{e.user}</span>
              <span className="text-emerald-400">{e.action}</span>
              <span className="text-zinc-400 truncate">{e.id ?? ""}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
