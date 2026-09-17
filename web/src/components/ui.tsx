import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { subscribeAnnouncements } from "../lib/announce";
import { STATUS_CHIP, STATUS_GLYPH, STATUS_LABEL, type WorkspaceStatus } from "../lib/status";

/* ------------------------------------------------------------------ button -- */

type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
type ButtonSize = "md" | "sm";

/** Fully static class strings — Tailwind cannot see interpolated names. */
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  quiet: "btn-quiet",
  danger: "btn-danger",
};

const BUTTON_SIZE: Record<ButtonSize, string> = { md: "", sm: "btn-sm" };

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
  /** Required when iconOnly — the visible label is absent, the name is not. */
  "aria-label"?: string;
}

export function Button({
  variant = "secondary",
  size = "md",
  iconOnly = false,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn("btn", BUTTON_VARIANT[variant], BUTTON_SIZE[size], iconOnly && "btn-icon", className)}
      {...rest}
    />
  );
}

/* ------------------------------------------------------------------- chips -- */

/**
 * Status is never colour-only (SC 1.4.1): the chip always carries a label, and
 * a glyph gives a second non-colour cue that survives greyscale and
 * forced-colors.
 */
export function StatusChip({ status, showGlyph = true }: { status: WorkspaceStatus; showGlyph?: boolean }) {
  return (
    <span className={cn("chip", STATUS_CHIP[status])}>
      {showGlyph ? (
        <span aria-hidden="true">{STATUS_GLYPH[status]}</span>
      ) : (
        <span className="chip-dot" aria-hidden="true" />
      )}
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Chip({ tone = "neutral", children }: { tone?: "neutral" | "danger"; children: ReactNode }) {
  return <span className={cn("chip", tone === "danger" && "chip-danger")}>{children}</span>;
}

/* ------------------------------------------------------------------ panels -- */

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn("panel", className)}>{children}</section>;
}

export function PanelHead({ title, icon, meta }: { title: ReactNode; icon?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="panel-head">
      <h2 className="panel-title">
        {icon}
        {title}
      </h2>
      {meta ? <span className="text-xs text-text-muted">{meta}</span> : null}
    </div>
  );
}

/* -------------------------------------------------------------- empty state -- */

/**
 * First-run empty and filtered-empty are deliberately different: only the
 * first-run variant may offer creation. Offering "create a workspace" to
 * someone whose filter simply matched nothing is a dead end.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid place-items-center px-6 py-12 text-center">
      <div className="max-w-md">
        {icon ? (
          <div className="mx-auto mb-3 grid size-10 place-items-center rounded-lg border border-line-subtle bg-surface-hover text-text-muted">
            {icon}
          </div>
        ) : null}
        <p className="text-base font-semibold text-text-primary">{title}</p>
        <p className="mt-1.5 text-sm leading-relaxed text-text-muted">{description}</p>
        {action ? <div className="mt-4 flex justify-center gap-2">{action}</div> : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- skeleton -- */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden="true" />;
}

/**
 * Skeleton rows that reserve the FINAL geometry, so nothing reflows when the
 * real data lands.
 */
export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-t border-line-subtle px-3.5 py-3 first:border-t-0">
          <Skeleton className="size-2 rounded-full" />
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ fields -- */

export function Field({
  label,
  htmlFor,
  help,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  help?: string;
  error?: string;
  children: ReactNode;
}) {
  const describedBy = error ? `${htmlFor}-error` : help ? `${htmlFor}-help` : undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {/* The control is supplied by the caller so it can own its own props; the
          description id is forwarded through the children's own aria-describedby
          by convention rather than cloning. */}
      <div data-described-by={describedBy}>{children}</div>
      {error ? (
        <p id={`${htmlFor}-error`} className="field-help text-status-danger" role="alert">
          {error}
        </p>
      ) : help ? (
        <p id={`${htmlFor}-help`} className="field-help">
          {help}
        </p>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------- kbd -- */

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/* ---------------------------------------------------------------- announcer -- */

/**
 * The single live region for the whole app. Permanently present and initially
 * empty, as live regions must be to be announced reliably; coalesced upstream
 * so a busy run cannot flood a screen reader.
 */
export function Announcer() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      subscribeAnnouncements((message) => {
        if (ref.current) ref.current.textContent = message;
      }),
    [],
  );
  return <div ref={ref} role="status" aria-live="polite" aria-atomic="true" className="sr-only" />;
}
