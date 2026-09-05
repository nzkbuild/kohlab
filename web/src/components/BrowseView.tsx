import { lazy, Suspense, useState } from "react";
import FileTree from "./FileTree";

const CodeView = lazy(() => import("./CodeView"));

/**
 * Files tab: file tree on the left, synced code viewer on the right.
 * Mirrors the 21st.dev Tree Code Viewer layout without adding Shiki —
 * Monaco (already lazy-loaded) does highlighting.
 */
export default function BrowseView({ workspaceId }: { workspaceId: string }) {
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [showTree, setShowTree] = useState(true);

  return (
    <div className="flex h-full min-h-0">
      {showTree && (
        <div className="w-64 min-w-64 border-r border-[#232d42]">
          <FileTree workspaceId={workspaceId} onOpenFile={setOpenFile} />
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[#232d42] text-xs">
          {!showTree && (
            <button
              onClick={() => setShowTree(true)}
              className="px-2 py-0.5 rounded border border-[#232d42] hover:border-emerald-400 transition"
            >
              show tree
            </button>
          )}
          {openFile && (
            <>
              <span className="font-mono text-zinc-300 flex-1 truncate">{openFile}</span>
              <button
                onClick={() => setShowTree((v) => !v)}
                className="px-2 py-0.5 rounded border border-[#232d42] hover:border-emerald-400 transition"
              >
                {showTree ? "hide tree" : "show tree"}
              </button>
            </>
          )}
        </div>
        <div className="flex-1 min-h-0">
          {openFile ? (
            <Suspense fallback={<div className="p-4 text-zinc-500 text-sm">loading editor...</div>}>
              <CodeView workspaceId={workspaceId} filePath={openFile} onBack={() => setOpenFile(null)} />
            </Suspense>
          ) : (
            <div className="h-full flex items-center justify-center text-zinc-600 text-sm">
              select a file
            </div>
          )}
        </div>
      </div>
    </div>
  );
}