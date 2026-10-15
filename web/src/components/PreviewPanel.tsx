import { useEffect, useRef, useState, type PointerEvent } from "react";
import { ArrowClockwise, ArrowSquareOut, CaretLeft, DotsThree, Globe, LinkSimple, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../api";
import { copyText } from "../lib/clipboard";
import { useApp } from "../store";
import { cn } from "../lib/utils";
import ConfirmDialog from "./ConfirmDialog";
import { Button, Menu, MenuItem } from "./ui";

interface Props {
  url: string;
  /** Cache-busting stamp: a new value reloads the frame. */
  t: number;
  /** "pane" sits beside the chat on desktop; "sheet" covers the whole phone screen. */
  variant: "pane" | "sheet";
  onReload: () => void;
  onClose: () => void;
  /** Told the new link after "Make a new link", so the parent can keep it. */
  onNewLink?: (url: string) => void;
}

/** A downward drag from the sheet's top bar this far closes it. */
const SWIPE_CLOSE_PX = 80;

/**
 * The live preview of the project. The frame is sandboxed without allow-same-origin,
 * so the project's pages cannot reach the app. Keep the sandbox list as it is.
 */
export default function PreviewPanel({ url, t, variant, onReload, onClose, onNewLink }: Props) {
  const sheet = variant === "sheet";
  // The project this preview belongs to: the panel only ever opens inside a workspace.
  const workspaceId = useApp((s) => (s.route.kind === "workspace" ? s.route.id : null));
  // The link on screen. "Make a new link" changes it here too, so the frame reloads even before the parent catches up.
  const [shownUrl, setShownUrl] = useState(url);
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
    const onKey = (e: KeyboardEvent) => {
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

  if (!sheet) {
    return (
      <>
        <div role="toolbar" aria-label="Preview actions" className="flex items-center gap-2 px-2 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-surface-sunken px-3 py-1.5 text-xs text-text-muted">
            <Globe size={14} className="shrink-0" aria-hidden="true" />
            <span className="truncate">Preview</span>
          </div>
          <Button variant="quiet" size="sm" iconOnly aria-label="Reload preview" title="Reload" className="size-8" onClick={onReload}>
            <ArrowClockwise size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="quiet"
            size="sm"
            iconOnly
            aria-label="Open the preview in a new tab"
            title="Open in a new tab"
            className="size-8"
            onClick={() => window.open(location.origin + shownUrl, "_blank", "noopener")}
          >
            <ArrowSquareOut size={16} aria-hidden="true" />
          </Button>
          <Button variant="quiet" size="sm" iconOnly aria-label="Copy link" title="Copy link" className="size-8" onClick={() => void copyLink()}>
            <LinkSimple size={16} aria-hidden="true" />
          </Button>
          {workspaceId ? (
            <Menu label="More preview actions" trigger={<Button variant="quiet" size="sm" iconOnly className="size-8"><DotsThree size={16} weight="bold" aria-hidden="true" /></Button>}>
              <MenuItem onSelect={() => setConfirmNew(true)}>
                <LinkSimple size={16} aria-hidden="true" />
                Make a new link
              </MenuItem>
            </Menu>
          ) : null}
          <Button variant="quiet" size="sm" iconOnly aria-label="Close preview" title="Close preview" className="size-8" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col bg-surface-sunken p-2">
          <div className="min-h-0 flex-1 overflow-hidden rounded-card bg-white">
            <iframe
              src={`${shownUrl}?t=${t}`}
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
              title="Preview of your project"
              className="block size-full border-0 bg-white"
            />
          </div>
        </div>
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
          <h2 className="min-w-0 flex-1 truncate px-1 text-base font-semibold text-text-primary">Preview</h2>
          <Button variant="quiet" iconOnly aria-label="Reload preview" title="Reload" className="size-11 shrink-0" onClick={onReload}>
            <ArrowClockwise size={20} aria-hidden="true" />
          </Button>
          <Button
            variant="quiet"
            iconOnly
            aria-label="Open the preview in a new tab"
            title="Open in a new tab"
            className="size-11 shrink-0"
            onClick={() => window.open(location.origin + shownUrl, "_blank", "noopener")}
          >
            <ArrowSquareOut size={20} aria-hidden="true" />
          </Button>
          <Button variant="quiet" iconOnly aria-label="Copy link" title="Copy link" className="size-11 shrink-0" onClick={() => void copyLink()}>
            <LinkSimple size={20} aria-hidden="true" />
          </Button>
          {workspaceId ? (
            <Menu label="More preview actions" trigger={<Button variant="quiet" iconOnly className="size-11 shrink-0"><DotsThree size={20} weight="bold" aria-hidden="true" /></Button>}>
              <MenuItem onSelect={() => setConfirmNew(true)}>
                <LinkSimple size={16} aria-hidden="true" />
                Make a new link
              </MenuItem>
            </Menu>
          ) : null}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col bg-surface-sunken">
        <iframe
          src={`${shownUrl}?t=${t}`}
          sandbox="allow-scripts allow-forms allow-popups allow-modals"
          title="Preview of your project"
          className="block min-h-0 flex-1 border-0 bg-white"
        />
      </div>
      {newLinkConfirm}
    </div>
  );
}
