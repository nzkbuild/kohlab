import { useEffect, useState } from "react";
import {
  CaretDoubleLeft,
  CaretDoubleRight,
  DownloadSimple,
  GearSix,
  Plus,
  House,
  Wrench,
  X,
} from "@phosphor-icons/react";
import { useApp, useCan } from "../store";
import { byReviewFirst, STATUS_LABEL, STATUS_TEXT, workspaceStatus } from "../lib/status";
import { cn } from "../lib/utils";
import { Button, BrandMark, Tooltip } from "./ui";

const COLLAPSE_KEY = "kohlab_sidebar_collapsed";

/** Chromium's install prompt. Not in the DOM typings, so the one member used is spelled out. */
type InstallEvent = Event & { prompt: () => Promise<void> };

interface Props {
  /** Mobile drawer visibility. On desktop the rail is always present. */
  open: boolean;
  onClose: () => void;
}

export default function Sidebar({ open, onClose }: Props) {
  const route = useApp((s) => s.route);
  const workspaces = useApp((s) => s.workspaces);
  const navigate = useApp((s) => s.navigate);
  const advanced = useApp((s) => s.advanced);
  const setAdvanced = useApp((s) => s.setAdvanced);
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

  const ordered = [...workspaces].sort(byReviewFirst);
  const reviewCount = workspaces.filter((w) => workspaceStatus(w) === "needs-review").length;

  const nav = [
    { kind: "workspaces" as const, label: "Home", icon: House, badge: reviewCount },
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
      <div className="sidebar-head flex min-h-13 items-center gap-2.5 border-b border-line-subtle px-3">
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
          aria-label={collapsed ? "expand sidebar" : "collapse sidebar"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <CaretDoubleRight size={13} /> : <CaretDoubleLeft size={13} />}
        </Button>
        <Button
          variant="quiet"
          iconOnly
          size="sm"
          className="shell:hidden"
          aria-label="close navigation"
          onClick={onClose}
        >
          <X size={13} />
        </Button>
      </div>

      {can.mutate ? (
        <div className="px-2.5 pt-3">
          <Button
            variant="primary"
            className={cn("w-full", collapsed && "shell:px-0")}
            aria-label={advanced ? "new workspace" : "new project"}
            onClick={() => navigate({ kind: "workspaces", create: true })}
          >
            <Plus size={14} />
            <span className="sidebar-label">{advanced ? "New workspace" : "New project"}</span>
          </Button>
        </div>
      ) : null}

      <nav className="flex flex-col gap-0.5 p-2.5" aria-label="Views">
        {nav.map(({ kind, label, icon: Icon, badge }) => (
          <Tooltip key={kind} content={badge > 0 ? `${label}, ${badge} waiting for review` : label} disabled={!collapsed}>
          <button
            type="button"
            className="sidebar-row"
            aria-current={activeKind === kind ? "page" : undefined}
            aria-label={badge > 0 ? `${label}, ${badge} waiting for review` : label}
            onClick={() => navigate({ kind })}
          >
            <Icon size={17} className="shrink-0" weight={activeKind === kind ? "fill" : "regular"} />
            <span className="sidebar-label flex-1">{label}</span>
            {badge > 0 ? <span className="sidebar-badge chip chip-review tnum" aria-hidden="true">{badge}</span> : null}
          </button>
          </Tooltip>
        ))}
      </nav>

      <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-2.5" aria-label="Workspaces">
        {/* Every row is a workspace: one task, one branch, one agent; it can
            hold several terminal sessions inside. */}
        <p className="sidebar-section-title section-label mb-1.5 mt-1 px-2">{advanced ? "Workspaces" : "Projects"}</p>

        {ordered.length === 0 ? (
          <p className="sidebar-label px-2 text-xs leading-relaxed text-text-muted">
            {advanced ? "Nothing yet. Create a workspace and its agent starts immediately." : "Nothing yet. Start a new project and the AI gets to work."}
          </p>
        ) : (
          ordered.map((workspace) => {
            const status = workspaceStatus(workspace);
            const selected = route.kind === "workspace" && route.id === workspace.id;
            return (
              <Tooltip key={workspace.id} content={`${workspace.task || workspace.id}, ${STATUS_LABEL[status]}`} disabled={!collapsed}>
              <button
                type="button"
                className="sidebar-row"
                data-selected={selected}
                aria-current={selected ? "page" : undefined}
                aria-label={`${workspace.task || workspace.id}, ${STATUS_LABEL[status]}`}
                onClick={() => navigate({ kind: "workspace", id: workspace.id })}
              >
                <span
                  className={cn("chip-dot shrink-0", STATUS_TEXT[status])}
                  aria-hidden="true"
                />
                <span className="sidebar-label flex-1">
                  <span className="block truncate text-xs text-text-primary" title={workspace.id}>
                    {workspace.task || workspace.id}
                  </span>
                  <span className="block truncate text-xs text-text-muted">
                    {advanced ? (
                      <>
                        {workspace.agent}
                        {status === "running" ? "" : ` · ${STATUS_LABEL[status]}`}
                      </>
                    ) : (
                      status === "running" ? "working" : STATUS_LABEL[status]
                    )}
                  </span>
                </span>
              </button>
              </Tooltip>
            );
          })
        )}
      </nav>

      <div className="flex flex-col gap-0.5 border-t border-line-subtle p-2.5">
        {installEvent && !standalone ? (
          <Tooltip content="Install app" disabled={!collapsed}>
            <button type="button" className="sidebar-row" aria-label="Install app" onClick={() => void install()}>
              <DownloadSimple size={17} className="shrink-0" />
              <span className="sidebar-label flex-1">Install app</span>
            </button>
          </Tooltip>
        ) : null}
        <Tooltip content="Advanced tools" disabled={!collapsed}>
          <button
            type="button"
            role="switch"
            className="sidebar-row"
            aria-checked={advanced}
            aria-label="Advanced tools"
            onClick={() => setAdvanced(!advanced)}
          >
            <Wrench size={17} className="shrink-0" />
            <span className="sidebar-label flex-1">Advanced tools</span>
            <span className="sidebar-label text-xs text-text-muted">{advanced ? "on" : "off"}</span>
          </button>
        </Tooltip>
      </div>
    </aside>
  );
}
