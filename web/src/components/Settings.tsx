import { useEffect, useState } from "react";
import { Bell, BellRinging, Cpu, HardDrives, SpeakerHigh, WarningCircle } from "@phosphor-icons/react";
import { useApp } from "../store";
import { announce, setAnnouncementsPaused } from "../lib/announce";
import { cn } from "../lib/utils";
import AgentInstaller from "./AgentInstaller";
import Team from "./Team";
import { Button, Chip, Panel, PanelHead } from "./ui";

const PAUSE_KEY = "kohlab_announce_paused";

type Permission = "unsupported" | NotificationPermission;

const PERMISSION_LABEL: Record<Permission, string> = {
  unsupported: "not supported here",
  default: "not asked yet",
  granted: "granted",
  denied: "blocked",
};

/** Chip class per permission state — static map, Tailwind cannot read a template. */
const PERMISSION_CHIP: Record<Permission, string> = {
  unsupported: "chip-stopped",
  default: "chip-stopped",
  granted: "chip-running",
  denied: "chip-danger",
};

/** Settings: agents, server facts, notifications, team. */
export default function Settings() {
  const workspaceCount = useApp((s) => s.workspaces.length);

  // Read, never request: `Notification.permission` is free, and browsers only
  // honour a request from a user gesture.
  const [permission, setPermission] = useState<Permission>(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const [asking, setAsking] = useState(false);
  const [paused, setPaused] = useState(() => localStorage.getItem(PAUSE_KEY) === "1");

  // The pause control (SC 2.2.2): persist it, and push it into the
  // module-level channel so a reload cannot silently resume a paused reader.
  useEffect(() => {
    setAnnouncementsPaused(paused);
    localStorage.setItem(PAUSE_KEY, paused ? "1" : "0");
  }, [paused]);

  const askPermission = async () => {
    if (typeof Notification === "undefined") return;
    setAsking(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      announce(result === "granted" ? "notifications enabled" : `notifications ${result}`);
    } catch (e) {
      setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
      announce(`notification permission failed: ${(e as Error).message}`);
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="surface">
      <div className="surface-inner max-w-3xl">
        <header className="mb-5">
          <h1 className="surface-title flex items-center gap-2">
            <HardDrives size={20} className="text-text-muted" aria-hidden="true" />
            Settings
          </h1>
          <p className="surface-description">
            Everything here is stored on this server; nothing is sent anywhere else.
          </p>
        </header>

        <Panel>
          <PanelHead title="Agents" icon={<Cpu size={15} aria-hidden="true" />} meta="coding agents available to workspaces" />
          <div className="p-2">
            <AgentInstaller />
          </div>
        </Panel>

        <Panel className="mt-4">
          <PanelHead title="Server" icon={<HardDrives size={15} aria-hidden="true" />} meta={location.host} />
          <table className="data-table w-full">
            <caption className="sr-only">Server address, workspace count and persistence</caption>
            <tbody>
              <tr>
                <td className="text-text-muted">Address</td>
                <td className="mono text-text-primary">{location.host}</td>
              </tr>
              <tr>
                <td className="text-text-muted">Workspaces</td>
                <td className="tnum text-text-primary">{workspaceCount}</td>
              </tr>
              <tr>
                <td className="text-text-muted">Persistence</td>
                <td>
                  <Chip>state on disk</Chip>
                  <span className="ml-2 text-2xs text-text-muted">
                    workspaces, logs and keys survive a restart of this server
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </Panel>

        <Panel className="mt-4">
          <PanelHead title="Notifications" icon={<Bell size={15} aria-hidden="true" />} meta="what reaches you when the tab is hidden" />
          <div className="flex flex-col gap-4 p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0 text-text-muted" aria-hidden="true">
                {permission === "granted" ? <BellRinging size={16} /> : <Bell size={16} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-xs text-text-primary">
                  Browser notifications
                  <span className={cn("chip", PERMISSION_CHIP[permission])}>
                    <span className="chip-dot" aria-hidden="true" />
                    {PERMISSION_LABEL[permission]}
                  </span>
                </p>
                <p className="mt-1 text-2xs leading-relaxed text-text-muted">
                  A ping when an agent finishes and its workspace needs review while this tab is
                  hidden. Nothing is sent while the tab is in front of you — that is what the
                  sidebar badge is for.
                </p>
                {permission === "denied" ? (
                  <p className="mt-1.5 flex items-start gap-1.5 text-2xs text-status-danger">
                    <WarningCircle size={13} className="mt-px shrink-0" aria-hidden="true" />
                    The browser will not ask again — allow notifications for this site in your browser
                    settings, then reload.
                  </p>
                ) : null}
                {permission === "default" || permission === "unsupported" ? (
                  <div className="mt-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={asking || permission === "unsupported"}
                      onClick={() => void askPermission()}
                    >
                      {asking ? "asking…" : "enable notifications"}
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="border-t border-line-subtle pt-4">
              <label className="flex cursor-pointer items-start gap-3" htmlFor="announce-paused">
                <input
                  id="announce-paused"
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-accent"
                  checked={paused}
                  onChange={(e) => setPaused(e.target.checked)}
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-xs text-text-primary">
                    <SpeakerHigh size={14} className="text-text-muted" aria-hidden="true" />
                    Pause screen-reader announcements
                  </span>
                  <span className="mt-0.5 block text-2xs leading-relaxed text-text-muted">
                    Stops the live region from announcing workspace state changes (finished, needs
                    review, committed). The status chips keep updating; only the speech stops. The
                    setting is remembered on this browser.
                  </span>
                </span>
              </label>
            </div>
          </div>
        </Panel>

        <Team />
      </div>
    </div>
  );
}
