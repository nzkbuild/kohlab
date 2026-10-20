import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowClockwise, ArrowLeft, ArrowRight, ArrowSquareOut, CaretLeft, DotsThree, Globe, LinkSimple, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../api";
import { copyText } from "../lib/clipboard";
import { useApp, useCan } from "../store";
import { cn } from "../lib/utils";
import BrowserView from "./BrowserView";
import ConfirmDialog from "./ConfirmDialog";
import { Button, Menu, MenuItem, MenuSeparator } from "./ui";

interface Props {
  /** The project's own static page. Its shareable link is copied, made new and opened from the menu. */
  url: string;
  /** No longer used: the live browser does not reload from it. Kept so WorkspaceDetail needs no change. */
  t: number;
  /** "pane" sits beside the chat on desktop; "sheet" covers the whole phone screen. */
  variant: "pane" | "sheet";
  /** No longer used: Reload asks the shared browser to reload. Kept so WorkspaceDetail needs no change. */
  onReload: () => void;
  onClose: () => void;
  /** Told the new link after "Make a new link", so the parent can keep it. */
  onNewLink?: (url: string) => void;
}

/** A downward drag from the sheet's top bar this far closes it. */
const SWIPE_CLOSE_PX = 80;

const ACTION_WORDS = { back: "go back", forward: "go forward", reload: "reload the page", open: "open that address", home: "open the project page" } as const;

/**
 * The shared browser for this project, live, with an address bar. The menu keeps
 * the project's own static page: its link, a new link, and a way back to it.
 */
export default function PreviewPanel({ url, variant, onClose, onNewLink }: Props) {
  const sheet = variant === "sheet";
  // The project this preview belongs to: the panel only ever opens inside a workspace.
  const workspaceId = useApp((s) => (s.route.kind === "workspace" ? s.route.id : null));
  const can = useCan();
  // The link on screen. "Make a new link" changes it here too, so the menu uses the new one even before the parent catches up.
  const [shownUrl, setShownUrl] = useState(url);
  // The address the shared browser is on, from BrowserView and from the nav actions.
  const [browserUrl, setBrowserUrl] = useState("");
  // What the address field holds while it is being typed in. Null means "show the browser's address".
  const [draft, setDraft] = useState<string | null>(null);
  // Why the typed address was not opened, shown under the field.
  const [addressError, setAddressError] = useState("");
  const [confirmNew, setConfirmNew] = useState(false);
  const [making, setMaking] = useState(false);
  // The sheet slides up from the bottom on mount. Reduced motion skips the transition (see classes).
  const [entered, setEntered] = useState(false);
  const [dragY, setDragY] = useState(0);
  const drag = useRef<{ y: number; dy: number; id: number; captured: boolean } | null>(null);

  useEffect(() => setShownUrl(url), [url]);

  // Escape backs out of the phone sheet, as a dialog would. Not while the confirm asks: that Escape is the dialog's.
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !confirmNew) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, onClose, confirmNew]);

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

  const copyLink = async () => {
    try {
      await copyText(location.origin + shownUrl);
      toast.success("Link copied. Anyone who can reach this Kohlab can open it.");
    } catch (e) {
      toast.error(`Could not copy the link, ${(e as Error).message}`);
    }
  };

  const makeNew = async () => {
    if (!workspaceId) return;
    setMaking(true);
    try {
      const { url: next } = await api.preview(workspaceId, true);
      setShownUrl(next);
      onNewLink?.(next);
      setConfirmNew(false);
      toast.success("New link made. The old link no longer works.");
    } catch (e) {
      toast.error(`Could not make a new link, ${(e as Error).message}`);
    } finally {
      setMaking(false);
    }
  };

  /** One browser action (back, forward, reload, or open an address). The server answers with the address it is on now. */
  const browserAct = async (action: keyof typeof ACTION_WORDS, target?: string) => {
    if (!workspaceId) return;
    try {
      const { url: next } = await api.browserAct(workspaceId, action, target);
      setBrowserUrl(next);
    } catch (e) {
      toast.error(`Could not ${ACTION_WORDS[action]}, ${(e as Error).message}`);
    }
  };

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

  const newLinkConfirm = (
    <ConfirmDialog
      open={confirmNew}
      onOpenChange={(v) => {
        if (!v) setConfirmNew(false);
      }}
      title="Make a new link?"
      description="The old link will stop working for anyone you sent it to."
      confirmLabel="Make a new link"
      busy={making}
      onConfirm={() => void makeNew()}
    />
  );

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
      value={draft ?? browserUrl}
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
      <MenuItem onSelect={() => window.open(location.origin + shownUrl, "_blank", "noopener")}>
        <ArrowSquareOut size={16} aria-hidden="true" />
        Open in a new tab
      </MenuItem>
      <MenuItem onSelect={() => void copyLink()}>
        <LinkSimple size={16} aria-hidden="true" />
        Copy link
      </MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={() => setConfirmNew(true)}>
        <LinkSimple size={16} aria-hidden="true" />
        Make a new link
      </MenuItem>
    </Menu>
  ) : null;

  const view = workspaceId ? <BrowserView workspaceId={workspaceId} onUrl={setBrowserUrl} /> : null;
  const addressNote = addressError ? (
    <p role="alert" className="px-4 pb-1 text-sm text-status-danger">
      {addressError}
    </p>
  ) : null;

  if (!sheet) {
    return (
      <>
        <div role="toolbar" aria-label="Preview actions" className="flex h-14 shrink-0 items-center gap-1 px-2">
          {navButtons}
          {address}
          {menu}
          <Button variant="quiet" iconOnly aria-label="Close preview" title="Close preview" className="size-10 shrink-0" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
        {addressNote}
        <div className="flex min-h-0 flex-1 flex-col">{view}</div>
        {newLinkConfirm}
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
          {menu}
        </div>
      </div>
      <div className="shrink-0 px-2 pb-2">
        <div className="flex">{address}</div>
        {addressNote}
      </div>
      <div className="flex min-h-0 flex-1 flex-col bg-surface-sunken p-2">{view}</div>
      {newLinkConfirm}
    </div>
  );
}
