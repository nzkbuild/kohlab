import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, CaretRight, File, FolderOpen, FolderSimple } from "@phosphor-icons/react";
import { api } from "../api";
import type { TreeNode } from "../types";
import { cn } from "../lib/utils";
import { Button, SkeletonRows } from "./ui";

interface Props {
  workspaceId: string;
  onOpenFile: (path: string) => void;
}

interface Row {
  path: string;
  name: string;
  type: "dir" | "file";
  depth: number;
}

/** Visible rows in visual order — the order the arrow keys walk. */
function flattenTree(nodes: TreeNode[], expanded: Set<string>, depth = 0, prefix = ""): Row[] {
  const rows: Row[] = [];
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    rows.push({ path, name: node.name, type: node.type, depth });
    if (node.type === "dir" && expanded.has(path)) {
      rows.push(...flattenTree(node.children ?? [], expanded, depth + 1, path));
    }
  }
  return rows;
}

/**
 * File tree. The tree is flattened into the rows you can actually see, and the
 * arrow keys walk that list: this is what makes Down/Up/RIGHT/LEFT mean the
 * same thing here as in every other file explorer (APG tree pattern, roving
 * tabindex so the whole tree is one tab stop).
 */
export default function FileTree({ workspaceId, onOpenFile }: Props) {
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set<string>());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [focused, setFocused] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);

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

  const rows = useMemo(() => flattenTree(tree ?? [], expanded), [tree, expanded]);
  const focusIndex = Math.min(focused, Math.max(rows.length - 1, 0));

  const focusRow = (index: number) => {
    setFocused(index);
    containerRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`)?.focus();
  };

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };

  const openFile = (path: string) => {
    setActivePath(path);
    onOpenFile(path);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const row = rows[index];
    if (!row) return;
    const last = rows.length - 1;

    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      focusRow(
        e.key === "ArrowDown" ? Math.min(index + 1, last) : e.key === "ArrowUp" ? Math.max(index - 1, 0) : e.key === "Home" ? 0 : last,
      );
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (row.type !== "dir") return;
      if (!expanded.has(row.path)) {
        toggleDir(row.path);
        return;
      }
      const child = rows[index + 1];
      if (child && child.depth > row.depth) focusRow(index + 1);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (row.type === "dir" && expanded.has(row.path)) {
        toggleDir(row.path);
        return;
      }
      // Close a file row by hopping to the directory that owns it.
      for (let i = index - 1; i >= 0; i--) {
        if (rows[i].depth < row.depth) {
          focusRow(i);
          return;
        }
      }
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (row.type === "dir") toggleDir(row.path);
      else openFile(row.path);
    }
  };

  const isOpen = tree !== null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-10 items-center gap-2 border-b border-line-subtle px-3">
        <span className="eyebrow flex-1 truncate">Files</span>
        <Button variant="quiet" size="sm" iconOnly aria-label="Refresh file tree" onClick={() => void load()}>
          <ArrowsClockwise size={13} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {error ? (
          <div role="alert" className="p-2">
            <p className="text-xs text-status-danger">{error}</p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => void load()}>
              retry
            </Button>
          </div>
        ) : !isOpen ? (
          <SkeletonRows rows={8} />
        ) : rows.length === 0 ? (
          <p className="p-2 text-xs text-text-muted">No files in this workspace yet.</p>
        ) : (
          <div ref={containerRef} role="tree" aria-label={`Files in ${workspaceId}`}>
            {rows.map((row, index) => {
              const dir = row.type === "dir";
              const open = dir && expanded.has(row.path);
              return (
                <button
                  key={row.path}
                  type="button"
                  role="treeitem"
                  data-row={index}
                  data-selected={activePath === row.path ? "true" : undefined}
                  aria-level={row.depth + 1}
                  aria-expanded={dir ? open : undefined}
                  tabIndex={index === focusIndex ? 0 : -1}
                  className="file-row w-full text-start"
                  style={{ paddingLeft: `${row.depth * 12 + 6}px` }}
                  onClick={() => {
                    setFocused(index);
                    if (dir) toggleDir(row.path);
                    else openFile(row.path);
                  }}
                  onKeyDown={(e) => onKeyDown(e, index)}
                >
                  {dir ? (
                    <CaretRight
                      size={10}
                      aria-hidden="true"
                      className={cn("shrink-0 transition-transform", open && "rotate-90")}
                    />
                  ) : (
                    <span className="w-2.5 shrink-0" aria-hidden="true" />
                  )}
                  {dir ? (
                    open ? (
                      <FolderOpen size={13} aria-hidden="true" />
                    ) : (
                      <FolderSimple size={13} aria-hidden="true" />
                    )
                  ) : (
                    <File size={13} aria-hidden="true" />
                  )}
                  <span className="truncate">{row.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
