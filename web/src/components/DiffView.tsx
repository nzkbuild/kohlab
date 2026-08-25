import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { api } from "../api";

interface Props {
  workspaceId: string;
}

export default function DiffView({ workspaceId }: Props) {
  const [diff, setDiff] = useState("");
  const [stat, setStat] = useState("(clean)");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const load = () => {
    api.diff(workspaceId)
      .then((files) => {
        if (!files.length) {
          setStat("(clean)");
          setDiff("");
        } else {
          setStat(files[0].name.split("\n")[0]);
          setDiff(files[0].diff);
        }
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  };

  useEffect(load, [workspaceId]);

  const commit = async () => {
    try {
      await api.commit(workspaceId, msg);
      setMsg("");
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-3 py-2 border-b border-[#232d42] text-xs">
        <span className="text-zinc-400 flex-1 truncate">{stat}</span>
        <button onClick={load} className="px-2 py-0.5 rounded border border-[#232d42] hover:border-emerald-400 transition">refresh</button>
      </div>
      {error && <div className="px-3 py-2 text-red-400 text-xs">{error}</div>}
      <div className="flex-1 min-h-0">
        <DiffEditor
          height="100%"
          language="plaintext"
          original=""
          modified={diff}
          theme="vs-dark"
          options={{ readOnly: true, minimap: { enabled: false } }}
        />
      </div>
      <div className="flex gap-2 items-center px-3 py-2 border-t border-[#232d42]">
        <input
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          placeholder="commit message (defaults to task)"
          className="flex-1 bg-[#0f141d] border border-[#232d42] rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-emerald-400"
        />
        <button onClick={() => void commit()} className="px-3 py-1.5 rounded-lg bg-emerald-400 text-[#04120b] font-semibold text-xs hover:brightness-110 transition">
          commit
        </button>
      </div>
    </div>
  );
}
