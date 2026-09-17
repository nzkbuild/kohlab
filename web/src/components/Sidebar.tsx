import { useEffect, useState } from "react";
import {
  CaretDoubleLeft,
  CaretDoubleRight,
  GearSix,
  Plus,
  SquaresFour,
  Stack,
  TerminalWindow,
  X,
} from "@phosphor-icons/react";
import { useApp, type Connection } from "../store";
import { byReviewFirst, STATUS_LABEL, STATUS_TEXT, workspaceStatus } from "../lib/status";
import { cn } from "../lib/utils";
import { Button } from "./ui";

const COLLAPSE_KEY = "kohlab_sidebar_collapsed";

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: "connecting",
  live: "live",
  reconnecting: "reconnecting",
  offline: "offline",
};

const CONNECTION_CHIP: Record<Connection, string> = {
  connecting: "chip-stopped",
  live: "chip-running",
  reconnecting: "chip-review",
  offline: "chip-danger",
};

interface Props {
  /** Mobile drawer visibility. On desktop the rail is always present. */
  open: boolean;
  onClose: () => void;
}

export default function Sidebar({ open, onClose }: Props) {
  const route = useApp((s) => s.route);
  const workspaces = useApp((s) => s.workspaces);
  const connection = useApp((s) => s.connection);
  const navigate = useApp((s) => s.navigate);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "true");

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, String(collapsed));
  }, [collapsed]);

  const ordered = [...workspaces].sort(byReviewFirst);
  const reviewCount = workspaces.filter((w) => workspaceStatus(w) === "needs-review").length;

  const nav = [
    { kind: "dashboard" as const, label: "Command center", icon: SquaresFour, badge: 0 },
    { kind: "workspaces" as const, label: "Workspaces", icon: Stack, badge: 0 },
    { kind: "settings" as const, label: "Settings", icon: GearSix, badge: 0 },
  ];

  const activeKind = route.kind === "workspace" ? "workspaces" : route.kind;

  return (
    <aside
      className="sidebar"
      data-open={open}
      data-collapsed={collapsed}
      aria-label="Primary navigation"
    >
      <div className="flex min-h-13 items-center gap-2.5 border-b border-line-subtle px-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-text-on-accent">
          <TerminalWindow size={15} weight="bold" />
        </span>
        <span className="sidebar-label text-base font-semibold tracking-tight">kohlab</span>
        <div className="flex-1" />
        {/* Desktop: collapse the rail. Mobile: dismiss the drawer. */}
        <Button
          variant="quiet"
          iconOnly
          size="sm"
          className="hidden shell:inline-flex"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <CaretDoubleRight size={15} /> : <CaretDoubleLeft size={15} />}
        </Button>
        <Button
          variant="quiet"
          iconOnly
          size="sm"
          className="shell:hidden"
          aria-label="Close navigation"
          onClick={onClose}
        >
          <X size={15} />
        </Button>
      </div>

      <div className="px-2.5 pt-3">
        <Button
          variant="primary"
          className={cn("w-full", collapsed && "shell:px-0")}
          aria-label="New workspace"
          onClick={() => navigate({ kind: "workspaces" })}
        >
          <Plus size={16} weight="bold" />
          <span className="sidebar-label">new workspace</span>
        </Button>
      </div>

      <nav className="flex flex-col gap-0.5 p-2.5" aria-label="Views">
        {nav.map(({ kind, label, icon: Icon, badge }) => (
          <button
            key={kind}
            type="button"
            className="sidebar-row"
            aria-current={activeKind === kind ? "page" : undefined}
            aria-label={label}
            title={label}
            onClick={() => navigate({ kind })}
          >
            <Icon size={17} className="shrink-0" weight={activeKind === kind ? "fill" : "regular"} />
            <span className="sidebar-label flex-1">{label}</span>
            {badge > 0 ? <span className="chip chip-review">{badge}</span> : null}
          </button>
        ))}
      </nav>

      <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-2.5" aria-label="Workspaces">
        <p className="sidebar-section-title mb-2 px-2 text-2xs font-semibold uppercase tracking-wider text-text-muted">
          Workspaces
          {reviewCount > 0 ? <span className="text-status-review"> · {reviewCount} to review</span> : null}
        </p>

        {ordered.length === 0 ? (
          <p className="sidebar-label px-2 text-xs leading-relaxed text-text-muted">
            Nothing yet. Create a workspace and its agent starts immediately.
          </p>
        ) : (
          ordered.map((workspace) => {
            const status = workspaceStatus(workspace);
            const selected = route.kind === "workspace" && route.id === workspace.id;
            return (
              <button
                key={workspace.id}
                type="button"
                className="sidebar-row"
                data-selected={selected}
                aria-current={selected ? "page" : undefined}
                aria-label={`${workspace.id} — ${STATUS_LABEL[status]}`}
                title={`${workspace.id} — ${STATUS_LABEL[status]}`}
                onClick={() => navigate({ kind: "workspace", id: workspace.id })}
              >
                <span
                  className={cn("chip-dot shrink-0", STATUS_TEXT[status])}
                  aria-hidden="true"
                />
                <span className="sidebar-label flex-1">
                  <span className="block truncate text-xs font-medium text-text-primary">{workspace.id}</span>
                  <span className="mono block truncate text-2xs text-text-muted">{workspace.agent}</span>
                </span>
              </button>
            );
          })
        )}
      </nav>

      <div className="flex min-h-11 items-center gap-2 border-t border-line-subtle px-3">
        <span className={cn("chip", CONNECTION_CHIP[connection])}>
          <span className="chip-dot" aria-hidden="true" />
          {CONNECTION_LABEL[connection]}
        </span>
        <span className="sidebar-label text-2xs text-text-faint">persists on this server</span>
      </div>
    </aside>
  );
}
