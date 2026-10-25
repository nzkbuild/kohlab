import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import * as RadixTabs from "@radix-ui/react-tabs";
import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import {
  ArrowCounterClockwise,
  BellRinging,
  CaretDown,
  CaretRight,
  Check,
  CheckCircle,
  Circle,
  Eye,
  PauseCircle,
} from "@phosphor-icons/react";
import { cn } from "../lib/utils";
import { subscribeAnnouncements } from "../lib/announce";
import { restoreFocusAfterClose } from "../lib/inputModality";
import { STATUS_CHIP, STATUS_LABEL, type WorkspaceStatus } from "../lib/status";

/** Dialog parts are styled by .dialog-overlay / .dialog-content; re-exported so
 *  surfaces import every Radix primitive through this file. */
import * as RadixDialog from "@radix-ui/react-dialog";

/** Dialog.Content that hands focus back to its opener quietly after a pointer close (keyboard closes keep the ring). */
function DialogContent({ onCloseAutoFocus, ...rest }: RadixDialog.DialogContentProps) {
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  return (
    <RadixDialog.Content
      {...rest}
      onCloseAutoFocus={(e) => {
        onCloseAutoFocus?.(e);
        if (!e.defaultPrevented) restoreFocusAfterClose(e, opener?.isConnected && opener !== document.body ? opener : null);
      }}
    />
  );
}
export const Dialog = { ...RadixDialog, Content: DialogContent };

/** Shape cue per status, drawn from the icon set rather than text glyphs. The one source for status icons: StatusChip and the sidebar both use it. */
export const STATUS_ICON: Record<WorkspaceStatus, ReactNode> = {
  "needs-you": <BellRinging size={14} />,
  running: <Circle size={10} weight="fill" />,
  "needs-review": <Eye size={14} />,
  committed: <CheckCircle size={14} />,
  discarded: <ArrowCounterClockwise size={14} />,
  stopped: <PauseCircle size={14} />,
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

interface ComposerChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** A Phosphor icon at 14px, drawn before the label. */
  icon?: ReactNode;
  label?: string;
  /** Shows the small down caret: the chip opens a menu. */
  menu?: boolean;
  /** Icon only: the label must then be an aria-label. */
  iconOnly?: boolean;
  /** The label is hidden on phones; the button keeps its accessible name. */
  hideLabelOnPhone?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * A quiet pill trigger for the composer's controls. Forwards its ref and every
 * prop, so it can be a Radix Menu trigger. No border: the hover fill is the edge.
 */
export function ComposerChip({
  icon,
  label,
  menu = false,
  iconOnly = false,
  hideLabelOnPhone = false,
  className,
  type = "button",
  ref,
  ...rest
}: ComposerChipProps) {
  return (
    <button ref={ref} type={type} className={cn("chip-trigger", iconOnly && "chip-trigger-icon", className)} {...rest}>
      {icon}
      {label ? <span className={cn(hideLabelOnPhone && "max-md:hidden")}>{label}</span> : null}
      {menu ? <CaretDown size={12} aria-hidden="true" className="shrink-0 text-text-faint" /> : null}
    </button>
  );
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

/** The project page's segmented switch: a pill track, the selected segment is the lighter thumb. */
export function TabList({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <RadixTabs.List
      aria-label={label}
      className={cn("inline-grid grid-flow-col auto-cols-[minmax(6rem,1fr)] items-center rounded-full bg-surface-hover p-[3px]", className)}
    >
      {children}
    </RadixTabs.List>
  );
}

export function Tab({ className, ...rest }: RadixTabs.TabsTriggerProps) {
  return (
    <RadixTabs.Trigger
      className={cn(
        "flex h-[30px] items-center justify-center gap-2 rounded-full px-4 text-sm whitespace-nowrap text-text-muted transition-colors hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:h-11",
        "aria-selected:bg-surface-active aria-selected:font-medium aria-selected:text-text-primary",
        className,
      )}
      {...rest}
    />
  );
}

export const TabPanel = RadixTabs.Content;

/* -------------------------------------------------------------------- menu -- */

export function Menu({
  trigger,
  label,
  align = "end",
  side,
  children,
}: {
  trigger: ReactNode;
  label: string;
  align?: "start" | "end";
  side?: "top" | "bottom";
  children: ReactNode;
}) {
  const triggerRef = useRef<HTMLElement>(null);
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild aria-label={label}>
        {isValidElement(trigger)
          ? cloneElement(trigger as ReactElement<{ ref?: Ref<HTMLElement> }>, { ref: triggerRef })
          : trigger}
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          className="menu max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
          align={align}
          side={side}
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(e) => restoreFocusAfterClose(e, triggerRef.current)}
        >
          {children}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

/* Parts for a surface that owns its menu's open state (the sidebar's project rows). */
export const MenuRoot = RadixMenu.Root;
export const MenuTrigger = RadixMenu.Trigger;
export const MenuPortal = RadixMenu.Portal;
export function MenuContent(props: RadixMenu.DropdownMenuContentProps) {
  return (
    <RadixMenu.Content
      className="menu max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
      align="end"
      sideOffset={4}
      collisionPadding={8}
      {...props}
    />
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

/** A checked item shows its tick at the end; the group holds one value at a time. */
export const MenuRadioGroup = RadixMenu.RadioGroup;

export function MenuRadioItem({ className, children, ...rest }: RadixMenu.DropdownMenuRadioItemProps) {
  return (
    <RadixMenu.RadioItem className={cn("menu-item", className)} {...rest}>
      <span className="min-w-0 flex-1">{children}</span>
      <RadixMenu.ItemIndicator className="shrink-0 text-text-muted">
        <Check size={14} aria-hidden="true" />
      </RadixMenu.ItemIndicator>
    </RadixMenu.RadioItem>
  );
}

export function MenuSeparator() {
  return <RadixMenu.Separator className="my-1 h-px bg-line-subtle" />;
}

/** A heading for a group of items. It is not a choice. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <RadixMenu.Label className="px-2.5 pt-1.5 pb-1 text-xs text-text-muted">{children}</RadixMenu.Label>;
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
          <div className="mx-auto mb-3 grid size-10 place-items-center rounded-lg bg-surface-hover text-text-muted">
            {icon}
          </div>
        ) : null}
        <p className="text-lg font-semibold text-text-primary">{title}</p>
        <p className="mt-1.5 text-base leading-relaxed text-text-muted">{description}</p>
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
        <div key={i} className="flex items-center gap-3 px-3.5 py-3">
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
