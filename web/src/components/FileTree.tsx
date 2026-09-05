import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import type { TreeNode } from "../types";

interface Props {
  workspaceId: string;
  onOpenFile: (path: string) => void;
}

function TreeRow({ node, depth, path, workspaceId, onOpenFile }: {
  node: TreeNode;
  depth: number;
  path: string;
  workspaceId: string;
  onOpenFile: (p: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const full = path ? `${path}/${node.name}` : node.name;

  if (node.type === "dir") {
    return (
      <>
        <div
          className="flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer hover:bg-[#151517] text-[13px] whitespace-nowrap"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="text-zinc-400 w-3 text-xs">{open ? "-" : "+"}</span>
          <span className="text-zinc-400">{node.name}/</span>
        </div>
        {open && node.children?.map((c) => (
          <TreeRow key={c.name} node={c} depth={depth + 1} path={full} workspaceId={workspaceId} onOpenFile={onOpenFile} />
        ))}
      </>
    );
  }
  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer hover:bg-[#151517] text-[13px] whitespace-nowrap text-zinc-300"
      style={{ paddingLeft: `${depth * 14 + 8}px` }}
      onClick={() => onOpenFile(full)}
    >
      <span className="w-3" />
      <span>{node.name}</span>
    </div>
  );
}

export default function FileTree({ workspaceId, onOpenFile }: Props) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTree(await api.files(workspaceId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#27272a] text-xs text-zinc-400">
        <span>files</span>
        <button onClick={() => void load()} className="px-2 py-0.5 rounded border border-[#27272a] hover:border-emerald-400 transition text-xs">
          refresh
        </button>
      </div>
      <div className="flex-1 overflow-auto p-1.5">
        {error && <div className="text-red-400 text-xs p-2">{error}</div>}
        {tree.map((n) => (
          <TreeRow key={n.name} node={n} depth={0} path="" workspaceId={workspaceId} onOpenFile={onOpenFile} />
        ))}
      </div>
    </div>
  );
}
