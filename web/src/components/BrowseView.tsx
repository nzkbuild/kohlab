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
      {/* One pane-header treatment: .cockpit-head and the same h2 title used by
          every other pane, rather than a hand-rolled row with an section-label. The
          breadcrumb is a path display, not a second title style. */}
      <header className="cockpit-head">
        <h2 className="shrink-0 text-sm font-semibold text-text-primary">Files</h2>
        {openFile ? (
          <nav aria-label="breadcrumb" className="min-w-0 flex-1 overflow-hidden">
            <ol className="flex min-w-0 items-center gap-1">
              {segments.map((segment, index) => {
                const last = index === segments.length - 1;
                return (
                  <li key={`${index}:${segment}`} className="flex min-w-0 items-center gap-1">
                    {index > 0 ? <CaretRight size={12} className="shrink-0 text-text-faint" aria-hidden="true" /> : null}
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
          <div className="flex-1" />
        )}
        <Button
          variant="quiet"
          size="sm"
          iconOnly
          aria-pressed={showTree}
          aria-label={showTree ? "hide file tree" : "show file tree"}
          onClick={() => setShowTree((v) => !v)}
        >
          <TreeStructure size={13} />
        </Button>
      </header>

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
              description="Pick a file to read it here. The buttons above the tree add files and folders, upload from your computer (or drop files on the tree), and download a file, a folder, or the whole workspace."
            />
          )}
        </div>
      </div>
    </div>
  );
}
