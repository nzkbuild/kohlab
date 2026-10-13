import { useEffect } from "react";
import { ArrowClockwise, ArrowLeft, ArrowSquareOut, Globe, X } from "@phosphor-icons/react";
import { Button } from "./ui";

interface Props {
  url: string;
  /** Cache-busting stamp: a new value reloads the frame. */
  t: number;
  /** "pane" sits beside the chat on desktop; "sheet" covers the whole phone screen. */
  variant: "pane" | "sheet";
  onReload: () => void;
  onClose: () => void;
}

/**
 * The live preview of the project. The frame is sandboxed without allow-same-origin,
 * so the project's pages cannot reach the app. Keep the sandbox list as it is.
 */
export default function PreviewPanel({ url, t, variant, onReload, onClose }: Props) {
  const sheet = variant === "sheet";

  // Escape backs out of the phone sheet, as a dialog would.
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, onClose]);

  const iconSize = sheet ? "size-11" : "size-8";

  return (
    <>
      <div role="toolbar" aria-label="Preview actions" className="flex items-center gap-2 border-b border-line-subtle px-2 py-2">
        {sheet ? (
          <Button variant="quiet" className="min-h-11 px-2" onClick={onClose}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back
          </Button>
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-surface-sunken px-3 py-1.5 text-xs text-text-muted">
          <Globe size={14} className="shrink-0" aria-hidden="true" />
          <span className="truncate">Preview</span>
        </div>
        <Button variant="quiet" size="sm" iconOnly aria-label="Reload preview" title="Reload" className={iconSize} onClick={onReload}>
          <ArrowClockwise size={16} aria-hidden="true" />
        </Button>
        {sheet ? null : (
          <Button
            variant="quiet"
            size="sm"
            iconOnly
            aria-label="Open the preview in a new tab"
            title="Open in a new tab"
            className={iconSize}
            onClick={() => window.open(location.origin + url, "_blank", "noopener")}
          >
            <ArrowSquareOut size={16} aria-hidden="true" />
          </Button>
        )}
        {sheet ? null : (
          <Button variant="quiet" size="sm" iconOnly aria-label="Close preview" title="Close preview" className={iconSize} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col bg-surface-sunken p-2">
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-line-subtle bg-white">
          <iframe
            src={`${url}?t=${t}`}
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            title="Preview of your project"
            className="block size-full border-0 bg-white"
          />
        </div>
      </div>
    </>
  );
}
