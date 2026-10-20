import { useLayoutEffect, type AriaAttributes, type ClipboardEvent, type DragEvent, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { BookmarkSimple, X } from "@phosphor-icons/react";
import { cn } from "../lib/utils";
import { isApple } from "../lib/platform";
import { relativeTime } from "../lib/format";
import { savedPreview, takeSaved, useSaved } from "../lib/drafts";
import { ComposerChip, Menu, MenuItem } from "./ui";

interface ComposerProps {
  id?: string;
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  readOnly?: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Runs first on every key. Calling preventDefault takes the key (a menu does). */
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Enter sends: not with Shift, not while composing, not on touch. Skipped when onKeyDown took the key. */
  onSubmit?: () => void;
  /** Ctrl/Cmd+S: save the text for later and clear the box. */
  onSaveLater?: () => void;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onFocus?: (e: FocusEvent<HTMLTextAreaElement>) => void;
  /** Files dropped on the box. */
  onDropFiles?: (files: FileList) => void;
  /** Combobox attributes for a menu the text opens (the "/" and "@" lists). */
  textareaAria?: AriaAttributes;
  /** Above the text, inside the box: attached files. */
  attachments?: ReactNode;
  /** Bottom row, left and right of a flexible gap. */
  leading?: ReactNode;
  trailing?: ReactNode;
  /** On phones the bottom row stays on one line (its chips shrink); the row still wraps elsewhere. */
  phoneOneRow?: boolean;
  className?: string;
}

/**
 * The one message box for chat and Home. Two rows: the text on top, a bottom
 * row of controls, its left edge on the text's. No border: the raised fill is the edge.
 */
export function Composer({
  id,
  ariaLabel,
  value,
  onChange,
  placeholder,
  disabled = false,
  readOnly = false,
  textareaRef,
  onKeyDown,
  onSubmit,
  onSaveLater,
  onPaste,
  onFocus,
  onDropFiles,
  textareaAria,
  attachments,
  leading,
  trailing,
  phoneOneRow = false,
  className,
}: ComposerProps) {
  // Grow with the text, up to about eight lines (five on a phone).
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lines = window.matchMedia("(max-width: 767.98px)").matches ? 5 : 8;
    const max = (parseFloat(getComputedStyle(el).lineHeight) || 24) * lines;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [value, textareaRef]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (onSaveLater && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      onSaveLater();
      return;
    }
    if (!onSubmit) return;
    // Touch keyboards have no Shift+Enter: Enter is a newline there, and the send button sends.
    const touch = window.matchMedia("(pointer: coarse)").matches;
    if (e.key === "Enter" && !touch && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div
      className={cn("flex flex-col gap-1 rounded-composer bg-surface-raised px-4 pt-2 pb-2", className)}
      onDragOver={(e: DragEvent<HTMLDivElement>) => {
        if (onDropFiles && e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e: DragEvent<HTMLDivElement>) => {
        if (!onDropFiles || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        onDropFiles(e.dataTransfer.files);
      }}
    >
      {attachments}
      <textarea
        {...textareaAria}
        id={id}
        ref={textareaRef}
        aria-label={ariaLabel}
        rows={1}
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        onFocus={onFocus}
        className="block min-h-9 w-full min-w-0 resize-none bg-transparent py-1.5 text-base leading-6 text-text-primary outline-none! placeholder:text-text-muted disabled:cursor-not-allowed"
      />
      {/* The chips' 10px inner padding is pulled into the margin, so a chip's glyph or label lines up with the text above. */}
      <div className={cn("-ml-2.5 flex min-w-0 items-center gap-1 flex-wrap", phoneOneRow && "max-md:flex-nowrap")}>
        {leading}
        <div className="min-w-2 flex-1" />
        {trailing}
      </div>
    </div>
  );
}

/** Saves the box's text for later. Shown only while there is text to save. */
export function SaveLaterChip({ onClick }: { onClick: () => void }) {
  const key = isApple ? "Cmd" : "Ctrl";
  return (
    <ComposerChip
      iconOnly
      className="max-md:hidden"
      aria-label="Save for later"
      title={`Save for later (${key}+S)`}
      icon={<BookmarkSimple size={14} aria-hidden="true" />}
      onClick={onClick}
    />
  );
}

/** "Saved (N)": the prompts saved for later, newest first. Choosing one puts it back in the box. Shown only when there are some. */
export function SavedChip({ onPick }: { onPick: (text: string) => void }) {
  const saved = useSaved();
  if (saved.length === 0) return null;
  return (
    <Menu
      side="top"
      align="start"
      label={`Saved prompts (${saved.length})`}
      trigger={<ComposerChip icon={<BookmarkSimple size={14} aria-hidden="true" />} label={`Saved (${saved.length})`} hideLabelOnPhone menu />}
    >
      {saved.map((s, i) => (
        <div key={`${s.at}-${i}`} className="flex items-center">
          <MenuItem
            className="min-w-0 flex-1"
            onSelect={() => {
              const text = takeSaved(i);
              if (text !== null) onPick(text);
            }}
          >
            <span className="block truncate">{savedPreview(s.text)}</span>
            <span className="block text-xs text-text-muted">{relativeTime(s.at)}</span>
          </MenuItem>
          <MenuItem
            aria-label={`Remove ${savedPreview(s.text)}`}
            title="Remove"
            className="shrink-0 px-2"
            onSelect={(e) => {
              // Keep the menu open: the list shrinks in place.
              e.preventDefault();
              takeSaved(i);
            }}
          >
            <X size={12} aria-hidden="true" />
          </MenuItem>
        </div>
      ))}
    </Menu>
  );
}
