import { useEffect, useState, type ReactNode } from "react";
import { ArrowsClockwise, Bell, BellRinging, Cpu, HardDrives, SpeakerHigh, UserCircle, UsersThree, WarningCircle } from "@phosphor-icons/react";
import type { SettingsSection } from "../lib/route";
import { useApp, useCan } from "../store";
import { announce, setAnnouncementsPaused } from "../lib/announce";
import { cn } from "../lib/utils";
import Account from "./Account";
import AgentInstaller from "./AgentInstaller";
import Team from "./Team";
import UpdatePanel from "./UpdatePanel";
import { Button, Chip, PageHeader, Panel } from "./ui";

const PAUSE_KEY = "kohlab_announce_paused";

type Permission = "unsupported" | NotificationPermission;

const PERMISSION_LABEL: Record<Permission, string> = {
  unsupported: "not supported here",
  default: "not asked yet",
  granted: "granted",
  denied: "blocked",
};

/** Chip class per permission state, static map, Tailwind cannot read a template. */
const PERMISSION_CHIP: Record<Permission, string> = {
  unsupported: "chip-stopped",
  default: "chip-stopped",
  granted: "chip-running",
  denied: "chip-danger",
};

const SECTIONS: { id: SettingsSection; label: string; hint: string; icon: typeof Bell }[] = [
  { id: "account", label: "Account", hint: "Who you are on this server, and your access key.", icon: UserCircle },
  { id: "team", label: "Team", hint: "People with access, invitations, and what they did.", icon: UsersThree },
  { id: "agents", label: "Agents", hint: "Coding agents workspaces can run.", icon: Cpu },
  { id: "notifications", label: "Notifications", hint: "What reaches you when the tab is hidden.", icon: Bell },
  { id: "server", label: "Server", hint: "Where this kohlab runs and what it keeps.", icon: HardDrives },
  { id: "updates", label: "Updates", hint: "New versions of kohlab for this server.", icon: ArrowsClockwise },
];

/** Settings: one section at a time, chosen from a side list (a row on phones). */
export default function Settings() {
  const can = useCan();
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

  const route = useApp((s) => s.route);
  const navigate = useApp((s) => s.navigate);
  // Updates are owner-only: nobody else is shown a page the server would refuse.
  const sections = SECTIONS.filter((x) => x.id !== "updates" || can.own);
  const wanted = route.kind === "settings" ? route.section : undefined;
  const active = sections.find((x) => x.id === wanted) ?? sections[0];

  const notifications = (
    <Panel>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0 text-text-muted" aria-hidden="true">
            {permission === "granted" ? <BellRinging size={16} /> : <Bell size={16} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm text-text-primary">
              Browser notifications
              <span className={cn("chip", PERMISSION_CHIP[permission])}>
                <span className="chip-dot" aria-hidden="true" />
                {PERMISSION_LABEL[permission]}
              </span>
            </p>
            <p className="mt-1 text-xs leading-relaxed text-text-muted">
              A ping when an agent finishes and its workspace needs review while this tab is hidden. Nothing is sent
              while the tab is in front of you, that is what the sidebar badge is for.
            </p>
            {permission === "denied" ? (
              <p className="mt-1.5 flex items-start gap-1.5 text-xs text-status-danger">
                <WarningCircle size={13} className="mt-px shrink-0" aria-hidden="true" />
                The browser will not ask again, allow notifications for this site in your browser settings, then
                reload.
              </p>
            ) : null}
            {permission === "default" || permission === "unsupported" ? (
              <div className="mt-2">
                <Button variant="secondary" size="sm" disabled={asking || permission === "unsupported"} onClick={() => void askPermission()}>
                  {asking ? "Asking…" : "Enable notifications"}
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
              <span className="flex items-center gap-1.5 text-sm text-text-primary">
                <SpeakerHigh size={14} className="text-text-muted" aria-hidden="true" />
                Pause screen-reader announcements
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-text-muted">
                Stops the live region from announcing workspace state changes. The status chips keep updating; only
                the speech stops. Remembered on this browser.
              </span>
            </span>
          </label>
        </div>
      </div>
    </Panel>
  );

  const server = (
    <Panel>
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
              <span className="ml-2 text-xs text-text-muted">workspaces, logs and keys survive a restart of this server</span>
            </td>
          </tr>
        </tbody>
      </table>
    </Panel>
  );

  const content: Record<SettingsSection, ReactNode> = {
    account: <Account />,
    team: <Team />,
    agents: (
      <Panel>
        <div className="p-2">
          <AgentInstaller />
        </div>
      </Panel>
    ),
    notifications,
    server,
    updates: (
      <Panel>
        <UpdatePanel />
      </Panel>
    ),
  };

  return (
    <div className="surface">
      <div className="surface-inner">
        <PageHeader title="Settings" description="Stored on this server; nothing is sent anywhere else." />

        <div className="settings-layout mt-6">
          <nav className="settings-nav" aria-label="Settings sections">
            {sections.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className="settings-nav-item"
                aria-current={active.id === id ? "page" : undefined}
                onClick={() => navigate({ kind: "settings", section: id }, { replace: true })}
              >
                <Icon size={16} aria-hidden="true" weight={active.id === id ? "fill" : "regular"} />
                {label}
              </button>
            ))}
          </nav>

          <section className="min-w-0" aria-labelledby="settings-section-title">
            <h2 id="settings-section-title" className="section-title">
              {active.label}
            </h2>
            <p className="mt-1 mb-4 text-sm text-text-muted">{active.hint}</p>
            {/* Account and Team bring their own panels and spacing. */}
            <div className="settings-pane">{content[active.id]}</div>
          </section>
        </div>
      </div>
    </div>
  );
}
