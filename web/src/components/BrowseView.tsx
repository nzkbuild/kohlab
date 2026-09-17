import { lazy, Suspense, useState } from "react";
import { CaretRight, FileCode, TreeStructure } from "@phosphor-icons/react";
import { cn } from "../lib/utils";
import FileTree from "./FileTree";
import { Button, EmptyState, SkeletonRows } from "./ui";

// Monaco is ~600 KB; it loads when a file is actually opened, never with the tab.
const CodeView = lazy(() => import("./CodeView"));

/**
 * Files tab: tree on the left, read-only viewer on the right, with the open
 * file's path as a breadcrumb across the top.
 */
export default function BrowseView({ workspaceId }: { workspaceId: string }) {
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [showTree, setShowTree] = useState(true);

  const segments = openFile ? openFile.split("/") : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-10 items-center gap-2 border-b border-line-subtle px-3">
        {openFile ? (
          <nav aria-label="Breadcrumb" className="min-w-0 flex-1 overflow-hidden">
            <ol className="flex min-w-0 items-center gap-1">
              {segments.map((segment, index) => {
                const last = index === segments.length - 1;
                return (
                  <li key={`${index}:${segment}`} className="flex min-w-0 items-center gap-1">
                    {index > 0 ? <CaretRight size={9} className="shrink-0 text-text-faint" aria-hidden="true" /> : null}
                    <span
                      className={cn("mono truncate text-2xs", last ? "text-text-secondary" : "text-text-faint")}
                      title={last ? (openFile ?? undefined) : undefined}
                    >
                      {segment}
                    </span>
                  </li>
                );
              })}
            </ol>
          </nav>
        ) : (
          <span className="eyebrow flex-1">Files</span>
        )}
        <Button
          variant="quiet"
          size="sm"
          iconOnly
          aria-pressed={showTree}
          aria-label={showTree ? "Hide file tree" : "Show file tree"}
          onClick={() => setShowTree((v) => !v)}
        >
          <TreeStructure size={14} />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {showTree ? (
          <div className="w-64 min-w-64 border-r border-line-subtle">
            <FileTree workspaceId={workspaceId} onOpenFile={setOpenFile} />
          </div>
        ) : null}

        <div className="min-w-0 flex-1">
          {openFile ? (
            <Suspense fallback={<SkeletonRows rows={12} className="p-4" />}>
              <CodeView key={openFile} workspaceId={workspaceId} filePath={openFile} onBack={() => setOpenFile(null)} />
            </Suspense>
          ) : (
            <EmptyState
              icon={<FileCode size={18} />}
              title="No file open"
              description="Pick a file from the tree to read it here. Nothing is editable — this view is for reading the agent's changes."
            />
          )}
        </div>
      </div>
    </div>
  );
}
