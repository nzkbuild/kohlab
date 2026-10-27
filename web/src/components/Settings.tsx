import { useEffect, useState, type ReactNode } from "react";
import { ArrowsClockwise, Bell, BellRinging, SignOut, Sparkle, SlidersHorizontal, UserCircle, WarningCircle } from "@phosphor-icons/react";
import type { SettingsSection } from "../lib/route";
import { useApp, useCan } from "../store";
import { clearKey } from "../api";
import { setAnnouncementsPaused } from "../lib/announce";
import { cn } from "../lib/utils";
import ProvidersPane from "./ProvidersPane";
import PushToggle from "./PushToggle";
import UpdatePanel from "./UpdatePanel";
import { Button, PageHeader, Panel } from "./ui";

const PAUSE_KEY = "kohlab_announce_paused";

type Permission = "unsupported" | NotificationPermission;

const PERMISSION_LABEL: Record<Permission, string> = {
  unsupported: "Not available here",
  default: "Not asked yet",
  granted: "On",
  denied: "Blocked",
};

/** Chip class per permission state, static map, Tailwind cannot read a template. */
const PERMISSION_CHIP: Record<Permission, string> = {
  unsupported: "chip-stopped",
  default: "chip-stopped",
  granted: "chip-running",
  denied: "chip-danger",
};

/** Only the sections a non-technical person needs. Updates is owner-only. */
const SECTIONS: { id: SettingsSection; label: string; hint: string; icon: typeof Bell }[] = [
  { id: "account", label: "Account", hint: "Who is signed in on this computer.", icon: UserCircle },
  { id: "appearance", label: "Appearance", hint: "How the project page looks.", icon: SlidersHorizontal },
  { id: "agents", label: "AI", hint: "The AIs on this computer: who is signed in, how much is used, and which models they offer.", icon: Sparkle },
  { id: "notifications", label: "Notifications", hint: "What reaches you when Kohlab is in the background.", icon: Bell },
  { id: "updates", label: "Updates", hint: "New versions of Kohlab.", icon: ArrowsClockwise },
];

/** Account: sign out is the only thing here. Keys are not something people manage by hand. */
function AccountPane() {
  const signOut = () => {
    clearKey();
    location.reload();
  };
  return (
    <Panel>
      <div className="flex flex-col gap-4 p-4">
        <p className="text-sm text-text-secondary">You are signed in on this computer.</p>
        <div>
          <Button variant="secondary" onClick={signOut}>
            <SignOut size={14} aria-hidden="true" />
            Sign out
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-text-muted">
          Signing out removes Kohlab's access from this browser. Your projects stay as they are.
        </p>
      </div>
    </Panel>
  );
}

/** Appearance: the power tools switch. Off keeps the project page to Claude and Changes. */
function AppearancePane() {
  const powerTools = useApp((s) => s.powerTools);
  const setPowerTools = useApp((s) => s.setPowerTools);
  return (
    <Panel>
      <div className="p-4">
        <label className="flex min-h-11 cursor-pointer items-start gap-3" htmlFor="power-tools">
          <input
            id="power-tools"
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 accent-accent"
            checked={powerTools}
            onChange={(e) => setPowerTools(e.target.checked)}
          />
          <span className="min-w-0">
            <span className="block text-sm text-text-primary">Show files and terminal</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-text-muted">
              Adds a Files tab and a status bar for people who like to see the code. Follows your account on every device.
            </span>
          </span>
        </label>
      </div>
    </Panel>
  );
}

/** Settings: one section at a time, chosen from a side list (a row on phones). */
export default function Settings() {
  const can = useCan();

  // Read, never request: `Notification.permission` is free, and browsers only
  // honour a request from a user gesture.
  const [permission] = useState<Permission>(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const [paused, setPaused] = useState(() => localStorage.getItem(PAUSE_KEY) === "1");

  // The pause control (SC 2.2.2): persist it, and push it into the
  // module-level channel so a reload cannot silently resume a paused reader.
  useEffect(() => {
    setAnnouncementsPaused(paused);
    localStorage.setItem(PAUSE_KEY, paused ? "1" : "0");
  }, [paused]);

  const route = useApp((s) => s.route);
  const navigate = useApp((s) => s.navigate);
  // Updates are owner-only: nobody else is shown a page the server would refuse.
  const sections = SECTIONS.filter((x) => x.id !== "updates" || can.own);
  const wanted = route.kind === "settings" ? route.section : undefined;
  const active = sections.find((x) => x.id === wanted) ?? sections[0];
  // A link to a section that is not here (or not for this person) shows the first one, and the address says so too.
  useEffect(() => {
    if (route.kind === "settings" && route.section !== undefined && route.section !== active.id) navigate({ kind: "settings", section: active.id }, { replace: true });
  }, [route, active.id, navigate]);

  const notifications = (
    <Panel>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0 text-text-muted" aria-hidden="true">
            {permission === "granted" ? <BellRinging size={16} /> : <Bell size={16} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm text-text-primary">
              Notifications in this browser
              <span className={cn("chip", PERMISSION_CHIP[permission])}>
                <span className="chip-dot" aria-hidden="true" />
                {PERMISSION_LABEL[permission]}
              </span>
            </p>
            <p className="mt-1 text-xs leading-relaxed text-text-muted">
              A ping when the AI needs you or a project is ready to check, while this tab is in the background. Nothing
              is sent while you are looking at Kohlab.
            </p>
            {permission === "denied" ? (
              <p className="mt-1.5 flex items-start gap-2 text-xs text-status-danger">
                <WarningCircle size={13} className="mt-px shrink-0" aria-hidden="true" />
                Your browser will not ask again. Allow notifications for this site in the browser settings, then reload.
              </p>
            ) : null}
          </div>
        </div>

        <div className="border-t border-line-subtle pt-4">
          <PushToggle />
        </div>

        <div className="border-t border-line-subtle pt-4">
          <label className="flex min-h-11 cursor-pointer items-start gap-3" htmlFor="announce-paused">
            <input
              id="announce-paused"
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-accent"
              checked={paused}
              onChange={(e) => setPaused(e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-sm text-text-primary">Pause screen reader announcements</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-text-muted">
                Stops spoken updates about your projects. Everything still shows on screen. Remembered on this browser.
              </span>
            </span>
          </label>
        </div>
      </div>
    </Panel>
  );

  const content: Partial<Record<SettingsSection, ReactNode>> = {
    account: <AccountPane />,
    appearance: <AppearancePane />,
    agents: <ProvidersPane owner={can.own} />,
    notifications,
    updates: (
      <Panel>
        <UpdatePanel />
      </Panel>
    ),
  };

  return (
    <div className="surface">
      <div className="surface-inner">
        <PageHeader title="Settings" description="Changes are saved as you make them." />

        <div className="settings-layout mt-6">
          <nav className="settings-nav" aria-label="Settings sections">
            {sections.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className="settings-nav-item !min-h-11"
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
            <div className="settings-pane">{content[active.id]}</div>
          </section>
        </div>
      </div>
    </div>
  );
}
