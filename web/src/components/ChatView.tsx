import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowCounterClockwise, ArrowDown, ArrowUp, Browser, CaretRight, Check, Copy, Paperclip, Stop, Warning, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, type ChatUsage, type ChatUsageWindow } from "../api";
import type { ChatEvent as StoredChatEvent } from "../types";
import { announce } from "../lib/announce";
import { splitAttached, pastedName, safeAttachName, withSuffix } from "../lib/attach";
import { copyText } from "../lib/clipboard";
import { findWorkspace, useApp, useCan } from "../store";
import { workspaceStatus } from "../lib/status";
import { inline, parseBlocks, type Inline } from "../lib/markdown";
import { cn } from "../lib/utils";
import { isPhone } from "../lib/viewport";
import { MODEL_LABEL, modelOf } from "../lib/projectActions";
import ConfirmDialog from "./ConfirmDialog";
import { Composer } from "./Composer";
import { Button, ComposerChip, Menu, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, Tooltip } from "./ui";

/** An event as chat.ts writes it. `why` is the AI's one-line reason for a command (on ask events). */
type ChatEvent = StoredChatEvent & { why?: string };
type ToolEvent = Extract<ChatEvent, { kind: "tool" }>;
type AskEvent = Extract<ChatEvent, { kind: "ask" }>;

const MAX_FILES = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const TOO_BIG = "That file is too big. Files up to 20 MB work.";

/** A file waiting in the composer. `path` is set once it is saved in the project, so a retry does not save it twice. */
interface Attachment {
  key: number;
  file: File;
  url: string | null;
  path?: string;
}

interface Props {
  workspaceId: string;
  onPreview?: () => void;
  previewing?: boolean;
  previewOpen?: boolean;
  /** Narrow dock (the Files view): full-width column, and no Keep/Preview/Undo row. */
  compact?: boolean;
  /** Called when Claude's turn ends, so an open preview can reload. */
  onTurnEnd?: () => void;
  /** A terminal project's Claude, shown as its chat: no Keep / Undo, since those would change the real project. */
  terminalProject?: boolean;
}

/** The tool lines of one run, as one plain sentence: "looked at 3 files, wrote 2 and ran 1 command". Prefixes come from describeTool in chat.ts. */
function summarizeTools(lines: string[]): string {
  let read = 0;
  let ran = 0;
  let searched = 0;
  let looked = 0;
  let helped = 0;
  let other = 0;
  const wrote = new Set<string>();
  for (const t of lines) {
    if (t.startsWith("Created ") || t.startsWith("Edited ")) wrote.add(t.slice(t.indexOf(" ") + 1));
    else if (t.startsWith("Read ")) read++;
    else if (t.startsWith("Ran: ")) ran++;
    else if (t.startsWith("Searched the web") || t.startsWith("Opened ")) looked++;
    else if (t.startsWith("Searched")) searched++;
    else if (t.startsWith("Asked a helper")) helped++;
    else other++;
  }
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts: string[] = [];
  if (read) parts.push(`looked at ${n(read, "file", "files")}`);
  if (wrote.size) parts.push(`wrote ${n(wrote.size, "file", "files")}`);
  if (ran) parts.push(`ran ${n(ran, "command", "commands")}`);
  if (searched) parts.push(`searched ${n(searched, "time", "times")}`);
  if (looked) parts.push(`looked up ${n(looked, "page", "pages")}`);
  if (helped) parts.push(`asked ${n(helped, "helper", "helpers")}`);
  if (other) parts.push(`did ${n(other, "other thing", "other things")}`);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Present-tense version of a describeTool line for the working line: "Created a.html" -> "Writing a.html". */
function workingLine(t: string): string {
  const rest = (n: number) => t.slice(n);
  if (t.startsWith("Created ")) return `Writing ${rest(8)}`;
  if (t.startsWith("Edited ")) return `Editing ${rest(7)}`;
  if (t.startsWith("Read ")) return `Reading ${rest(5)}`;
  if (t.startsWith("Ran: ")) return "Running a command";
  if (t.startsWith("Searched the web")) return "Searching the web";
  if (t.startsWith("Searched")) return "Searching the files";
  if (t.startsWith("Opened ")) return "Opening a page";
  if (t.startsWith("Asked a helper")) return "Asking a helper";
  return "Working";
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "12s" under a minute, then "1m 05s". */
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** "claude-opus-5-5" -> "Opus 5.5"; a name it does not know is shown as it is. */
function modelName(id: string): string {
  const m = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d{8})?$/.exec(id);
  if (m) return `${cap(m[1])} ${m[2]}.${m[3]}`;
  return ["opus", "sonnet", "haiku"].includes(id) ? cap(id) : id;
}

/** Permission modes in plain words: the Mode menu's choices, plus the CLI's other names for them. One table for every label. */
const MODES: Record<string, { label: string; detail?: string }> = {
  default: { label: "Asks first", detail: "Asks before changing files or running commands" },
  acceptEdits: { label: "Edits allowed", detail: "Edits files without asking, asks before commands" },
  auto: { label: "Auto", detail: "Decides for itself what needs your OK" },
  plan: { label: "Plan first", detail: "Plans and explains before changing anything" },
  manual: { label: "Asks first" },
  bypassPermissions: { label: "No questions" },
};

/** The modes the Mode menu offers, in order. */
const MODE_CHOICES = ["default", "acceptEdits", "auto", "plan"];

const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/** A slash command and a model, as the chat's snapshot lists them. */
interface CommandInfo {
  name: string;
  description: string;
  argumentHint: string;
}
interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
  supportedEffortLevels: string[];
}

/** The working line: a pulsing dot, the current action, how long the turn has run, and background tasks (a button that opens their list). The timer ticks only while this line is shown. */
function WorkingLine({ action, since, background, tasksOpen, onTasks }: { action: string; since: number | null; background: number; tasksOpen: boolean; onTasks: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <p className="flex items-center gap-2 text-small text-text-muted">
      <span className="pulse-dot size-1.5 shrink-0 rounded-full bg-text-muted" aria-hidden="true" />
      <span className="shimmer-text min-w-0">{action}</span>
      {/* aria-hidden: the timer changes every second and must not be read out */}
      {since !== null ? <span aria-hidden="true" className="tabular-nums text-text-faint">{formatElapsed(now - since)}</span> : null}
      {background > 0 ? (
        <button type="button" aria-expanded={tasksOpen} onClick={onTasks} className="rounded px-1 hover:bg-surface-hover hover:text-text-primary">
          · {background} in background
        </button>
      ) : null}
    </p>
  );
}

/** A background task the CLI runs: its id (to stop it), its kind and what it does. */
interface BgTask {
  id: string;
  type: string;
  description: string;
}

