import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import * as RadixTabs from "@radix-ui/react-tabs";
import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { CaretRight, Check, Diamond, Play, Square, X } from "@phosphor-icons/react";
import { cn } from "../lib/utils";
import { subscribeAnnouncements } from "../lib/announce";
import { STATUS_CHIP, STATUS_LABEL, type WorkspaceStatus } from "../lib/status";

/** Dialog parts are styled by .dialog-overlay / .dialog-content; re-exported so
 *  surfaces import every Radix primitive through this file. */
export * as Dialog from "@radix-ui/react-dialog";

/** Shape cue per status, drawn from the icon set rather than text glyphs. */
const STATUS_ICON: Record<WorkspaceStatus, ReactNode> = {
  running: <Play size={9} weight="fill" />,
  "needs-review": <Diamond size={9} weight="fill" />,
  committed: <Check size={10} weight="bold" />,
  discarded: <X size={10} weight="bold" />,
  stopped: <Square size={8} weight="fill" />,
};

/* ------------------------------------------------------------------ button -- */

type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
type ButtonSize = "md" | "sm";

/** Fully static class strings, Tailwind cannot see interpolated names. */
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
  /** Required when iconOnly, the visible label is absent, the name is not. */
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
        <span className="inline-flex" aria-hidden="true">{STATUS_ICON[status]}</span>
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

/* ------------------------------------------------------------- page header -- */

/** The one <h1> a surface owns, its description, and the surface-level actions. */
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="surface-title">{title}</h1>
        {description ? <p className="surface-description">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/* -------------------------------------------------------------------- tabs -- */

/*
 * Radix owns roving focus, arrow/Home/End keys and the tab/panel ARIA wiring.
 * Components import these, never Radix directly, so the styling stays here.
 */
export const Tabs = RadixTabs.Root;

export function TabList({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <RadixTabs.List aria-label={label} className={cn("tabstrip", className)}>
      {children}
    </RadixTabs.List>
  );
}

export function Tab({ className, ...rest }: RadixTabs.TabsTriggerProps) {
  return <RadixTabs.Trigger className={cn("tab", className)} {...rest} />;
}

export const TabPanel = RadixTabs.Content;

/* -------------------------------------------------------------------- menu -- */

export function Menu({ trigger, label, children }: { trigger: ReactNode; label: string; children: ReactNode }) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild aria-label={label}>
        {trigger}
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content className="menu" align="end" sideOffset={4} collisionPadding={8}>
          {children}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

export function MenuSub({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <RadixMenu.Sub>
      <RadixMenu.SubTrigger className="menu-item">
        {icon}
        <span className="flex-1">{label}</span>
        <CaretRight size={12} className="text-text-faint" aria-hidden="true" />
      </RadixMenu.SubTrigger>
      <RadixMenu.Portal>
        <RadixMenu.SubContent className="menu max-h-80 overflow-y-auto" sideOffset={4} collisionPadding={8}>
          {children}
        </RadixMenu.SubContent>
      </RadixMenu.Portal>
    </RadixMenu.Sub>
  );
}

export function MenuItem({ tone, className, ...rest }: RadixMenu.DropdownMenuItemProps & { tone?: "danger" }) {
  return <RadixMenu.Item className={cn("menu-item", tone === "danger" && "menu-item-danger", className)} {...rest} />;
}

/* ----------------------------------------------------------------- tooltip -- */

export const TooltipProvider = RadixTooltip.Provider;

/** Supplementary only: the trigger must carry its own accessible name. */
export function Tooltip({
  content,
  side = "right",
  disabled,
  children,
}: {
  content: ReactNode;
  side?: RadixTooltip.TooltipContentProps["side"];
  disabled?: boolean;
  children: ReactNode;
}) {
  if (disabled) return <>{children}</>;
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="tooltip" side={side} sideOffset={6} aria-hidden="true">
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
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

/** The Kohlab mark (brand/kohlab-mark.svg): cursor-bar stem, branch arm, and the
 *  session dot that outlives the connection. Inherits colour from its parent. */
export function BrandMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect x="6" y="5" width="4.6" height="22" rx="1.4" fill="currentColor" />
      <path d="M10.6 16.4 23 6.6M10.6 16.4 19.2 22" stroke="currentColor" strokeWidth="4.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="24.8" cy="26.8" r="2.9" fill="currentColor" />
    </svg>
  );
}

/** brand/kohlab-empty.svg: a hairline terminal frame waiting on the session dot. */
export function EmptyArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 120" fill="none" aria-hidden="true" className={className}>
      <rect x="48.5" y="16.5" width="143" height="88" rx="10" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.5" />
      <line x1="48.5" y1="40.5" x2="191.5" y2="40.5" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.5" />
      <circle cx="64" cy="28.5" r="3" fill="currentColor" fillOpacity="0.32" />
      <circle cx="77" cy="28.5" r="3" fill="currentColor" fillOpacity="0.32" />
      <circle cx="90" cy="28.5" r="3" fill="currentColor" fillOpacity="0.32" />
      <rect x="106" y="54" width="7" height="34" rx="2" fill="currentColor" />
      <path d="M118.4 71.2 134 55.4M118.4 71.2 127.4 80.2" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="140.5" cy="85.5" r="4.4" fill="currentColor" />
    </svg>
  );
}
