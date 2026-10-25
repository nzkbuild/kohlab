import { CaretRight, FileText } from "@phosphor-icons/react";
import type { TreeNode } from "../../types";
import { cn } from "../../lib/utils";
import type { Change } from "./tree";

interface Props {
  nodes: TreeNode[];
  changes: Map<string, Change>;
  expanded: ReadonlySet<string>;
  activePath: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}

/**
 * The project tree as nested lists. Folders are buttons with aria-expanded,
 * files are buttons; the open file carries aria-current. Each level is a real
 * list, so screen readers announce the depth.
 */
export default function TreeList(props: Props) {
  return (
    <ul aria-label="Project files" className="flex flex-col gap-px">
      <Branch {...props} prefix="" depth={0} />
    </ul>
  );
}

function Branch({ nodes, prefix, depth, ...rest }: Omit<Props, "nodes"> & { nodes: TreeNode[]; prefix: string; depth: number }) {
  const { changes, expanded, activePath, onToggle, onOpen } = rest;
  return (
    <>
      {nodes.map((node) => {
        const path = prefix ? `${prefix}/${node.name}` : node.name;
        const indent = { paddingInlineStart: `${8 + depth * 14}px` };
        if (node.type === "dir") {
          const open = expanded.has(path);
          return (
            <li key={path}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => onToggle(path)}
                style={indent}
                className="flex min-h-8 w-full items-center gap-2 rounded-lg pe-2 text-start text-small text-text-secondary hover:bg-surface-hover hover:text-text-primary max-md:min-h-11"
              >
                <CaretRight size={12} className={cn("shrink-0 text-text-muted transition-transform", open && "rotate-90")} aria-hidden="true" />
                <span className="min-w-0 truncate">{node.name}</span>
              </button>
              {open && node.children?.length ? (
                <ul className="flex flex-col gap-px">
                  <Branch {...rest} nodes={node.children} prefix={path} depth={depth + 1} />
                </ul>
              ) : null}
            </li>
          );
        }
        const change = changes.get(path);
        const active = activePath === path;
        return (
          <li key={path}>
            <button
              type="button"
              aria-current={active ? "true" : undefined}
              onClick={() => onOpen(path)}
              style={indent}
              className={cn(
                "flex min-h-8 w-full items-center gap-2 rounded-lg pe-2 text-start hover:bg-surface-hover max-md:min-h-11",
                active ? "bg-surface-active text-text-primary" : "text-text-secondary hover:text-text-primary",
              )}
            >
              <FileText size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
              <span className="mono min-w-0 flex-1 truncate text-sm">{node.name}</span>
              {change ? <span className="shrink-0 text-xs text-text-muted">{change}</span> : null}
            </button>
          </li>
        );
      })}
    </>
  );
}
