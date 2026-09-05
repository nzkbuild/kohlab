import { useState } from "react";
import { api, setKey } from "../api";
import { useApp } from "../store";

export default function AuthGate() {
  const setAuthed = useApp((s) => s.setAuthed);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const ok = await api.testKey(value.trim());
    if (ok) {
      setKey(value.trim());
      setAuthed(true);
    } else {
      setError("wrong key - try again");
    }
    setBusy(false);
  };

  return (
    <div className="h-full flex items-center justify-center bg-[radial-gradient(1200px_600px_at_50%_20%,#101827_0%,#0a0a0a_60%)]">
      <div className="w-[340px] p-8 rounded-2xl bg-[#151517] border border-[#333338] shadow-2xl flex flex-col gap-2">
        <div className="flex items-center gap-2.5 text-xl font-bold">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-[0_0_12px_#34d399]" />
          kohlab
        </div>
        <div className="text-zinc-400 text-xs mb-3">agent workspaces</div>
        <form onSubmit={submit} className="flex flex-col gap-2.5">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="access key"
            autoFocus
            className="bg-[#111113] border border-[#27272a] rounded-lg px-3 py-2.5 text-sm outline-none focus:border-emerald-400"
          />
          {error && <div className="text-red-400 text-xs">{error}</div>}
          <button
            type="submit"
            disabled={busy || !value}
            className="bg-emerald-400 text-[#06231a] font-bold rounded-lg py-2.5 text-sm disabled:opacity-40 hover:brightness-110 active:scale-[0.98] transition"
          >
            {busy ? "checking..." : "enter"}
          </button>
        </form>
      </div>
    </div>
  );
}
