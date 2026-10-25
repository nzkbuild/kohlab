import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowsClockwise, Bell, BellRinging, Copy, SignOut, Sparkle, SlidersHorizontal, UserCircle, WarningCircle } from "@phosphor-icons/react";
import type { SettingsSection } from "../lib/route";
import { useApp, useCan } from "../store";
import { api, clearKey } from "../api";
import type { AgentStatus } from "../types";
import { announce, setAnnouncementsPaused } from "../lib/announce";
import { agentName } from "../lib/agentName";
import { cn } from "../lib/utils";
import PushToggle from "./PushToggle";
import UpdatePanel from "./UpdatePanel";
import { Button, Chip, PageHeader, Panel } from "./ui";

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
  { id: "agents", label: "AI", hint: "The AI helpers on this computer.", icon: Sparkle },
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

/** The AIs on this computer, Claude first. Names come from agentName; keys are what the server reports. */
const AGENT_KEYS = ["claude", "hermes", "omp", "codex", "gemini", "opencode", "pi"];
/** Always listed; the others appear only once installed. */
const ALWAYS_LISTED = new Set(["claude", "hermes", "omp", "codex"]);

/** Codex sign-in for the owner: shows the code and link from `codex login --device-auth`, then polls until the browser approval lands. */
function CodexSignIn({ onConnected }: { onConnected: () => void }) {
  const [phase, setPhase] = useState<"idle" | "starting" | "waiting" | "failed">("idle");
  const [login, setLogin] = useState<{ url: string; code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setPhase("starting");
    setError(null);
    api.codexLogin().then(
      (l) => {
        setLogin(l);
        setPhase("waiting");
      },
      (e: Error) => {
        setError(e.message);
        setPhase("failed");
      },
    );
  };

  // Poll every 2 s while waiting; a failed poll is retried, not shown.
  useEffect(() => {
    if (phase !== "waiting") return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      api.codexLoginState().then(
        (s) => {
          if (!alive) return;
          if (s.state === "done") onConnected();
          else if (s.state === "failed") {
            setError(s.error ?? "Sign-in did not finish. Try again.");
            setPhase("failed");
          } else timer = setTimeout(tick, 2000);
        },
        () => {
          if (alive) timer = setTimeout(tick, 2000);
        },
      );
    };
    timer = setTimeout(tick, 2000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [phase, onConnected]);

  const copy = () => {
    if (!login) return;
    void navigator.clipboard?.writeText(login.code);
    announce("Code copied");
  };

  if (phase === "waiting" && login) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-secondary">Open the page, sign in with your ChatGPT account and enter this code.</p>
        <div className="flex flex-wrap items-center gap-3">
          <span className="mono rounded-md bg-surface-sunken px-3 py-2 text-2xl tracking-widest text-text-primary">{login.code}</span>
          <Button variant="secondary" size="sm" onClick={copy}>
            <Copy size={14} aria-hidden="true" />
            Copy
          </Button>
        </div>
        {/^https:\/\//i.test(login.url) ? (
          <a className="text-sm font-medium text-accent underline underline-offset-2" href={login.url} target="_blank" rel="noopener noreferrer">
            Open sign-in page
          </a>
        ) : null}
        <p className="text-xs text-text-muted">Waiting for you to finish in your browser.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {error ? <p className="text-sm text-status-danger">{error}</p> : null}
      <div>
        <Button variant="secondary" size="sm" disabled={phase === "starting"} onClick={start}>
          {phase === "starting" ? "Starting…" : "Sign in to Codex"}
        </Button>
      </div>
    </div>
  );
}

/** Agents: which AI helpers are set up on this computer, read from the server's own check. */
function AgentsPane({ owner }: { owner: boolean }) {
  // `status` is null until the first check answers; `claudeSignedIn` and `codexSignedIn` are null when the server could not tell.
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [justConnected, setJustConnected] = useState(false);

  const check = useCallback(() => {
    setChecking(true);
    setFailed(false);
    api
      .agentsStatus()
      .then((s) => setStatus(s))
      .catch(() => setFailed(true))
      .finally(() => setChecking(false));
  }, []);
  useEffect(check, [check]);

  const connected = useCallback(() => {
    setJustConnected(true);
    check();
  }, [check]);

  const claudeInstalled = status?.claude === true;
  const notSignedIn = claudeInstalled && status?.claudeSignedIn === false;
  const codexNeedsSignIn = status?.codex === true && status.codexSignedIn !== true;

  // Claude stays first; of the rest, installed ones come before the ones not set up.
  const rows = AGENT_KEYS.map((key) => ({ key, name: agentName(key), installed: status?.[key] === true })).filter(
    (r) => ALWAYS_LISTED.has(r.key) || r.installed,
  );
  const ordered = [rows[0], ...rows.slice(1).filter((r) => r.installed), ...rows.slice(1).filter((r) => !r.installed)];

  const chipFor = (row: { key: string; installed: boolean }) => {
    if (status === null) return <Chip>Checking</Chip>;
    if (row.key === "claude") {
      if (!row.installed) {
        return (
          <Chip>Not set up</Chip>
        );
      }
      if (notSignedIn) {
        return (
          <Chip>Not signed in</Chip>
        );
      }
      return (
        <span className={cn("chip", "chip-running")}>
          <span className="chip-dot" aria-hidden="true" />
          Ready
        </span>
      );
    }
    if (row.key === "codex" && row.installed) {
      if (status?.codexSignedIn === true) return <Chip>Signed in</Chip>;
      if (status?.codexSignedIn === false) {
        return (
          <Chip>Not signed in</Chip>
        );
      }
    }
    return row.installed ? (
      <span className={cn("chip", "chip-running")}>
        <span className="chip-dot" aria-hidden="true" />
        Installed
      </span>
    ) : (
      <Chip>Not installed</Chip>
    );
  };

  return (
    <Panel>
      <div className="flex flex-col gap-4 p-4">
        <ul className="flex flex-col gap-1">
          {ordered.map((row) => (
            <li key={row.key} className="flex min-h-11 items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 text-sm text-text-primary">
              <span>{row.name}</span>
              {chipFor(row)}
            </li>
          ))}
        </ul>
        <p className="text-sm leading-relaxed text-text-secondary">
          {failed ? (
            "Could not check the agents right now. Try again in a moment."
          ) : status === null ? (
            "Checking which agents are set up on this computer."
          ) : !claudeInstalled ? (
            "Claude is not set up on this computer yet. Ask whoever installed Kohlab to set it up, then check again."
          ) : notSignedIn ? (
            <>
              Claude is installed but not signed in. On the server, run <code className="mono rounded bg-surface-sunken px-1 py-0.5">claude</code> once
              and sign in with your Claude account, then check again.
            </>
          ) : (
            "Pick which AI to use when you start a project."
          )}
        </p>
        {codexNeedsSignIn ? (
          owner ? (
            <CodexSignIn onConnected={connected} />
          ) : (
            <p className="text-sm text-text-secondary">Ask the owner to sign in to Codex.</p>
          )
        ) : null}
        {justConnected && status?.codexSignedIn === true ? <p className="text-sm text-text-secondary">Codex is connected.</p> : null}
        <div>
          <Button variant="secondary" size="sm" disabled={checking} onClick={check}>
            {checking ? "Checking…" : "Check again"}
          </Button>
        </div>
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
    agents: <AgentsPane owner={can.own} />,
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
