import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { Files, ArrowsClockwise } from "@phosphor-icons/react";
import { api } from "../api";
import { withToast } from "../lib/actions";
import type { DiffFile } from "../types";

interface Props {
  workspaceId: string;
}

/** Diff review: changed-file list → per-file Monaco diff → one-click commit. */
export default function DiffView({ workspaceId }: Props) {
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [sel, setSel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const load = () => {
    api.diff(workspaceId)
      .then((f) => {
        setFiles(f);
        setSel((s) => Math.min(s, Math.max(f.length - 1, 0)));
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  };

  useEffect(load, [workspaceId]);

  const commit = async () => {
    try {
      await withToast("Committing", () => api.commit(workspaceId, msg));
      setMsg("");
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const clean = files.length === 0;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-3 py-2 border-b border-[#27272a] text-xs">
        <Files size={13} className="text-[#a1a1aa]" />
        <span className="text-zinc-400 flex-1 truncate">
          {clean ? "(clean — nothing to review)" : `${files.length} file${files.length === 1 ? "" : "s"} changed`}
        </span>
        <button onClick={load} className="flex items-center gap-1 px-2 py-0.5 rounded border border-[#27272a] hover:border-emerald-400 transition">
          <ArrowsClockwise size={11} /> refresh
        </button>
      </div>

      {error && <div className="px-3 py-2 text-red-400 text-xs">{error}</div>}

      {!clean && (
        <div className="flex min-h-0 flex-1">
          {/* changed-file list */}
          <div className="w-56 min-w-56 border-r border-[#27272a] overflow-y-auto p-1.5 flex flex-col gap-0.5">
            {files.map((f, i) => (
              <button
                key={f.name}
                onClick={() => setSel(i)}
                className={`text-left px-2 py-1.5 rounded-md text-xs truncate transition ${
                  i === sel ? "bg-[#1c1c1f] border border-[#333338] text-[#e4e4e7]" : "text-[#a1a1aa] hover:bg-[#151517] border border-transparent"
                }`}
              >
                <span className="font-mono truncate block">{f.name}</span>
              </button>
            ))}
          </div>
          <div className="flex-1 min-w-0">
            <DiffEditor
              height="100%"
              language="plaintext"
              original=""
              modified={files[sel]?.diff ?? ""}
              theme="vs-dark"
              options={{ readOnly: true, minimap: { enabled: false } }}
            />
          </div>
        </div>
      )}

      {clean && (
        <div className="flex-1 min-h-0 grid place-items-center text-sm text-[#a1a1aa]">
          no changes to review
        </div>
      )}

      <div className="flex gap-2 items-center px-3 py-2 border-t border-[#27272a]">
        <input
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          placeholder="commit message (defaults to task)"
          className="flex-1 bg-[#111113] border border-[#27272a] rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-emerald-400"
        />
        <button
          onClick={() => void commit()}
          disabled={clean}
          className="px-3 py-1.5 rounded-lg bg-emerald-400 text-[#06231a] font-semibold text-xs hover:brightness-110 transition disabled:opacity-35"
        >
          commit
        </button>
      </div>
    </div>
  );
}