/** The background tasks, each with a Stop. Opened from the "in background" text. */
function TaskList({ tasks, stopping, onStop }: { tasks: BgTask[]; stopping: string | null; onStop: (id: string) => void }) {
  return (
    <ul aria-label="Background tasks" className="flex flex-col gap-1 pl-5 text-sm text-text-muted">
      {tasks.map((t) => (
        <li key={t.id} className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{t.description || "A background task"}</span>
          <Button
            variant="quiet"
            size="sm"
            className="text-xs text-text-secondary"
            disabled={stopping !== null}
            aria-label={`Stop ${t.description || "background task"}`}
            onClick={() => onStop(t.id)}
          >
            Stop
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** "Fri, 7:00 AM": when a plan limit resets, in this device's time. Empty when the time is not known. */
function resetText(iso: string | null): string {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
}

/** The chat's usage details: the context window in use, and the plan's limits when the CLI reports them. */
function UsagePanel({ usage }: { usage: ChatUsage }) {
  const rows: string[] = [];
  if (usage.context) {
    rows.push(`Context: ${usage.context.used.toLocaleString()} of ${usage.context.limit.toLocaleString()} tokens used (${usage.context.percent}%)`);
  }
  const planRow = (label: string, w: ChatUsageWindow | null) => {
    if (!w) return;
    const reset = resetText(w.resetsAt);
    rows.push(`${label} ${w.percent}%${reset ? ` · resets ${reset}` : ""}`);
  };
  if (usage.plan) {
    planRow("5-hour limit", usage.plan.fiveHour);
    planRow("Week", usage.plan.week);
  }
  if (rows.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm text-text-secondary">
      {rows.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}

/** A menu of options the arrow keys move through, and a press picks: the "/" commands and the "@" files. Same surface and items as the Radix menus. */
interface PickOption {
  key: string;
  title: ReactNode;
  detail?: string;
}
function PickList({ id, label, options, active, onPick }: { id: string; label: string; options: PickOption[]; active: number; onPick: (i: number) => void }) {
  // Keep the arrow-key row in view. Mounts with the list, so the first row is in view too.
  useEffect(() => {
    document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [id, active]);
  return (
    <ul id={id} role="listbox" aria-label={label} className="menu mb-2 max-h-80 w-full overflow-x-hidden overflow-y-auto text-left">
      {options.map((o, i) => (
        <li
          key={o.key}
          id={`${id}-opt-${i}`}
          role="option"
          aria-selected={i === active}
          // a pointer press picks the option without taking focus from the composer
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(i);
          }}
          className={cn(
            "menu-item min-h-9 min-w-0 cursor-pointer items-center text-left pointer-coarse:min-h-11 max-md:my-0.5 max-md:py-2",
            i === active && "bg-surface-hover text-text-primary",
          )}
        >
          {/* One line on desktop: name, then detail. On phones the detail drops under the name. */}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 md:flex-row md:items-baseline md:gap-2">
            <span className="min-w-0 truncate text-text-primary md:max-w-[60%] md:shrink-0">{o.title}</span>
            {o.detail ? <span className="min-w-0 truncate text-text-muted md:flex-1">{o.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Merge a fresh batch into the list by sequence number, so a repeated event never shows twice. */
function mergeEvents(prev: ChatEvent[], next: ChatEvent[]): ChatEvent[] {
  const seen = new Set(prev.map((e) => e.n));
  const fresh = next.filter((e) => !seen.has(e.n));
  if (fresh.length === 0) return prev;
  return [...prev, ...fresh].sort((a, b) => a.n - b.n);
}

/** Inline pieces as elements, never as HTML: bold, `code`, links. Anything else stays plain text. */
function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "strong":
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case "code":
        return (
          <code key={i} className="mono rounded bg-surface-sunken px-1 py-0.5 text-[0.85em]">
            {node.text}
          </code>
        );
      case "link":
        return (
          <a
            key={i}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-primary underline decoration-line-strong underline-offset-[3px] hover:decoration-line-accent"
          >
            {node.text}
          </a>
        );
    }
  });
}

const rich = (text: string) => renderInline(inline(text));

/** Copy with a check mark for 1.5 s. A failed copy says so. */
function useCopied(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async (text: string) => {
    try {
      await copyText(text);
      setCopied(true);
      announce("Copied");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy");
    }
  };
  return [copied, copy];
}

/** The action row under a reply. Hidden until the reply is hovered or focused; always shown on touch and on the latest reply. */
function CopyReply({ text, latest }: { text: string; latest: boolean }) {
  const [copied, copy] = useCopied();
  const Icon = copied ? Check : Copy;
  return (
    <div className="-ml-2.5 -mt-1 flex">
      <Tooltip content="Copy">
        <Button
          variant="quiet"
          iconOnly
          aria-label="Copy reply"
          className={cn(
            "text-text-faint hover:text-text-primary [@media(pointer:coarse)]:opacity-100",
            "motion-safe:transition-opacity",
            latest ? "opacity-100" : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
          )}
          onClick={() => void copy(text)}
        >
          <Icon size={16} aria-hidden="true" />
        </Button>
      </Tooltip>
    </div>
  );
}

/** A fenced block: mono code that scrolls sideways, with its language and a Copy of the code only. */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, copy] = useCopied();
  const Icon = copied ? Check : Copy;
  return (
    <div className="overflow-hidden rounded-card bg-surface-sunken">
      <div className="flex items-center justify-between gap-3 py-0.5 pr-1 pl-3.5">
        <span className="mono min-w-0 truncate text-xs text-text-muted">{lang}</span>
        <Button
          variant="quiet"
          size="sm"
          aria-label="Copy code"
          className="text-xs text-text-secondary"
          onClick={() => void copy(code)}
        >
          <Icon size={14} aria-hidden="true" />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="mono overflow-x-auto px-3.5 py-3 text-sm leading-5 text-text-primary">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** What Claude said, in a measure a person can read without losing their place. */
function Prose({ text }: { text: string }) {
  return (
    <div className="flex max-w-[66ch] min-w-0 flex-col gap-3 text-base leading-6 text-text-primary max-md:max-w-none max-md:w-full max-md:text-base">
      {parseBlocks(text).map((block, i) => {
        if (block.kind === "p") return <p key={i} className="whitespace-pre-line">{rich(block.lines.join("\n"))}</p>;
        if (block.kind === "h") return <p key={i} className="text-lg font-semibold text-text-primary">{rich(block.text)}</p>;
        if (block.kind === "hr") return <hr key={i} className="border-line-subtle" />;
        if (block.kind === "code") return <CodeBlock key={i} lang={block.lang} code={block.code} />;
        if (block.kind === "ul") {
          return (
            <ul key={i} className="space-y-1.5">
              {block.items.map((item, j) => (
                <li
                  key={j}
                  className="relative pl-[18px] before:absolute before:top-[10px] before:left-[4px] before:size-[5px] before:rounded-full before:bg-text-muted before:content-['']"
                >
                  {rich(item)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <ol key={i} className="list-decimal space-y-1.5 pl-[18px] marker:text-text-muted">
            {block.items.map((item, j) => (
              <li key={j}>{rich(item)}</li>
            ))}
          </ol>
        );
      })}
    </div>
  );
}

/** A run of tool actions: one muted line; the caret opens the list of each action. Collapsed while live too: the working line shows the current step. */
function ToolRun({ lines }: { lines: ChatEvent[] }) {
  const [open, setOpen] = useState(false);
  const tools = lines.filter((e): e is ToolEvent => e.kind === "tool");
  const summary = summarizeTools(tools.map((e) => e.text));
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 items-center gap-1.5 rounded-lg px-1 text-left text-small text-text-muted hover:bg-surface-hover hover:text-text-primary shell:min-h-8"
      >
        <CaretRight size={14} aria-hidden="true" className={cn("shrink-0 motion-safe:transition-transform", open && "rotate-90")} />
        {cap(summary)}
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-1 pl-6 text-sm text-text-muted">
          {tools.map((e) => (
            <li key={e.n}>{e.text}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The question Claude asked, and the answer, once given: one muted line. */
function AnsweredAsk({ e, allowed }: { e: AskEvent; allowed: boolean }) {
  // "Claude wants to create the file index.html" reads as "You allowed Claude to create index.html".
  const what = e.text.replace(/^Claude wants to /, "").replace(/^(create|change) the file /, "$1 ");
  const Icon = allowed ? Check : X;
  return (
    <div className="text-small text-text-muted">
      <p className="flex items-start gap-1.5">
        <Icon size={14} className="mt-[5px] shrink-0" aria-hidden="true" />
        <span className="min-w-0">{allowed ? `You allowed Claude to ${what}` : `You didn't allow Claude to ${what}`}</span>
      </p>
      {e.detail || e.why ? (
        <div className="ml-5">
          <Details detail={e.detail} why={e.why} />
        </div>
      ) : null}
    </div>
  );
}

/** Several answered asks in a row (and the tool runs between them) as one line: "You allowed 3 changes to index.html". */
function AnsweredGroup({ events, answers }: { events: ChatEvent[]; answers: Map<string, boolean> }) {
  const asks = events.filter((e): e is AskEvent => e.kind === "ask");
  const allowed = asks.filter((a) => answers.get(a.requestId));
  const denied = asks.length - allowed.length;
  const files = new Set<string>();
  let changes = 0;
  let commands = 0;
  let others = 0;
  for (const a of allowed) {
    const f = /^Claude wants to (?:create|change) the file (.+)$/.exec(a.text);
    if (f) {
      changes++;
      files.add(f[1]);
    } else if (a.text === "Claude wants to run a command") commands++;
    else others++;
  }
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts: string[] = [];
  if (changes) parts.push(n(changes, "change", "changes"));
  if (commands) parts.push(n(commands, "command", "commands"));
  if (others) parts.push(n(others, "other step", "other steps"));
  let text = parts.length === 0 ? "" : `You allowed ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`}`;
  if (files.size === 1 && changes && !commands && !others) text += ` to ${[...files][0]}`;
  if (denied) text += `${text ? ", and you" : "You"} didn't allow ${n(denied, "step", "steps")}`;
  return (
    <div className="text-small text-text-muted">
      <p className="flex items-start gap-1.5">
        <Check size={14} className="mt-[5px] shrink-0" aria-hidden="true" />
        <span className="min-w-0">{text}</span>
      </p>
      <details className="ml-5 text-sm text-text-muted">
        <summary className="flex min-h-11 cursor-pointer select-none items-center hover:text-text-primary shell:min-h-8">Show details</summary>
        <ul className="mb-2 flex flex-col gap-1">
          {events.map((e) =>
            e.kind === "ask" ? (
              <li key={e.n}>
                {answers.get(e.requestId) ? "Allowed: " : "Not allowed: "}
                {e.text.replace(/^Claude wants to /, "")}
                {e.detail ? <span className="mono block break-all text-text-secondary">{e.detail}</span> : null}
              </li>
            ) : e.kind === "tool" ? (
              <li key={e.n}>{e.text}</li>
            ) : null,
          )}
        </ul>
      </details>
    </div>
  );
}

/** The command behind an ask (and its reason, when the card does not already show it), behind a disclosure. */
function Details({ detail, why, className }: { detail?: string; why?: string; className?: string }) {
  return (
    <details className={cn("text-sm text-text-muted", className)}>
      <summary className="flex min-h-11 cursor-pointer select-none items-center hover:text-text-primary shell:min-h-8">Show details</summary>
      {why ? <p className="pb-2 text-text-secondary">{why}</p> : null}
      {detail ? (
        <pre className="mono mb-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-surface-sunken px-3 py-2 text-sm text-text-secondary">
          {detail}
        </pre>
      ) : null}
    </details>
  );
}

function groupRows(events: ChatEvent[]): ChatEvent[][] {
  const rows: ChatEvent[][] = [];
  for (const e of events) {
    if (e.kind === "done" || e.kind === "answer") continue;
    const last = rows[rows.length - 1];
    if (e.kind === "tool" && last?.[0].kind === "tool") last.push(e);
    else rows.push([e]);
  }
  return rows;
}

export default function ChatView({ workspaceId, onPreview, previewing = false, previewOpen = false, onTurnEnd, compact = false, terminalProject = false }: Props) {
  const refresh = useApp((s) => s.refresh);
  const workspaces = useApp((s) => s.workspaces);
  const can = useCan().mutate;
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [busy, setBusy] = useState(false);
  // When the current turn started (ms), whoever started it; background tasks still running; the model and mode the CLI reports.
  const [busySince, setBusySince] = useState<number | null>(null);
  const [tasks, setTasks] = useState<BgTask[]>([]);
  const background = tasks.length;
  const [tasksOpen, setTasksOpen] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  // The CLI is retrying a request: which try, of how many. And the chat's usage, read when the last turn ended.
  const [retry, setRetry] = useState<{ attempt: number; max: number } | null>(null);
  const [usage, setUsage] = useState<ChatUsage | null>(null);
  // Undo: the newest message's id while its files are being checked, and the list the person is asked to confirm.
  const [rewindBusy, setRewindBusy] = useState(false);
  const [rewindPlan, setRewindPlan] = useState<{ uuid: string; files: string[]; insertions: number; deletions: number } | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  // The effort level set in this Claude, and what the CLI offers: slash commands and models.
  const [effort, setEffort] = useState<string | null>(null);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [commandsEnabled, setCommandsEnabled] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  // The "/" menu: which command is highlighted, and whether Esc closed it for this text.
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashShut, setSlashShut] = useState(false);
  // The "@" menu: Esc closes it for this text.
  const [mentionShut, setMentionShut] = useState(false);
  // Scrolled up from the newest message: the "Scroll to latest" button shows.
  const [farFromEnd, setFarFromEnd] = useState(false);
  // Whether the project's terminal Claude is open: sending from here closes it.
  const [terminalOpen, setTerminalOpen] = useState(false);
  // Claude's reply as it is being written (streamed by the server, not yet an event).
  const [streamed, setStreamed] = useState("");
  const [kick, setKick] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [keeping, setKeeping] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const attachKey = useRef(0);
  const attachRef = useRef(attachments);
  attachRef.current = attachments;
  const fileRef = useRef<HTMLInputElement>(null);
  // Release the preview links of files still in the composer when the chat closes.
  useEffect(() => () => attachRef.current.forEach((a) => a.url && URL.revokeObjectURL(a.url)), []);
  // iOS Safari does not shrink the layout viewport for the keyboard, so the composer
  // would sit under it. While the composer is focused on a phone, the chat is lifted by the keyboard's height.
  const [keyboard, setKeyboard] = useState(0);

  const afterRef = useRef(0);
  const primedRef = useRef(false);
  const openedRef = useRef(false);
  const announcedRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Poll: 0.5 s while the AI is working, 1 s while it waits for an answer or background tasks run, 4 s otherwise. Paused while the
  // tab is hidden; `kick` restarts the loop at once (after a send or an answer).
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;

    const schedule = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void run(), ms);
    };

    const run = async () => {
      if (!alive || document.visibilityState === "hidden") return;
      try {
        const res = await api.chat(workspaceId, afterRef.current);
        if (!alive) return;
        const top = res.events.reduce((m, e) => Math.max(m, e.n), afterRef.current);
        afterRef.current = top;
        // The first load is history: it is not announced to a screen reader.
        if (!primedRef.current) {
          announcedRef.current = top;
          primedRef.current = true;
          // A brand-new chat has no history: the composer is where the user starts.
          if (res.events.length === 0) taRef.current?.focus();
        }
        if (res.events.length > 0) setEvents((prev) => mergeEvents(prev, res.events));
        setBusy(res.busy);
        // elapsed on the server's clock, moved onto this device's; kept steady across polls
        const start = res.busySince === null ? null : Date.now() - (res.now - res.busySince);
        setBusySince((prev) => (prev !== null && start !== null && Math.abs(prev - start) < 2000 ? prev : start));
        setTasks(res.tasks);
        setRetry(res.retry);
        setUsage(res.usage);
        setModel(res.model);
        setMode(res.mode);
        setWaiting(res.waiting);
        setEffort(res.effort);
        setCommands(res.commands);
        setCommandsEnabled(res.commandsEnabled);
        setModels(res.models);
        setStreamed(res.draft);
        setTerminalOpen(res.terminalOpen ?? false);
        schedule(res.busy ? 500 : res.waiting !== null || res.background > 0 ? 1000 : 4000);
      } catch {
        if (alive) schedule(4000);
      }
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      void run();
    };

    document.addEventListener("visibilitychange", onVisible);
    void run();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [workspaceId, kick]);

  const repoll = () => setKick((k) => k + 1);

  // The task list closes itself when the last task is gone.
  useEffect(() => {
    if (tasks.length === 0) setTasksOpen(false);
  }, [tasks.length]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const phone = window.matchMedia("(max-width: 767.98px)").matches;
      const hidden = Math.round(window.innerHeight - vv.height - vv.offsetTop);
      const lift = phone && document.activeElement === taRef.current && hidden > 80 ? hidden : 0;
      setKeyboard(lift);
      if (lift && nearBottomRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  // A turn that just ended may have changed files: refresh so the Keep / Undo bar sees it,
  // and let the parent reload an open preview.
  const wasBusy = useRef(busy);
  const turnEndRef = useRef(onTurnEnd);
  turnEndRef.current = onTurnEnd;
  useEffect(() => {
    if (!busy) void refresh();
    if (wasBusy.current && !busy) turnEndRef.current?.();
    wasBusy.current = busy;
  }, [busy, refresh]);

  // Announce new assistant text. Bursts are coalesced by announce() itself.
  useEffect(() => {
    for (const e of events) {
      if (e.kind === "assistant" && e.n > announcedRef.current) announce(e.text);
    }
    announcedRef.current = Math.max(announcedRef.current, events.reduce((m, e) => Math.max(m, e.n), 0));
  }, [events]);

  const answers = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const e of events) if (e.kind === "answer") m.set(e.requestId, e.allow);
    return m;
  }, [events]);

  // The question Claude is waiting on right now, if the answer has not come back yet.
  const pendingAsk = useMemo(
    () => (waiting === null ? null : (events.find((e): e is AskEvent => e.kind === "ask" && e.requestId === waiting && !answers.has(waiting)) ?? null)),
    [events, waiting, answers],
  );

  const rows = useMemo(() => groupRows(events), [events]);

  // Work done before a pending question in the same turn is held back until the
  // question is answered, so a summary never reads as finished while Claude waits.
  const pendingN = pendingAsk?.n ?? Infinity;
  const lastUserN = Math.max(0, ...events.filter((e) => e.kind === "user" && e.n < pendingN).map((e) => e.n));
  const visibleRows = useMemo(
    () => (pendingAsk ? rows.filter((row) => !(row[0].kind === "tool" && row[0].n > lastUserN && row[0].n < pendingN)) : rows),
    [rows, lastUserN, pendingN, pendingAsk],
  );

  // Turns: each user message starts one; Claude's replies follow it.
  const turns = useMemo(() => {
    const out: ChatEvent[][][] = [];
    for (const row of visibleRows) {
      if (row[0].kind === "user" || out.length === 0) out.push([]);
      out[out.length - 1].push(row);
    }
    // Answered asks (and the tool runs between them) in one turn read as ONE row.
    const isAnswered = (row: ChatEvent[]) => row.length === 1 && row[0].kind === "ask" && answers.has(row[0].requestId);
    return out.map((turn) => {
      const merged: ChatEvent[][] = [];
      for (let i = 0; i < turn.length; i++) {
        if (!isAnswered(turn[i])) {
          merged.push(turn[i]);
          continue;
        }
        let end = i;
        for (let j = i + 1; j < turn.length && (isAnswered(turn[j]) || turn[j][0].kind === "tool"); j++) if (isAnswered(turn[j])) end = j;
        merged.push(turn.slice(i, end + 1).flat());
        i = end;
      }
      return merged;
    });
  }, [visibleRows, answers]);

  // Keep the newest message in view, but only while the reader is already at the bottom.
  // On open, start at the latest user message rather than mid-reply.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!openedRef.current) {
      if (events.length === 0) return;
      openedRef.current = true;
      const start = el.querySelector<HTMLElement>("[data-turn-start]");
      if (start) el.scrollTop += start.getBoundingClientRect().top - el.getBoundingClientRect().top - 24;
      else el.scrollTop = el.scrollHeight;
      nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      return;
    }
    if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [events, busy, waiting, streamed]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setFarFromEnd(!nearBottomRef.current);
  };

  const scrollToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = true;
    setFarFromEnd(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // Sends one message. Returns true when the server took it.
  const sendText = async (text: string): Promise<boolean> => {
    setSending(true);
    setSendError(null);
    try {
      await api.chatSend(workspaceId, text);
      setBusy(true);
      nearBottomRef.current = true;
      setFarFromEnd(false);
      return true;
    } catch (e) {
      // 409 "still working": Claude is busy, so the composer locks until it is not.
      setSendError((e as Error).message);
      setBusy(true);
      return false;
    } finally {
      setSending(false);
      repoll();
    }
  };

  /** Adds picked, pasted or dropped files to the composer, within the count and size limits. */
  const takeFiles = (list: FileList | File[], pasted = false) => {
    if (waiting !== null || sending || uploading) return;
    const picked = Array.from(list).map((f) => (pasted && !f.name ? new File([f], pastedName(f.type, Date.now()), { type: f.type }) : f));
    if (picked.length === 0) return;
    let note: string | null = null;
    const sized: File[] = [];
    for (const f of picked) {
      if (f.size > MAX_FILE_BYTES) note = TOO_BIG;
      else sized.push(f);
    }
    const room = Math.max(0, MAX_FILES - attachments.length);
    if (sized.length > room) note = `You can attach up to ${MAX_FILES} files at a time.`;
    const fits = sized.slice(0, room);
    setAttachNote(note);
    if (fits.length === 0) return;
    const next: Attachment[] = fits.map((file) => ({
      key: ++attachKey.current,
      file,
      url: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    }));
    setAttachments((prev) => [...prev, ...next]);
  };

  const removeAttachment = (key: number) => {
    const gone = attachments.find((a) => a.key === key);
    if (gone?.url) URL.revokeObjectURL(gone.url);
    setAttachments((prev) => prev.filter((a) => a.key !== key));
    setAttachNote(null);
  };

  const clearAttachments = () => {
    attachments.forEach((a) => a.url && URL.revokeObjectURL(a.url));
    setAttachments([]);
    setAttachNote(null);
  };

  /** Saves each file that is not saved yet into uploads/, adding -2, -3 ... when the name is taken. Returns every saved path. */
  const uploadAll = async (): Promise<string[]> => {
    const paths: string[] = [];
    for (const a of attachments) {
      if (a.path) {
        paths.push(a.path);
        continue;
      }
      const base = safeAttachName(a.file.name);
      let saved: string | null = null;
      for (let i = 1; i <= 20 && saved === null; i++) {
        const res = await api.uploadFile(workspaceId, `uploads/${i === 1 ? base : withSuffix(base, i)}`, a.file);
        if (res.ok) saved = res.path;
      }
      if (saved === null) throw new Error(`Could not save ${a.file.name}. Try a shorter name.`);
      const done = saved;
      setAttachments((prev) => prev.map((x) => (x.key === a.key ? { ...x, path: done } : x)));
      paths.push(done);
    }
    return paths;
  };

  const send = async () => {
    const text = draft.trim();
    // While Claude works, a message is queued: the CLI runs it after the turn.
    if ((!text && attachments.length === 0) || waiting !== null || sending || uploading) return;
    let message = text;
    if (attachments.length > 0) {
      setUploading(true);
      setSendError(null);
      let paths: string[];
      try {
        paths = await uploadAll();
      } catch (e) {
        setSendError((e as Error).message);
        return;
      } finally {
        setUploading(false);
      }
      const line = `Attached: ${paths.join(", ")}`;
      message = text ? `${text}\n\n${line}` : line;
    }
    if (await sendText(message)) {
      setDraft("");
      clearAttachments();
    }
  };

  // The "/" menu: while the text is a command name with no space yet, the commands that start with it.
  const slashQuery = commandsEnabled && draft.startsWith("/") && !/\s/.test(draft) ? draft.slice(1).toLowerCase() : null;
  const slashMatches = slashQuery === null || slashShut ? [] : commands.filter((c) => c.name.toLowerCase().startsWith(slashQuery));
  const slashOn = slashMatches.length > 0;
  // Typing "/" before the command list has loaded: a single row says so.
  const slashLoading = slashQuery !== null && !slashShut && commands.length === 0;
  const slashActive = Math.max(0, Math.min(slashIndex, slashMatches.length - 1));

  // The "@" menu: an "@" that starts a word at the end of the text, with no space after it yet. Files come from the CLI, 150 ms after the last key.
  // ponytail: only at the end of the text; a mention in the middle is typed as plain text. Upgrade path: read the caret position.
  const mentionMatch = /(?:^|\s)@(\S*)$/.exec(draft);
  const mentionQuery = mentionMatch && !slashOn && !mentionShut ? mentionMatch[1] : null;
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  useEffect(() => {
    if (mentionQuery === null) {
      setMentionFiles([]);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      api
        .chatControl(workspaceId, "files", mentionQuery)
        .then((r) => {
          if (!alive) return;
          setMentionFiles(r.files ?? []);
          setMentionIndex(0);
        })
        .catch(() => {
          if (alive) setMentionFiles([]);
        });
    }, 150);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [mentionQuery, workspaceId]);
  const mentionOn = mentionQuery !== null && mentionFiles.length > 0;
  const mentionActive = Math.max(0, Math.min(mentionIndex, mentionFiles.length - 1));

  /** Puts a picked file in the composer as "@path ", in place of the "@" being typed. */
  const pickFile = (path: string) => {
    setDraft((d) => d.replace(/@(\S*)$/, () => `@${path} `));
    setMentionFiles([]);
    taRef.current?.focus();
  };

  /** Puts a picked command in the composer, ready for its details. */
  const pickCommand = (c: CommandInfo) => {
    setDraft(`/${c.name} `);
    taRef.current?.focus();
  };

  /** The "/" chip: an empty draft becomes "/", which opens the command list. */
  const openCommands = () => {
    if (draft === "") setDraft("/");
    setSlashShut(false);
    taRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOn && !e.nativeEvent.isComposing) {
      const n = mentionFiles.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickFile(mentionFiles[mentionActive]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionShut(true);
        return;
      }
    }
    if (slashOn && !e.nativeEvent.isComposing) {
      const n = slashMatches.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickCommand(slashMatches[slashActive]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashShut(true);
        return;
      }
    }
  };

  const answer = async (requestId: string, allow: boolean) => {
    setAnswering(requestId);
    try {
      await api.chatAnswer(workspaceId, requestId, allow);
      repoll();
    } catch (e) {
      toast.error(`Could not answer, ${(e as Error).message}`);
    } finally {
      setAnswering(null);
    }
  };

  /** Stops the current turn. The chat stays open: the process is kept, so the next message needs no restart. */
  const stop = async () => {
    try {
      await api.chatControl(workspaceId, "interrupt", null);
      announce("Claude stopped");
    } catch {
      announce("Claude could not stop");
    } finally {
      repoll();
    }
  };

  /** A menu pick: shown at once and sent to Claude; the old choice comes back with a toast if the server refuses. */
  const pick = async (action: "model" | "mode" | "effort", value: string, current: string | null, set: (v: string | null) => void) => {
    set(value);
    try {
      await api.chatControl(workspaceId, action, value);
    } catch (e) {
      set(current);
      toast.error(`Could not change that, ${(e as Error).message}`);
    } finally {
      repoll();
    }
  };

  const working = busy && waiting === null;
  // The line under the last message: the newest tool line of this turn if the code has one, else "Working".
  const lastUserAllN = Math.max(0, ...events.filter((e) => e.kind === "user").map((e) => e.n));
  const latestTool = [...events].reverse().find((e): e is ToolEvent => e.kind === "tool" && e.n > lastUserAllN);
  // While the CLI retries a failed request, the working line says which try it is on.
  const currentAction = retry ? `Retrying (attempt ${retry.attempt}${retry.max ? ` of ${retry.max}` : ""})…` : latestTool ? workingLine(latestTool.text) : "Working";

  // Keep / Undo only while the AI's changes are waiting to be kept or undone.
  const ws = findWorkspace(workspaces, workspaceId);
  const hasChanges = !terminalProject && ws !== null && workspaceStatus(ws) === "needs-review";
  // The commit message is the user's last request: its first line, cut to 72 characters.
  const lastRequest = [...events].reverse().find((e) => e.kind === "user")?.text ?? "";
  const keepMessage = (lastRequest.split("\n")[0] ?? "").trim().slice(0, 72).trim() || "Changes from chat";

  // How many files the AI changed, for "Changed N files" under the reply.
  const [changed, setChanged] = useState<number | null>(null);
  useEffect(() => {
    if (!hasChanges || busy) return;
    let alive = true;
    api
      .diff(workspaceId)
      .then((files) => {
        if (alive) setChanged(files.length);
      })
      .catch(() => {
        if (alive) setChanged(null);
      });
    return () => {
      alive = false;
    };
  }, [hasChanges, busy, workspaceId]);

  const keep = async () => {
    setKeeping(true);
    try {
      await api.commit(workspaceId, keepMessage);
      await refresh();
      toast.success("Saved");
    } catch (e) {
      toast.error(`Could not save, ${(e as Error).message}`);
    } finally {
      setKeeping(false);
    }
  };

  const undo = async () => {
    setUndoing(true);
    try {
      await api.action(workspaceId, "discard");
      await refresh();
      toast.success("Changes undone");
    } catch (e) {
      toast.error(`Could not undo, ${(e as Error).message}`);
    } finally {
      setUndoing(false);
      setConfirmUndo(false);
    }
  };

  /** Stops one background task the CLI runs. */
  const stopTask = async (taskId: string) => {
    setStopping(taskId);
    try {
      await api.chatControl(workspaceId, "stop_task", taskId);
      announce("Task stopped");
    } catch (e) {
      toast.error(`Could not stop that, ${(e as Error).message}`);
    } finally {
      setStopping(null);
      repoll();
    }
  };

  /** Undo, step 1: which files Claude changed since this message. None: say so. Otherwise the list to confirm. */
  const previewUndo = async (uuid: string) => {
    setRewindBusy(true);
    try {
      const r = await api.chatControl(workspaceId, "rewind_preview", uuid);
      const files = r.files ?? [];
      if (files.length === 0) toast("No files changed since that message");
      else setRewindPlan({ uuid, files, insertions: r.insertions ?? 0, deletions: r.deletions ?? 0 });
    } catch (e) {
      toast.error(`Could not undo, ${(e as Error).message}`);
    } finally {
      setRewindBusy(false);
    }
  };

  /** Undo, step 2: put the files back as they were before the message. */
  const confirmRewind = async () => {
    if (!rewindPlan) return;
    setRewindBusy(true);
    try {
      await api.chatControl(workspaceId, "rewind", rewindPlan.uuid);
      const n = rewindPlan.files.length;
      toast.success(`Undid changes to ${n} ${n === 1 ? "file" : "files"}`);
      await refresh();
    } catch (e) {
      toast.error(`Could not undo, ${(e as Error).message}`);
    } finally {
      setRewindBusy(false);
      setRewindPlan(null);
    }
  };

  const renderEvent = (e: ChatEvent) => {
    switch (e.kind) {
      case "user": {
        const { body, files } = splitAttached(e.text);
        // Undo only for the newest message, and only once it has an id (a terminal's imported history has none).
        const uuid = e.uuid;
        const undoable = uuid !== undefined && e.n === lastUserAllN && !busy && waiting === null && can;
        return (
          <div className="flex flex-col items-end gap-1" data-turn-start={e.n === lastUserN ? "" : undefined}>
            <div className="max-w-[70%] break-words whitespace-pre-wrap rounded-[20px] bg-surface-bubble px-[18px] py-[10px] text-base leading-6 text-text-primary max-md:text-base">
              {body}
              {files.length > 0 ? (
                <ul className="mt-1 flex flex-wrap gap-1.5 whitespace-normal">
                  {files.map((name, i) => (
                    <li key={i} className="flex max-w-full items-center gap-1 rounded-lg bg-surface-raised px-2 py-0.5 text-sm text-text-secondary">
                      <Paperclip size={12} aria-hidden="true" className="shrink-0" />
                      <span className="truncate">{name}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            {undoable ? (
              <Button
                variant="quiet"
                size="sm"
                className="text-sm text-text-secondary"
                disabled={rewindBusy}
                onClick={() => {
                  if (uuid) void previewUndo(uuid);
                }}
              >
                <ArrowCounterClockwise size={14} aria-hidden="true" />
                {"Undo this message's changes"}
              </Button>
            ) : null}
          </div>
        );
      }
      case "assistant":
        return <Prose text={e.text} />;
      case "ask": {
        const answered = answers.get(e.requestId);
        if (answered !== undefined) return <AnsweredAsk e={e} allowed={answered} />;
        if (pendingAsk?.requestId !== e.requestId) {
          // The newest question, with nothing said after it, can be asked again: the server restart lost the process that was waiting.
          const latestAskN = Math.max(0, ...events.filter((x) => x.kind === "ask").map((x) => x.n));
          const repeatable = e.n === latestAskN && !events.some((x) => x.kind === "user" && x.n > e.n) && !busy && waiting === null && can;
          return (
            <div className="flex flex-col items-start gap-3">
              <p className="text-small text-text-muted">Kohlab restarted before you answered, so Claude stopped here.</p>
              {repeatable ? (
                <Button variant="secondary" disabled={sending} onClick={() => void sendText("Please carry on with what you were doing.")}>
                  Ask Claude again
                </Button>
              ) : null}
            </div>
          );
        }
        return (
          <section aria-label="Claude is asking" className="rounded-card bg-surface-raised px-5 py-[18px]">
            <p className="text-base font-semibold text-text-primary">{e.text}</p>
            {e.why ? <p className="mt-1 text-small leading-5 text-text-muted">{e.why}</p> : null}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {can ? (
                <>
                  <Button
                    variant="primary"
                    disabled={answering !== null}
                    onClick={() => void answer(e.requestId, true)}
                  >
                    Allow
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={answering !== null}
                    onClick={() => void answer(e.requestId, false)}
                  >
                    {"Don't allow"}
                  </Button>
                </>
              ) : (
                <p className="text-small text-text-muted">Waiting for an answer.</p>
              )}
              {e.detail ? <Details className="ml-auto" detail={e.detail} /> : null}
            </div>
          </section>
        );
      }
      case "error":
        return (
          <p className="flex items-center gap-1.5 text-sm text-status-danger">
            <Warning size={12} aria-hidden="true" />
            {e.text}
          </p>
        );
      default:
        return null;
    }
  };

  // The composer's chips show the CLI's current choices. Effort lives in the model menu, and only when the model supports it.
  // The snapshot names the model in full (claude-haiku-5-5); the menu lists it by alias (haiku). Both match by the display name.
  // Until the snapshot arrives, the project's stored model shows and the mode reads "…".
  const modelInfo = model === null ? undefined : models.find((m) => m.value === model || m.displayName === modelName(model));
  const levels = modelInfo?.supportedEffortLevels ?? [];
  const storedModel = modelOf(ws ?? undefined);
  const modelText = modelInfo?.displayName ?? (model ? modelName(model) : storedModel === "default" ? "Default" : MODEL_LABEL[storedModel]);
  const effortText = effort ? (EFFORT_LABEL[effort] ?? effort) : "Default";
  const modeText = mode === null ? "Mode" : (MODES[mode]?.label ?? mode);

  const placeholder =
    waiting !== null
      ? "Claude is waiting for your answer above"
      : busy
        ? "Claude is working…"
        : isPhone()
          ? "Message Claude"
          : commandsEnabled ? "Message Claude — / for commands, @ for files" : "Message Claude — @ for files";
  // Stop is the round button only while busy with nothing typed; with text, Send queues it and a quiet Stop sits beside it.
  const hasDraft = draft.trim() !== "" || attachments.length > 0;

  return (
    <div className="flex h-full min-h-0" style={keyboard ? { paddingBottom: keyboard } : undefined}>
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} onScroll={onScroll} className="absolute inset-0 overflow-y-auto overscroll-contain">
            <div
              role="log"
              aria-live="polite"
              aria-label="Conversation with Claude"
              className={cn(
                "flex w-full flex-col gap-6 px-4 pt-6 pb-8 max-md:gap-5 max-md:pt-4 max-md:pb-4",
                compact ? "pt-4" : "mx-auto max-w-[720px] shell:px-6",
              )}
            >
              {events.length === 0 && !busy ? (
                <div className="flex flex-col items-center gap-2 px-2 pt-[18vh] text-center">
                  <h2 className="text-xl font-semibold text-text-primary">What should Claude build?</h2>
                  <p className="text-base text-text-muted">Describe it in your own words. Claude will ask before changing anything important.</p>
                </div>
              ) : null}
              {turns.map((turn, ti) => {
                // Everything Claude wrote in this turn, as its markdown source, for Copy.
                // Only Claude text that is actually shown earns a Copy: a blank reply under a question has nothing to copy.
                const replies = turn.flat().flatMap((e) => (e.kind === "assistant" && e.text.trim() !== "" ? [e.text] : []));
                return (
                  <div key={turn[0][0].n} className="group flex min-w-0 flex-col gap-3">
                    {turn.map((row) => (
                      <Fragment key={row[0].n}>
                        {row[0].kind === "tool" ? (
                          <ToolRun lines={row} />
                        ) : row.length > 1 ? (
                          <AnsweredGroup events={row} answers={answers} />
                        ) : (
                          renderEvent(row[0])
                        )}
                        {row[0].n === events.at(-1)?.n && row[0].kind === "error" && !busy && can && lastRequest ? (
                          <div>
                            <Button variant="secondary" disabled={sending} onClick={() => void sendText(lastRequest)}>
                              Try again
                            </Button>
                          </div>
                        ) : null}
                      </Fragment>
                    ))}
                    {/* Copy only under a finished reply that ends in text: not mid-turn, not under a tool run. */}
                    {replies.length > 0 && !(busy && ti === turns.length - 1) && turn[turn.length - 1][0].kind === "assistant" ? (
                      <CopyReply text={replies.join("\n\n")} latest={ti === turns.length - 1} />
                    ) : null}
                  </div>
                );
              })}
              {busy && streamed ? (
                // aria-live off: the reply is announced once, when its assistant message arrives.
                <div aria-live="off">
                  <Prose text={streamed} />
                </div>
              ) : null}
              {!compact && !busy && hasChanges && can ? (
            <div role="region" aria-label="Changes to check" className="flex flex-col gap-3">
              <p className="text-small text-text-muted">
                {changed === null ? "Changes to check" : `Changed ${changed} ${changed === 1 ? "file" : "files"}`}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button variant="primary" className="max-md:px-3" disabled={keeping} onClick={() => void keep()}>
                  <Check size={16} className="max-md:hidden" aria-hidden="true" />
                  Keep this version
                </Button>
                {previewOpen ? null : (
                  <Button variant="secondary" className="max-md:px-3" disabled={previewing} onClick={onPreview}>
                    <Browser size={16} className="max-md:hidden" aria-hidden="true" />
                    Preview
                  </Button>
                )}
                <Button variant="quiet" className="text-text-secondary max-md:px-2.5" disabled={undoing} onClick={() => setConfirmUndo(true)}>
                  <ArrowCounterClockwise size={16} aria-hidden="true" />
                  Undo all since last keep
                </Button>
              </div>
            </div>
              ) : null}
              {working ? (
                <WorkingLine action={currentAction} since={busySince} background={background} tasksOpen={tasksOpen} onTasks={() => setTasksOpen((o) => !o)} />
              ) : null}
              {!busy && background > 0 ? (
                <button
                  type="button"
                  aria-expanded={tasksOpen}
                  onClick={() => setTasksOpen((o) => !o)}
                  className="flex min-h-11 items-center gap-2 rounded-lg px-1 text-left text-small text-text-muted hover:bg-surface-hover hover:text-text-primary shell:min-h-8"
                >
                  <span className="pulse-dot size-1.5 shrink-0 rounded-full bg-text-muted" aria-hidden="true" />
                  {background === 1 ? "1 task still running in the background" : `${background} tasks still running in the background`}
                </button>
              ) : null}
              {tasksOpen && background > 0 ? <TaskList tasks={tasks} stopping={stopping} onStop={(id) => void stopTask(id)} /> : null}
            </div>
          </div>
          {/* A subtle fade under the tab bar, so scrolled text does not hit the edge. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-[linear-gradient(var(--surface-base),transparent)]" />
          {/* The same fade above the composer, on phones. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-6 bg-[linear-gradient(transparent,var(--surface-base))] max-md:block" />
        </div>
        {/* Outside the scroll area, so the button never covers prose. */}
        {farFromEnd ? (
          <div className={cn("flex shrink-0 justify-center px-3 pt-2", !compact && "mx-auto w-full max-w-[720px]")}>
            <Button variant="secondary" iconOnly aria-label="Scroll to latest" title="Scroll to latest" onClick={scrollToLatest}>
              <ArrowDown size={18} aria-hidden="true" />
            </Button>
          </div>
        ) : null}

        {can ? (
          <div className="shrink-0 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-md:pb-[max(12px,var(--safe-bottom,env(safe-area-inset-bottom)))] shell:px-6">
            <div className={compact ? "w-full" : "mx-auto w-full max-w-[720px]"}>
              {sendError ? (
                <p role="alert" className="mb-2 text-sm text-status-danger">
                  {sendError}
                </p>
              ) : null}

              {attachNote ? (
                <p role="alert" className="mb-2 text-sm text-status-danger">
                  {attachNote}
                </p>
              ) : null}

              {terminalProject && terminalOpen && !busy && waiting === null ? (
                <p className="mb-2 text-xs text-text-muted">
                  Sending from here closes Claude's terminal screen. The conversation carries on here, and in Terminal when you switch back.
                </p>
              ) : null}
              {slashOn ? (
                <PickList
                  id="slash-menu"
                  label="Commands"
                  active={slashActive}
                  onPick={(i) => pickCommand(slashMatches[i])}
                  options={slashMatches.map((c) => ({
                    key: c.name,
                    title: (
                      <>
                        <span className="font-medium">/{c.name}</span>
                        {c.argumentHint ? <span className="text-text-faint"> {c.argumentHint}</span> : null}
                      </>
                    ),
                    detail: c.description || undefined,
                  }))}
                />
              ) : null}
              {slashLoading ? (
                <div role="status" className="menu mb-2 px-2.5 py-2 text-sm text-text-muted">
                  Loading commands…
                </div>
              ) : null}
              {mentionOn ? (
                <PickList
                  id="mention-menu"
                  label="Files"
                  active={mentionActive}
                  onPick={(i) => pickFile(mentionFiles[i])}
                  options={mentionFiles.map((p) => ({ key: p, title: p }))}
                />
              ) : null}

              <Composer
                ariaLabel="Message Claude"
                textareaRef={taRef}
                value={draft}
                onChange={(v) => {
                  setDraft(v);
                  setSlashIndex(0);
                  setSlashShut(false);
                  setMentionShut(false);
                }}
                placeholder={placeholder}
                disabled={waiting !== null}
                textareaAria={{
                  "aria-autocomplete": "list",
                  "aria-expanded": slashOn || mentionOn,
                  "aria-controls": slashOn ? "slash-menu" : mentionOn ? "mention-menu" : undefined,
                  "aria-activedescendant": slashOn ? `slash-menu-opt-${slashActive}` : mentionOn ? `mention-menu-opt-${mentionActive}` : undefined,
                }}
                onKeyDown={onKeyDown}
                onSubmit={() => void send()}
                onPaste={(e) => {
                  if (e.clipboardData.files.length === 0) return;
                  e.preventDefault();
                  takeFiles(e.clipboardData.files, true);
                }}
                onDropFiles={(files) => takeFiles(files)}
                attachments={
                  attachments.length > 0 ? (
                    <ul aria-label="Files to send" className="flex flex-wrap gap-1.5 pt-1">
                      {attachments.map((a) => (
                        <li key={a.key} className="flex max-w-full items-center gap-2 rounded-xl bg-surface-active py-1 pr-1 pl-1.5 text-sm text-text-secondary">
                          {a.url ? (
                            <img src={a.url} alt="" className="size-8 shrink-0 rounded-md object-cover" />
                          ) : (
                            <Paperclip size={14} aria-hidden="true" className="shrink-0" />
                          )}
                          <span className="min-w-0 truncate">{a.file.name}</span>
                          <button
                            type="button"
                            aria-label={`Remove ${a.file.name}`}
                            disabled={uploading}
                            onClick={() => removeAttachment(a.key)}
                            className="flex size-8 shrink-0 items-center justify-center rounded-full text-text-muted hover:text-text-primary max-md:size-11 disabled:opacity-40"
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null
                }
                leading={
                  <>
                    <input
                      ref={fileRef}
                      type="file"
                      multiple
                      aria-label="Add files"
                      className="hidden"
                      onChange={(e) => {
                        takeFiles(e.target.files ?? []);
                        e.target.value = "";
                      }}
                    />
                    <ComposerChip
                      iconOnly
                      aria-label="Add files"
                      title="Add files"
                      icon={<Paperclip size={14} aria-hidden="true" />}
                      disabled={waiting !== null || sending || uploading}
                      onClick={() => fileRef.current?.click()}
                    />
                    {commandsEnabled ? (
                    <ComposerChip
                      label="Commands"
                      className="max-md:hidden"
                      aria-label="Commands"
                      title={commands.length === 0 ? "Commands load when Claude starts" : undefined}
                      disabled={commands.length === 0}
                      onClick={openCommands}
                    />
                    ) : null}
                    <Menu
                      side="top"
                      align="start"
                      label={`Model: ${modelText}`}
                      trigger={
                        <ComposerChip
                          className="max-w-48 shrink-0"
                          label={modelText}
                          menu
                          disabled={models.length === 0}
                          title={models.length === 0 ? "Models load when Claude starts" : undefined}
                        />
                      }
                    >
                      <MenuRadioGroup value={modelInfo?.value ?? ""} onValueChange={(v) => void pick("model", v, model, setModel)}>
                        {models.map((m) => (
                          <MenuRadioItem key={m.value} value={m.value}>
                            <span className="block">{m.displayName}</span>
                            {m.description ? <span className="block text-xs text-text-muted">{m.description}</span> : null}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                      {levels.length > 0 ? (
                        <>
                          <MenuSeparator />
                          <MenuLabel>{`Effort: ${effortText}`}</MenuLabel>
                          <MenuRadioGroup value={effort ?? ""} onValueChange={(v) => void pick("effort", v, effort, setEffort)}>
                            {levels.map((l) => (
                              <MenuRadioItem key={l} value={l}>
                                {EFFORT_LABEL[l] ?? l}
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                        </>
                      ) : null}
                    </Menu>
                    <Menu
                      side="top"
                      align="start"
                      label={`Mode: ${modeText}`}
                      trigger={<ComposerChip className="max-w-48 shrink-0" label={modeText} menu />}
                    >
                      <MenuRadioGroup value={mode ?? ""} onValueChange={(v) => void pick("mode", v, mode, setMode)}>
                        {MODE_CHOICES.map((value) => (
                          <MenuRadioItem key={value} value={value}>
                            <span className="block">{MODES[value].label}</span>
                            <span className="block text-xs text-text-muted">{MODES[value].detail}</span>
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </Menu>
                  </>
                }
                trailing={
                  <>
                    {usage?.context && usage.context.percent >= 50 ? (
                      <ComposerChip
                        label={usage.context.percent >= 85 ? "Chat almost full" : `Chat ${usage.context.percent}% full`}
                        popoverTarget="context-popover"
                      />
                    ) : null}
                    {working && hasDraft ? (
                      <ComposerChip
                        className="shrink-0 max-md:w-[var(--control-h-sm)] max-md:justify-center max-md:px-0"
                        icon={<Stop size={14} aria-hidden="true" />}
                        label="Stop"
                        hideLabelOnPhone
                        aria-label="Stop Claude"
                        title="Stop"
                        onClick={() => void stop()}
                      />
                    ) : null}
                    {working && !hasDraft ? (
                      <Button variant="secondary" iconOnly aria-label="Stop Claude" title="Stop Claude" onClick={() => void stop()}>
                        <Stop size={16} aria-hidden="true" />
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        iconOnly
                        aria-label="Send"
                        title={busy ? "Send (queued until Claude is ready)" : "Send"}
                        disabled={waiting !== null || sending || uploading || !hasDraft}
                        onClick={() => void send()}
                      >
                        <ArrowUp size={18} aria-hidden="true" />
                      </Button>
                    )}
                  </>
                }
              />
            </div>
          </div>
        ) : null}

        {/* Native popover: Esc and an outside click close it, no modal. Placed above the chip when it opens. */}
        <div
          id="context-popover"
          popover="auto"
          aria-label="How full this chat is"
          className="menu m-0 inset-auto h-fit w-80 max-w-[calc(100vw-1rem)] p-4"
          onToggle={(e) => {
            const pop = e.currentTarget;
            const chip = document.querySelector<HTMLElement>('[popovertarget="context-popover"]');
            if ((e.nativeEvent as ToggleEvent).newState !== "open" || !chip) return;
            const r = chip.getBoundingClientRect();
            pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8))}px`;
            pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 8)}px`;
          }}
        >
          <p className="text-base font-semibold text-text-primary">How full this chat is</p>
          <p className="mt-1 text-sm leading-5 text-text-muted">
            Long chats get summarised automatically. Start a fresh project chat for a new task.
          </p>
          {usage ? (
            <div className="mt-3">
              <UsagePanel usage={usage} />
            </div>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={rewindPlan !== null}
        onOpenChange={(v) => {
          if (!v) setRewindPlan(null);
        }}
        title="Undo these changes?"
        description={
          rewindPlan
            ? `Claude changed ${rewindPlan.files.length} ${rewindPlan.files.length === 1 ? "file" : "files"} since that message. They go back to how they were before it.`
            : ""
        }
        details={
          rewindPlan ? (
            <>
              <ul className="mono flex flex-col gap-0.5 break-all">
                {rewindPlan.files.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <p className="mt-1">
                {rewindPlan.insertions} lines added, {rewindPlan.deletions} removed
              </p>
            </>
          ) : null
        }
        confirmLabel="Undo"
        tone="danger"
        busy={rewindBusy}
        onConfirm={() => void confirmRewind()}
      />
      <ConfirmDialog
        open={confirmUndo}
        onOpenChange={(v) => {
          if (!v) setConfirmUndo(false);
        }}
        title="Undo the changes?"
        description="Everything Claude changed since you last pressed Keep will be removed. This can't be reversed."
        confirmLabel="Undo"
        tone="danger"
        busy={undoing}
        onConfirm={() => void undo()}
      />
    </div>
  );
}
