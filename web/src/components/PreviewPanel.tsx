import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { toChat } from "../lib/toChat";
import { ArrowClockwise, ArrowLeft, ArrowRight, ArrowSquareOut, Camera, CaretLeft, ChatCircle, Desktop, DeviceMobile, DeviceTablet, DotsThree, Globe, HandPointing, ShareNetwork, WarningCircle, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../api";
import { agentName } from "../lib/agentName";
import { sinceWhen } from "../lib/format";
import { askToFix, useProblems } from "../lib/problems";
import { problemSummary } from "../lib/problemText";
import type { Point } from "../lib/browserCoords";
import { findWorkspace, useApp, useCan } from "../store";
import { cn } from "../lib/utils";
import BrowserView, { type BrowserHandle } from "./BrowserView";
import ConfirmDialog from "./ConfirmDialog";
import MarkupDialog from "./MarkupDialog";
import ShareDialog from "./ShareDialog";
import { Button, Menu, MenuItem, MenuLabel, MenuSeparator } from "./ui";

interface Props {
  /** The project's own static page. Its address is used for "Open in a new tab". */
  url: string;
  /** Changes when the pane opens and when a turn ends: each change reloads the browser, if it is on the project's own page. */
  t: number;
  /** "pane" sits beside the chat on desktop; "sheet" covers the whole phone screen. */
  variant: "pane" | "sheet";
  /** No longer used: Reload asks the shared browser to reload. Kept so WorkspaceDetail needs no change. */
  onReload: () => void;
  onClose: () => void;
  /** Told the new address after a share link is turned off, so the parent can keep it. */
  onNewLink?: (url: string) => void;
  /** An earlier version to open in the shared browser (from Changes, Look). A new object opens it again. */
  version?: { sha: string } | null;
  /** Goes to the project's chat, where a problem sent to the AI shows up. */
  onShowChat?: () => void;
}

/** A downward drag from the sheet's top bar this far closes it. */
const SWIPE_CLOSE_PX = 80;

const ACTION_WORDS = { back: "go back", forward: "go forward", reload: "reload the page", open: "open that address", home: "open the project page", version: "open that version" } as const;

/** The address of an earlier version: its commit id is the only part that changes. */
const VERSION_PATH = /^\/p\/[^/]+\/v\/([0-9a-f]{40})\//;

/** The pane's device sizes. Desktop follows the pane's own width. Sizes are CSS pixels; the frame is scaled to fit. */
type DeviceId = "phone" | "tablet" | "desktop";
const DEVICES: Record<DeviceId, { label: string; Icon: typeof Desktop; size: { width: number; height: number } | null }> = {
  phone: { label: "Phone", Icon: DeviceMobile, size: { width: 390, height: 844 } },
  tablet: { label: "Tablet", Icon: DeviceTablet, size: { width: 820, height: 1180 } },
  desktop: { label: "Desktop", Icon: Desktop, size: null },
};
const deviceKey = (id: string) => `kohlab.previewDevice.${id}`;
// localStorage can throw (private mode): the choice is then just not remembered.
function readDevice(id: string | null): DeviceId {
  try {
    const v = id ? localStorage.getItem(deviceKey(id)) : null;
    return v === "phone" || v === "tablet" ? v : "desktop";
  } catch {
    return "desktop";
  }
}
function writeDevice(id: string, device: DeviceId) {
  try {
    localStorage.setItem(deviceKey(id), device);
  } catch {
    /* not remembered */
  }
}

/**
 * The shared browser for this project, live, with an address bar. The menu holds
 * the project's page, a share link and a picture of the page. Problems, pointing
 * and earlier versions have their own controls in the bar.
 */
export default function PreviewPanel({ url, t, variant, onClose, onNewLink, version, onShowChat }: Props) {
  const sheet = variant === "sheet";
  // The project this preview belongs to: the panel only ever opens inside a workspace.
  const workspaceId = useApp((s) => (s.route.kind === "workspace" ? s.route.id : null));
  const agent = useApp((s) => (s.route.kind === "workspace" ? findWorkspace(s.workspaces, s.route.id)?.agent : undefined));
  const refresh = useApp((s) => s.refresh);
  const who = agentName(agent ?? "claude");
  const can = useCan();
  // The address the shared browser is on, from BrowserView and from the nav actions.
  const [browserUrl, setBrowserUrl] = useState("");
  // What the address field holds while it is being typed in. Null means "show the browser's address".
  const [draft, setDraft] = useState<string | null>(null);
  // Why the typed address was not opened, shown under the field.
  const [addressError, setAddressError] = useState("");
  const [pointing, setPointing] = useState(false);
  // The box a point picked, outlined on the page for a moment. A new object outlines again.
  const [outline, setOutline] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  // The picture being marked up (Add picture). Null when the dialog is closed.
  const [picture, setPicture] = useState<Blob | null>(null);
  const shot = useRef<BrowserHandle>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  /** How many files hold changes that were not kept: going back throws them away, so the dialog says so. */
  const [unkept, setUnkept] = useState(0);
  const [restoring, setRestoring] = useState(false);
  const [sendingFix, setSendingFix] = useState(false);
  // The sheet slides up from the bottom on mount. Reduced motion skips the transition (see classes).
  const [entered, setEntered] = useState(false);
  const [dragY, setDragY] = useState(0);
  const drag = useRef<{ y: number; dy: number; id: number; captured: boolean } | null>(null);
  // The device the pane shows the page at. Remembered per project; the pane is keyed by project, so it is read once.
  const [device, setDevice] = useState<DeviceId>(() => readDevice(workspaceId));
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  // Problems with the page or the app. Read while the preview is open, and only a person who can change the project is told.
  const { problems, refresh: refreshProblems } = useProblems(workspaceId ?? "", !!workspaceId && can.mutate);

  // The project's own static address, as a path: "/p/<token>/". The browser on that path is "Your page".
  const ownPath = useMemo(() => {
    try {
      return new URL(url, location.origin).pathname;
    } catch {
      return "";
    }
  }, [url]);
  const isOwnPage = (address: string) => {
    if (!address) return false;
    try {
      const u = new URL(address);
      // an address on this machine (the project's own dev server) is the person's page too
      if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return true;
      return !!ownPath && u.pathname.startsWith(ownPath);
    } catch {
      return false;
    }
  };

  // The framed device is measured so it can be scaled to fit the pane.
  const framed = sheet ? null : DEVICES[device].size;
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fit = framed && stage.w > 0 ? Math.min(1, (stage.w - 32) / framed.width, (stage.h - 32) / framed.height) : 1;
  const scale = Math.max(0.1, fit);

  const chooseDevice = (next: DeviceId) => {
    setDevice(next);
    if (workspaceId) writeDevice(workspaceId, next);
  };

  // Escape backs out of the phone sheet, as a dialog would. Not while a dialog is open: that Escape is the dialog's.
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !shareOpen && !restoreOpen && !picture) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, onClose, shareOpen, restoreOpen, picture]);

  useEffect(() => {
    if (!sheet) return;
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [sheet]);

  // Swipe down from the top bar to close. Capture starts only once the pointer has
  // moved, so a plain tap on Back or Reload still reaches its click handler.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { y: e.clientY, dy: 0, id: e.pointerId, captured: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.dy = Math.max(0, e.clientY - d.y);
    if (d.dy > 8 && !d.captured) {
      d.captured = true;
      e.currentTarget.setPointerCapture(d.id);
    }
    setDragY(d.dy);
  };
  const endDrag = (close: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (close && d.dy > SWIPE_CLOSE_PX) onClose();
    else setDragY(0);
  };

  /** One browser action (back, forward, reload, or open an address). The server answers with the address it is on now. */
  const browserAct = async (action: keyof typeof ACTION_WORDS, target?: string) => {
    if (!workspaceId) return;
    try {
      const { url: next } = await api.browserAct(workspaceId, action, target);
      setBrowserUrl(next);
    } catch (e) {
      toast.error(`Couldn't ${ACTION_WORDS[action]}. ${(e as Error).message}`);
    }
  };

  // The shared browser may already be on the project's page from before: reload it once per open (the pane is mounted
  // on open) and once per finished turn (t changes). Another site the person went to is left alone.
  useEffect(() => {
    if (!workspaceId || !can.mutate) return;
    let alive = true;
    void (async () => {
      try {
        const { url: here } = await api.browser(workspaceId);
        if (!alive || !here || !isOwnPage(here)) return;
        const { url: next } = await api.browserAct(workspaceId, "reload");
        if (alive) setBrowserUrl(next);
      } catch {
        /* a page that did not reload stays as it was */
      }
    })();
    return () => {
      alive = false;
    };
  }, [t, workspaceId]);

  // An earlier version opens in the same browser. The browser is started first, since it may not be running yet.
  useEffect(() => {
    if (!version || !workspaceId) return;
    let alive = true;
    void (async () => {
      try {
        await api.browser(workspaceId);
        const { url: next } = await api.browserAct(workspaceId, "version", version.sha);
        if (alive) setBrowserUrl(next);
      } catch (e) {
        if (alive) toast.error(`Couldn't open that version. ${(e as Error).message}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [version, workspaceId]);

  // Which earlier version the browser shows, if any, and when it was kept.
  const versionSha = useMemo(() => {
    try {
      return VERSION_PATH.exec(new URL(browserUrl, location.origin).pathname)?.[1] ?? null;
    } catch {
      return null;
    }
  }, [browserUrl]);
  const [looking, setLooking] = useState<{ sha: string; at: number | null } | null>(null);
  useEffect(() => {
    if (!versionSha || !workspaceId) return;
    let alive = true;
    api
      .versions(workspaceId)
      .then((list) => {
        if (alive) setLooking({ sha: versionSha, at: list.find((v) => v.id === versionSha)?.at ?? null });
      })
      .catch(() => {
        if (alive) setLooking({ sha: versionSha, at: null });
      });
    return () => {
      alive = false;
    };
  }, [versionSha, workspaceId]);
  const lookingAt = versionSha && looking?.sha === versionSha ? looking.at : null;

  /** A bare name such as "example.com" is taken as a secure address. A "/path" is on the page the browser is on. */
  const goToAddress = (typed: string) => {
    const text = typed.trim();
    if (!text) return;
    setAddressError("");
    if (text.startsWith("/")) {
      let target: string | null = null;
      try {
        target = new URL(text, browserUrl).href;
      } catch {
        /* no page to take the path from */
      }
      if (target) void browserAct("open", target);
      else setAddressError("Type a full address, such as https://example.com.");
      return;
    }
    const isAddress = /^[a-z][a-z0-9+.-]*:/i.test(text);
    void browserAct("open", isAddress ? text : `https://${text}`);
  };

  const onAddressKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const typed = draft ?? browserUrl;
      setDraft(null);
      e.currentTarget.blur();
      goToAddress(typed);
    } else if (e.key === "Escape") {
      // Escape puts the old address back, and stops the sheet closing as well.
      e.stopPropagation();
      setDraft(null);
      e.currentTarget.blur();
    }
  };

  /** A point picked on the page: its box is outlined, and the chat's composer gets a chip for it. */
  const onPoint = async (spot: Point) => {
    if (!workspaceId) return;
    setPointing(false);
    try {
      const { pick } = await api.pick(workspaceId, spot.x, spot.y);
      setOutline({ x: pick.box.x, y: pick.box.y, width: pick.box.width, height: pick.box.height });
      toChat("kohlab:point", { id: workspaceId, pick });
    } catch (e) {
      toast.error(`Couldn't point at that. ${(e as Error).message}`);
    }
  };

  /** Takes a picture of the page as it is now, and opens the dialog to mark it up. */
  const addPicture = async () => {
    const blob = (await shot.current?.snapshot()) ?? null;
    if (!blob) {
      toast.error("There's no picture of the page yet. Wait for the page to show, then try again.");
      return;
    }
    setPicture(blob);
  };

  /** Sends the problems to the AI, then goes to the chat, where the message shows. */
  const fixWithAi = async () => {
    if (!workspaceId || sendingFix) return;
    setSendingFix(true);
    try {
      await askToFix(workspaceId, problems);
      refreshProblems();
      if (sheet) onClose();
      onShowChat?.();
    } catch (e) {
      toast.error(`Couldn't send that to ${who}. ${(e as Error).message}`);
    } finally {
      setSendingFix(false);
    }
  };

  const askGoBack = () => {
    if (!workspaceId) return;
    setUnkept(0);
    setRestoreOpen(true);
    api
      .diff(workspaceId)
      .then((files) => setUnkept(files.length))
      .catch(() => {});
  };

  /** Puts the version the browser shows back as the project's current version, then opens the project page. */
  const goBackToVersion = async () => {
    if (!workspaceId || !versionSha) return;
    setRestoring(true);
    try {
      await api.restoreVersion(workspaceId, versionSha);
      await refresh();
      setRestoreOpen(false);
      toast.success("Went back");
      await browserAct("home");
    } catch (e) {
      toast.error(`Couldn't go back. ${(e as Error).message}`);
    } finally {
      setRestoring(false);
    }
  };

  // Viewers see the browser but cannot drive it: the nav and the address are read-only for them.
  const navDisabled = !can.mutate;
  const fieldHeight = sheet ? "h-11" : "h-10";
  // The sheet's root is raised, so its pill sits one step down from the pane's sunken one.
  const fieldFill = sheet ? "bg-surface-base" : "bg-surface-sunken";
  const navSize = sheet ? "size-11 shrink-0" : "size-10 shrink-0";

  const navButtons = (
    <>
      <Button variant="quiet" iconOnly aria-label="Back" title="Back" className={navSize} disabled={navDisabled} onClick={() => void browserAct("back")}>
        <ArrowLeft size={20} aria-hidden="true" />
      </Button>
      <Button variant="quiet" iconOnly aria-label="Forward" title="Forward" className={navSize} disabled={navDisabled} onClick={() => void browserAct("forward")}>
        <ArrowRight size={20} aria-hidden="true" />
      </Button>
      <Button variant="quiet" iconOnly aria-label="Reload" title="Reload" className={navSize} disabled={navDisabled} onClick={() => void browserAct("reload")}>
        <ArrowClockwise size={20} aria-hidden="true" />
      </Button>
    </>
  );

  const address = (
    <input
      type="text"
      inputMode="url"
      aria-label="Address"
      placeholder="Type an address"
      // The project's own page reads "Your page"; editing it shows the real address.
      value={draft ?? (isOwnPage(browserUrl) ? "Your page" : browserUrl)}
      readOnly={navDisabled}
      spellCheck={false}
      autoCapitalize="none"
      autoCorrect="off"
      onFocus={(e) => {
        setDraft(browserUrl);
        e.currentTarget.select();
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        setAddressError("");
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={onAddressKey}
      className={cn(
        "min-w-0 flex-1 truncate rounded-full border-0 px-4 text-base text-text-primary placeholder:text-text-muted",
        fieldHeight,
        fieldFill,
      )}
    />
  );

  const problemMenu =
    workspaceId && can.mutate && problems.length > 0 ? (
      <Menu
        label="Problem with the page"
        trigger={
          <Button variant="quiet" className={cn("shrink-0 gap-2 px-2.5 text-text-secondary", sheet ? "h-11" : "h-10")}>
            <WarningCircle size={16} aria-hidden="true" />
            Problem
          </Button>
        }
      >
        <MenuLabel>{problemSummary(problems)}</MenuLabel>
        <MenuItem disabled={sendingFix} onSelect={() => void fixWithAi()}>
          <ChatCircle size={16} aria-hidden="true" />
          {`Ask ${who} to fix it`}
        </MenuItem>
      </Menu>
    ) : null;

  const pointButton = can.mutate ? (
    <Button
      variant="quiet"
      iconOnly
      aria-label="Point at something"
      aria-pressed={pointing}
      title="Point at something on the page"
      className={navSize}
      onClick={() => setPointing((on) => !on)}
    >
      <HandPointing size={20} aria-hidden="true" />
    </Button>
  ) : null;

  const menu = workspaceId ? (
    <Menu
      label="More preview actions"
      trigger={
        <Button variant="quiet" iconOnly className={navSize}>
          <DotsThree size={20} weight="bold" aria-hidden="true" />
        </Button>
      }
    >
      <MenuItem disabled={navDisabled} onSelect={() => void browserAct("home")}>
        <Globe size={16} aria-hidden="true" />
        Open project page
      </MenuItem>
      <MenuItem onSelect={() => window.open(location.origin + url, "_blank", "noopener")}>
        <ArrowSquareOut size={16} aria-hidden="true" />
        Open in a new tab
      </MenuItem>
      {can.mutate ? (
        <>
          <MenuSeparator />
          <MenuItem onSelect={() => setShareOpen(true)}>
            <ShareNetwork size={16} aria-hidden="true" />
            Share a link…
          </MenuItem>
          <MenuItem onSelect={() => void addPicture()}>
            <Camera size={16} aria-hidden="true" />
            Add picture
          </MenuItem>
        </>
      ) : null}
    </Menu>
  ) : null;

  const view = workspaceId ? (
    <BrowserView
      ref={shot}
      workspaceId={workspaceId}
      onUrl={setBrowserUrl}
      viewport={framed}
      pointing={pointing}
      onPoint={(spot) => void onPoint(spot)}
      outline={outline}
    />
  ) : null;

  // The device switch: the shared browser's viewport follows it (Desktop follows the pane). Pane only, not the phone sheet.
  const deviceSwitch = sheet ? null : (
    <div role="group" aria-label="Preview size" className="@container flex shrink-0 justify-center px-2 pb-2">
      <div className="inline-flex gap-0.5 rounded-full bg-surface-sunken p-0.5">
        {(Object.keys(DEVICES) as DeviceId[]).map((id) => {
          const { label, Icon } = DEVICES[id];
          return (
            <button
              key={id}
              type="button"
              aria-label={label}
              aria-pressed={device === id}
              title={label}
              onClick={() => chooseDevice(id)}
              className="inline-flex min-h-(--control-h-sm) items-center gap-2 rounded-full px-3 text-sm text-text-secondary hover:text-text-primary aria-pressed:bg-surface-active aria-pressed:text-text-primary pointer-coarse:min-h-11"
            >
              <Icon size={16} aria-hidden="true" />
              <span className="hidden @min-[28rem]:inline">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
  const addressNote = addressError ? (
    <p role="alert" className="px-4 pb-1 text-sm text-status-danger">
      {addressError}
    </p>
  ) : null;
  const pointingNote = pointing ? (
    <p role="status" className="px-4 pb-1 text-sm text-text-muted">
      Tap or click the thing you mean.
    </p>
  ) : null;
  // Under the bar when the browser shows an earlier version: it is only looked at until the person goes back to it.
  const versionRow = versionSha ? (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-2 text-sm text-text-secondary">
      <span className="mr-auto">{lookingAt ? `You're looking at the version from ${sinceWhen(lookingAt)}.` : "You're looking at an earlier version."}</span>
      {can.mutate ? (
        <>
          <Button variant="secondary" size="sm" disabled={restoring} onClick={askGoBack}>
            Go back to this one
          </Button>
          <Button variant="quiet" size="sm" className="text-text-secondary" onClick={() => void browserAct("home")}>
            Back to now
          </Button>
        </>
      ) : null}
    </div>
  ) : null;

  const dialogs = (
    <>
      <ShareDialog workspaceId={workspaceId} open={shareOpen} onOpenChange={setShareOpen} onPreviewUrl={(next) => onNewLink?.(next)} />
      <MarkupDialog workspaceId={workspaceId ?? ""} image={picture} onOpenChange={(open) => !open && setPicture(null)} />
      <ConfirmDialog
        open={restoreOpen}
        onOpenChange={(v) => {
          if (!v) setRestoreOpen(false);
        }}
        title="Go back to this version?"
        description={`Your project will look the way it did then. Nothing is lost: you can come back to the current version from Changes.${unkept > 0 ? " Changes you haven't kept will be thrown away." : ""}`}
        confirmLabel="Go back"
        tone={unkept > 0 ? "danger" : "commit"}
        busy={restoring}
        onConfirm={() => void goBackToVersion()}
      />
    </>
  );

  if (!sheet) {
    return (
      <>
        <div role="toolbar" aria-label="Preview actions" className="flex h-14 shrink-0 items-center gap-1 px-2">
          {navButtons}
          {address}
          {problemMenu}
          {pointButton}
          {menu}
          <Button variant="quiet" iconOnly aria-label="Close preview" title="Close preview" className="size-10 shrink-0" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
        {addressNote}
        {versionRow}
        {pointingNote}
        {deviceSwitch}
        {/* The stage keeps the browser mounted when the size changes; only the frame around it moves and scales. */}
        <div ref={stageRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-surface-sunken">
          <div
            className={framed ? "absolute top-1/2 left-1/2 flex flex-col" : "flex min-h-0 flex-1 flex-col"}
            style={framed ? { width: framed.width, height: framed.height, transform: `translate(-50%, -50%) scale(${scale})` } : undefined}
          >
            {view}
          </div>
        </div>
        {dialogs}
      </>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Preview"
      className={cn(
        "fixed inset-0 z-(--z-overlay) flex flex-col bg-surface-raised motion-safe:transition-transform motion-safe:duration-[240ms] motion-safe:ease-out",
        entered ? "translate-y-0" : "translate-y-full",
      )}
      style={dragY > 0 ? { transform: `translateY(${dragY}px)`, transition: "none" } : undefined}
    >
      <div
        className="shrink-0 touch-none pt-[var(--safe-top,env(safe-area-inset-top))]"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => endDrag(true)}
        onPointerCancel={() => endDrag(false)}
      >
        <div role="toolbar" aria-label="Preview actions" className="flex h-13 items-center gap-1 px-2">
          <Button variant="quiet" iconOnly aria-label="Back to chat" title="Back to chat" className="size-11 shrink-0" onClick={onClose}>
            <CaretLeft size={20} aria-hidden="true" />
          </Button>
          {navButtons}
          <span className="flex-1" />
          {problemMenu}
          {pointButton}
          {menu}
        </div>
      </div>
      <div className="shrink-0 px-2 pb-2">
        <div className="flex">{address}</div>
        {addressNote}
      </div>
      {versionRow}
      {pointingNote}
      <div className="flex min-h-0 flex-1 flex-col bg-surface-sunken p-2">{view}</div>
      {dialogs}
    </div>
  );
}
