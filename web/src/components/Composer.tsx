import { useLayoutEffect, type AriaAttributes, type ClipboardEvent, type DragEvent, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { cn } from "../lib/utils";

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
  className?: string;
}

/**
 * The one message box for chat and Home. Two rows: the text on top, a bottom
 * row of controls. No border: the raised fill is the edge.
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
  onPaste,
  onFocus,
  onDropFiles,
  textareaAria,
  attachments,
  leading,
  trailing,
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
    if (e.defaultPrevented || !onSubmit) return;
    // Touch keyboards have no Shift+Enter: Enter is a newline there, and the send button sends.
    const touch = window.matchMedia("(pointer: coarse)").matches;
    if (e.key === "Enter" && !touch && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div
      className={cn("flex flex-col gap-1 rounded-composer bg-surface-raised px-4 pt-2.5 pb-2", className)}
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
      <div className="flex min-w-0 items-center gap-1">
        {leading}
        <div className="min-w-2 flex-1" />
        {trailing}
      </div>
    </div>
  );
}
