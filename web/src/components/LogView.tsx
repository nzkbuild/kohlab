import { useEffect, useState } from "react";
import { api } from "../api";

interface Props {
  workspaceId: string;
}

/** Live tail of the workspace's main-session PTY log buffer. */
export default function LogView({ workspaceId }: Props) {
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .log(workspaceId)
        .then((res) => {
          if (!cancelled) {
            setLog(res.log);
            setError(null);
          }
        })
        .catch((e) => !cancelled && setError((e as Error).message));
    void load();
    const t = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [workspaceId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-[#27272a] px-3 py-2 text-xs text-[#a1a1aa]">
        <span>session log</span>
      </div>
      <pre className="flex-1 min-h-0 overflow-auto p-3 font-mono text-xs leading-relaxed text-[#e4e4e7] whitespace-pre-wrap">
        {error && <span className="text-red-400">{error}</span>}
        {!error && !log && <span className="text-[#a1a1aa]">no output yet — start the workspace</span>}
        {log}
      </pre>
    </div>
  );
}