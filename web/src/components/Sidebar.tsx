import { useEffect, useState, type ReactNode } from "react";
import {
  CaretDoubleLeft,
  CaretDoubleRight,
  DownloadSimple,
  Eye,
  GearSix,
  BellRinging,
  House,
  Plus,
  X,
} from "@phosphor-icons/react";
import { useApp, useCan } from "../store";
import {
  bySidebarActivity,
  SIDEBAR_GROUPS,
  sidebarGroup,
  sidebarTime,
  STATUS_LABEL,
  workspaceStatus,
  type SidebarGroup,
} from "../lib/status";
import { projectTitle, sidebarWhen } from "../lib/format";
import { cn } from "../lib/utils";
import { Button, BrandMark, Tooltip } from "./ui";

const COLLAPSE_KEY = "kohlab_sidebar_collapsed";

/** Chromium's install prompt. Not in the DOM typings, so the one member used is spelled out. */
type InstallEvent = Event & { prompt: () => Promise<void> };

/** The leading mark on each row, by group. Earlier rows keep the slot empty so titles line up. */
const GROUP_LEAD: Record<SidebarGroup, ReactNode> = {
  needs: <BellRinging size={14} weight="fill" className="text-accent" />,
  working: <span className="sidebar-live-dot" />,
  review: <Eye size={14} weight="bold" className="text-text-muted" />,
  earlier: null,
};

interface Props {
  /** Mobile drawer visibility. On desktop the rail is always present. */
  open: boolean;
  onClose: () => void;
}

export default function Sidebar({ open, onClose }: Props) {
  const route = useApp((s) => s.route);
  const workspaces = useApp((s) => s.workspaces);
  const navigate = useApp((s) => s.navigate);
  const setNewOpen = useApp((s) => s.setNewOpen);
  const can = useCan();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "true");
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, String(collapsed));
  }, [collapsed]);

  // The browser offers the install prompt once; hold it until the button uses it.
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as InstallEvent);
    };
    const onInstalled = () => setInstallEvent(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    setInstallEvent(null);
  };

  // Already running as an app: there is nothing to install.
  const standalone = window.matchMedia("(display-mode: standalone)").matches;

  const groups = SIDEBAR_GROUPS.map((group) => ({
    ...group,
    items: workspaces.filter((w) => sidebarGroup(w) === group.key).sort(bySidebarActivity),
  })).filter((group) => group.items.length > 0);

  const activeKind = route.kind === "workspace" ? "workspaces" : route.kind;
  const homeActive = activeKind === "workspaces";
  const settingsActive = activeKind === "settings";

  return (
    <aside
      className="sidebar"
      data-open={open}
      data-collapsed={collapsed}
      aria-label="Primary navigation"
    >
      <div className="sidebar-head flex min-h-[3.25rem] items-center gap-2.5 px-3">
        <span className="sidebar-brand grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-text-on-accent">
          <BrandMark size={16} />
        </span>
        <span className="sidebar-label text-base font-semibold tracking-tight text-text-primary">kohlab</span>
        <div className="sidebar-head-fill flex-1" />
        {/* Desktop: collapse the rail. Mobile: dismiss the drawer. The collapsed
            rail has room for one control, so this one is the survivor: see
            .sidebar[data-collapsed="true"] .sidebar-head in index.css. */}
        <Button
          variant="quiet"
          iconOnly
          size="sm"
          className="sidebar-toggle hidden shell:inline-flex"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <CaretDoubleRight size={16} /> : <CaretDoubleLeft size={16} />}
        </Button>
        <Button
          variant="quiet"
          iconOnly
          size="sm"
          className="shell:hidden"
          aria-label="Close navigation"
          onClick={onClose}
        >
          <X size={16} />
        </Button>
      </div>

      {can.mutate ? (
        <div className="px-2.5 pb-2 pt-1">
          <Button
            variant="primary"
            className={cn("w-full", collapsed && "shell:px-0")}
            aria-label="New project"
            onClick={() => {
              setNewOpen(true);
              onClose();
            }}
          >
            <Plus size={16} weight="bold" />
            <span className="sidebar-label">New project</span>
          </Button>
        </div>
      ) : null}

      <nav className="flex flex-col gap-0.5 px-2.5 pb-2" aria-label="Views">
        <Tooltip content="Home" disabled={!collapsed}>
          <button
            type="button"
            className="sidebar-row"
            aria-current={homeActive ? "page" : undefined}
            aria-label="Home"
            onClick={() => navigate({ kind: "workspaces" })}
          >
            <House size={18} className="shrink-0" weight={homeActive ? "fill" : "regular"} />
            <span className="sidebar-label flex-1 text-base">Home</span>
          </button>
        </Tooltip>
      </nav>

      <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-2.5" aria-label="Projects">
        {/* Every row is a workspace: one task, one branch, one agent; it can
            hold several terminal sessions inside. */}
        {workspaces.length === 0 ? (
          <p className="sidebar-label px-2 pt-2 text-sm leading-relaxed text-text-muted">
            Nothing yet. Start a new project and Claude gets to work.
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.key} className="mb-4">
              <p className="sidebar-section-title section-label mb-1 flex items-center justify-between px-2.5">
                <span>{group.label}</span>
                <span className="tnum">{group.items.length}</span>
              </p>
              {group.items.map((workspace) => {
                const status = workspaceStatus(workspace);
                const needsYou = group.key === "needs";
                const title = projectTitle(workspace);
                const statusText = STATUS_LABEL[status];
                const selected = route.kind === "workspace" && route.id === workspace.id;
                return (
                  <Tooltip key={workspace.id} content={`${title}, ${statusText}`} disabled={!collapsed}>
                    <button
                      type="button"
                      className="sidebar-row"
                      data-selected={selected}
                      aria-current={selected ? "page" : undefined}
                      aria-label={`${title}, ${statusText}`}
                      onClick={() => navigate({ kind: "workspace", id: workspace.id })}
                    >
                      <span className="sidebar-lead" aria-hidden="true">
                        {GROUP_LEAD[group.key]}
                      </span>
                      <span
                        className={cn("sidebar-initial", needsYou && "border-accent text-text-primary")}
                        aria-hidden="true"
                      >
                        {title.charAt(0).toUpperCase()}
                      </span>
                      <span className="sidebar-label min-w-0 flex-1 truncate text-base text-text-primary" title={workspace.id}>
                        {title}
                      </span>
                      <span className="sidebar-label shrink-0 text-sm text-text-faint tnum">
                        {sidebarWhen(sidebarTime(workspace))}
                      </span>
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          ))
        )}
      </nav>

      <div className="flex flex-col gap-0.5 border-t border-line-subtle p-2.5">
        {installEvent && !standalone ? (
          <Tooltip content="Install app" disabled={!collapsed}>
            <button type="button" className="sidebar-row" aria-label="Install app" onClick={() => void install()}>
              <DownloadSimple size={18} className="shrink-0" />
              <span className="sidebar-label flex-1 text-base">Install app</span>
            </button>
          </Tooltip>
        ) : null}
        <Tooltip content="Settings" disabled={!collapsed}>
          <button
            type="button"
            className="sidebar-row"
            aria-current={settingsActive ? "page" : undefined}
            aria-label="Settings"
            onClick={() => navigate({ kind: "settings" })}
          >
            <GearSix size={18} className="shrink-0" weight={settingsActive ? "fill" : "regular"} />
            <span className="sidebar-label flex-1 text-base">Settings</span>
          </button>
        </Tooltip>
      </div>
    </aside>
  );
}
