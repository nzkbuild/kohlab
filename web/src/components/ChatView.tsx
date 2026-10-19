import { Fragment, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { ArrowCounterClockwise, ArrowDown, ArrowUp, Browser, CaretRight, Check, CheckCircle, Circle, Copy, FastForward, Paperclip, Stop, Warning, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, type ChatUsage, type ChatUsageWindow } from "../api";
import type { ChatEvent as StoredChatEvent, TurnFile } from "../types";
import { announce } from "../lib/announce";
import { splitAttached, pastedName, safeAttachName, withSuffix } from "../lib/attach";
import { parsePatch, type PatchLine } from "../lib/diff";
import { BIG_PASTE, DRAFT_SAVE_MS, addSaved, readDraft, writeDraft } from "../lib/drafts";
import { isApple } from "../lib/platform";
import { copyText } from "../lib/clipboard";
import { findWorkspace, useApp, useCan } from "../store";
import { workspaceStatus } from "../lib/status";
import { inline, parseBlocks, type Inline } from "../lib/markdown";
import { cn } from "../lib/utils";
import { isPhone } from "../lib/viewport";
import { MODEL_LABEL, modelOf } from "../lib/projectActions";
import { agentName } from "../lib/agentName";
import ConfirmDialog from "./ConfirmDialog";
import { Composer, SaveLaterChip, SavedChip } from "./Composer";
import { AgentChip, useNewAgent } from "./WorkspacesView";
import { Button, ComposerChip, Dialog, Menu, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, Tooltip } from "./ui";

/** An event as chat.ts writes it. `why` is the AI's one-line reason for a command (on ask events). */
type ChatEvent = StoredChatEvent & { why?: string };
type ToolEvent = Extract<ChatEvent, { kind: "tool" }>;
type ToolResult = { output: string; failed?: boolean };
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

/** Claude's checklist (its TodoWrite list): one row with the count and the active item, the full list when opened. */
type Todo = { text: string; status: "pending" | "active" | "done" };
function Checklist({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(false);
  const done = todos.filter((t) => t.status === "done").length;
  const active = todos.find((t) => t.status === "active");
  return (
    <div className="rounded-card bg-surface-raised px-4 py-2.5 text-sm">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full min-w-0 items-center gap-2 text-left text-text-secondary">
        <span className="shrink-0 tabular-nums">{done} of {todos.length} done</span>
        {active ? <span className="min-w-0 flex-1 truncate text-text-primary">{active.text}</span> : <span className="flex-1" />}
        <CaretRight size={14} aria-hidden="true" className={cn("shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <ul aria-label="Checklist" className="mt-2 flex flex-col gap-1.5">
          {todos.map((t, i) => (
            <li
              key={i}
              className={cn(
                "flex min-w-0 items-center gap-2",
                t.status === "done" ? "text-text-muted line-through" : t.status === "active" ? "font-medium text-text-primary" : "text-text-muted",
              )}
            >
              {t.status === "done" ? (
                <CheckCircle size={16} className="shrink-0" aria-hidden="true" />
              ) : t.status === "active" ? (
                <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
                  <span className="size-2 rounded-full bg-text-primary motion-safe:animate-pulse" />
                </span>
              ) : (
                <Circle size={16} className="shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 truncate">{t.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The helpers Claude has running (its sub-agents), by label. Opened from the "helpers working" text. */
function HelperList({ helpers }: { helpers: string[] }) {
  return (
    <ul aria-label="Helpers" className="flex flex-col gap-1 pl-5 text-sm text-text-muted">
      {helpers.map((h, i) => (
        <li key={i} className="min-w-0 truncate">
          Helper: {h}
        </li>
      ))}
    </ul>
  );
}

/** The working line: a pulsing dot, the current action, how long the turn has run, helpers working and background tasks (buttons that open their lists). The timer ticks only while this line is shown. */
function WorkingLine({
  action,
  since,
  background,
  tasksOpen,
  onTasks,
  helpers,
  helpersOpen,
  onHelpers,
}: {
  action: string;
  since: number | null;
  background: number;
  tasksOpen: boolean;
  onTasks: () => void;
  helpers: string[];
  helpersOpen: boolean;
  onHelpers: () => void;
}) {
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
      {helpers.length > 0 ? (
        <button type="button" aria-expanded={helpersOpen} onClick={onHelpers} className="rounded px-1 hover:bg-surface-hover hover:text-text-primary">
          · {helpers.length} {helpers.length === 1 ? "helper" : "helpers"} working
        </button>
      ) : null}
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
      case "image":
        return <ProjectImage key={i} path={node.src} alt={node.alt} />;
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

/** The workspace the reply's project pictures come from. Provided once, where the event list is drawn. */
const WorkspaceCtx = createContext<string>("");
/** The agent's name as a person sees it ("Claude"), for the parts of the chat that speak for it. */
const AgentCtx = createContext<string>("Claude");

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The app follows the system's light or dark (index.css), so a picture asks for the same. */
const systemScheme = (): "light" | "dark" => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

/** A short id from the block's text. The same block always gets the same id, so its page can be reused; two frames never mix, since messages are also checked against their own window. */
const frameId = (text: string) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/** Where each picture page is kept, by workspace and page. The server keeps a page for an hour from its last use, so an entry is refetched after 50 minutes. */
const pictureUrls = new Map<string, { url: Promise<string>; at: number }>();
function pictureUrl(workspaceId: string, doc: string): Promise<string> {
  const key = `${workspaceId}\n${doc}`;
  const hit = pictureUrls.get(key);
  if (hit && Date.now() - hit.at < 50 * 60 * 1000) return hit.url;
  const url = api.picture(workspaceId, doc).then(
    (r) => r.url,
    (e: unknown) => {
      pictureUrls.delete(key);
      throw e;
    },
  );
  if (pictureUrls.size >= 100) pictureUrls.delete(pictureUrls.keys().next().value as string);
  pictureUrls.set(key, { url, at: Date.now() });
  return url;
}

/** Posts the page's height to the chat as it changes. */
const reportHeight = (id: string) =>
  `<script>new ResizeObserver(()=>parent.postMessage({kohlabFrame:"${id}",h:document.documentElement.scrollHeight},"*")).observe(document.documentElement)</script>`;

/** A picture's page: the reply's own HTML, with the theme and the height reporter around it. */
function pictureDoc(code: string, id: string, scheme: string): string {
  const head = `<meta name="color-scheme" content="light dark"><base target="_blank"><style>html{color-scheme:${scheme}}body{margin:0;font-family:system-ui,sans-serif}</style>`;
  // A doctype has to stay first, or the browser renders the page in quirks mode.
  const at = /^\s*<!doctype[^>]*>/i.exec(code)?.[0].length ?? 0;
  return code.slice(0, at) + head + code.slice(at) + reportHeight(id);
}

/** A diagram's page: mermaid draws the source. If it cannot, the frame tells the chat, which then shows the code. */
function diagramDoc(code: string, id: string, scheme: string): string {
  const theme = scheme === "dark" ? "dark" : "default";
  return (
    `<!doctype html><html><head><meta name="color-scheme" content="light dark"><base target="_blank">` +
    `<style>html{color-scheme:${scheme}}body{margin:0;font-family:system-ui,sans-serif}.mermaid{display:flex;justify-content:center}</style></head><body>` +
    `<pre class="mermaid">${escapeHtml(code)}</pre>` +
    `<script type="module">try{const m=(await import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs")).default;` +
    `m.initialize({startOnLoad:false,securityLevel:"strict",theme:"${theme}"});await m.run();}` +
    `catch(e){parent.postMessage({kohlabFrame:"${id}",failed:true},"*")}</script>` +
    reportHeight(id) +
    `</body></html>`
  );
}

/** A finished html or mermaid block, drawn live in a sandboxed frame (no same-origin, no top navigation). Its toolbar shows the code, copies it, or opens it full screen. */
function HtmlFrame({ kind, code }: { kind: "html" | "mermaid"; code: string }) {
  const who = useContext(AgentCtx);
  const workspaceId = useContext(WorkspaceCtx);
  const id = useMemo(() => frameId(kind + code), [kind, code]);
  const [showCode, setShowCode] = useState(false);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(320);
  const [full, setFull] = useState(false);
  const [copied, copy] = useCopied();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const label = kind === "html" ? "Picture" : "Diagram";
  const doc = useMemo(() => {
    const scheme = systemScheme();
    return kind === "html" ? pictureDoc(code, id, scheme) : diagramDoc(code, id, scheme);
  }, [kind, code, id]);
  // The page is kept on the server and framed from its own URL: the app's CSP would block its scripts as srcDoc.
  const [src, setSrc] = useState<string | null>(null);
  const [unshown, setUnshown] = useState(false);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    setUnshown(false);
    pictureUrl(workspaceId, doc).then(
      (u) => alive && setSrc(u),
      () => alive && setUnshown(true),
    );
    return () => {
      alive = false;
    };
  }, [workspaceId, doc]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { kohlabFrame?: unknown; h?: unknown; failed?: unknown } | null;
      if (!data || data.kohlabFrame !== id) return;
      if (data.failed === true) setFailed(true);
      else if (typeof data.h === "number") setHeight(Math.min(720, Math.max(120, data.h)));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id]);

  if (failed) {
    return (
      <>
        <p className="text-small text-text-muted">Couldn&apos;t draw this diagram.</p>
        <CodeBlock lang={kind} code={code} />
      </>
    );
  }
  if (unshown) {
    return (
      <>
        <p className="text-small text-text-muted">Couldn&apos;t show this picture.</p>
        <CodeBlock lang={kind} code={code} />
      </>
    );
  }

  // Empty at its height until the page has its URL.
  const frame = (h: number | string, ref?: Ref<HTMLIFrameElement>) =>
    src === null ? (
      <div aria-hidden="true" style={{ height: h }} />
    ) : (
      <iframe
        ref={ref}
        title={kind === "html" ? `Picture from ${who}` : `Diagram from ${who}`}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        src={src}
        referrerPolicy="no-referrer"
        loading="lazy"
        style={{ height: h }}
        className="block w-full border-0"
      />
    );

  return (
    <div className="overflow-hidden rounded-card bg-surface-sunken">
      <div className="flex items-center justify-between gap-3 py-0.5 pr-1 pl-3.5">
        <span className="min-w-0 truncate text-xs text-text-muted">{label}</span>
        <div className="flex shrink-0 items-center">
          <Button variant="quiet" size="sm" className="text-xs text-text-secondary" onClick={() => setShowCode((s) => !s)}>
            {showCode ? "Show picture" : "Show code"}
          </Button>
          <Button variant="quiet" size="sm" className="text-xs text-text-secondary" onClick={() => void copy(code)}>
            {copied ? "Copied" : "Copy"}
          </Button>
          {showCode ? null : (
            <Button variant="quiet" size="sm" className="text-xs text-text-secondary" onClick={() => setFull(true)}>
              Full screen
            </Button>
          )}
        </div>
      </div>
      {showCode ? (
        <pre className="mono overflow-x-auto px-3.5 py-3 text-sm leading-5 text-text-primary">
          <code>{code}</code>
        </pre>
      ) : (
        frame(height, frameRef)
      )}
      <Dialog.Root open={full} onOpenChange={setFull}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content aria-describedby={undefined} className="dialog-content w-[90vw]! max-w-[90vw]! p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <Dialog.Title className="text-sm font-semibold text-text-primary">{label}</Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="quiet" size="sm" className="text-xs text-text-secondary">
                  Close
                </Button>
              </Dialog.Close>
            </div>
            {frame("62vh")}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

const PICTURE_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
]);

/** The picture's MIME type from its extension, or null when it is not a picture file. */
function pictureType(path: string): string | null {
  const ext = /\.([^./\\]+)$/.exec(path)?.[1].toLowerCase();
  return ext ? (PICTURE_TYPES.get(ext) ?? null) : null;
}

/** The picture fit to the screen, with a Download and a Close. Escape closes it (Radix). */
function ImageViewer({ url, alt, name, open, onOpenChange }: { url: string; alt: string; name: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content aria-describedby={undefined} className="dialog-content flex w-auto! max-w-[92vw]! flex-col items-center gap-3 p-3">
          <Dialog.Title className="sr-only">{alt}</Dialog.Title>
          <img src={url} alt={alt} className="max-h-[60vh] max-w-[92vw] object-contain" />
          <div className="flex w-full items-center justify-end gap-2">
            <a href={url} download={name} className="btn btn-quiet btn-sm text-xs text-text-secondary">
              Download
            </a>
            <Dialog.Close asChild>
              <Button variant="quiet" size="sm" className="text-xs text-text-secondary">
                Close
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A picture from the project, loaded through the API. A thumbnail opens the viewer. */
function ProjectImage({ path, alt, thumbClass = "max-h-48" }: { path: string; alt: string; thumbClass?: string }) {
  const workspaceId = useContext(WorkspaceCtx);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const name = path.split("/").pop() ?? path;
  const shown = alt || name;

  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    setUrl(null);
    setFailed(false);
    const type = pictureType(path) ?? "application/octet-stream";
    api
      .rawBlob(workspaceId, path)
      .then((blob) => {
        if (cancelled) return;
        made = URL.createObjectURL(new Blob([blob], { type }));
        setUrl(made);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [workspaceId, path]);

  if (failed) return <span className="text-small text-text-muted">Picture not found: {path}</span>;
  if (url === null) return <span aria-hidden="true" className="block h-24 w-40 rounded-card bg-surface-sunken" />;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block max-w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        <img src={url} alt={shown} className={cn("block max-w-full rounded-card object-contain", thumbClass)} />
      </button>
      <ImageViewer url={url} alt={shown} name={name} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** What Claude said, in a measure a person can read without losing their place. A finished html or mermaid block is drawn, unless the reply is still streaming. */
function Prose({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="flex max-w-[66ch] min-w-0 flex-col gap-3 text-base leading-6 text-text-primary max-md:max-w-none max-md:w-full max-md:text-base">
      {parseBlocks(text).map((block, i) => {
        if (block.kind === "p") return <p key={i} className="whitespace-pre-line">{rich(block.lines.join("\n"))}</p>;
        if (block.kind === "h") return <p key={i} className="text-lg font-semibold text-text-primary">{rich(block.text)}</p>;
        if (block.kind === "hr") return <hr key={i} className="border-line-subtle" />;
        if (block.kind === "code") {
          const lang = block.lang.toLowerCase();
          if (!streaming && (lang === "html" || lang === "mermaid")) return <HtmlFrame key={i} kind={lang} code={block.code} />;
          return <CodeBlock key={i} lang={block.lang} code={block.code} />;
        }
        if (block.kind === "table") {
          return (
            <div key={i} className="overflow-x-auto rounded-card bg-surface-sunken">
              <table className="w-full border-collapse text-sm leading-5">
                <thead>
                  <tr>
                    {block.head.map((c, j) => (
                      <th key={j} scope="col" className="min-w-[8ch] px-3.5 py-2 text-left align-bottom font-semibold text-text-primary">
                        {rich(c)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((r, k) => (
                    <tr key={k} className="border-t border-line-subtle">
                      {r.map((c, j) => (
                        <td key={j} className="min-w-[8ch] px-3.5 py-2 align-top text-text-primary">
                          {rich(c)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
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
function ToolRun({ lines, results }: { lines: ChatEvent[]; results: Map<string, ToolResult> }) {
  const [open, setOpen] = useState(false);
  const tools = lines.filter((e): e is ToolEvent => e.kind === "tool");
  const failed = tools.filter((e) => e.toolId !== undefined && results.get(e.toolId)?.failed).length;
  const summary = summarizeTools(tools.map((e) => e.text)) + (failed ? `, ${failed} failed` : "");
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
            <ToolLine key={e.n} e={e} result={e.toolId !== undefined ? results.get(e.toolId) : undefined} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One action in an expanded run: its line, and on a click what it did (the command or the change) and what it gave back. A failed one says so. */
function ToolLine({ e, result }: { e: ToolEvent; result?: ToolResult }) {
  const [open, setOpen] = useState(false);
  if (!e.detail && !result?.output)
    return (
      <li className="flex items-center gap-1.5 pl-6">
        <span className="min-w-0 flex-1">{e.text}</span>
        {result?.failed ? <span className="shrink-0 text-xs font-medium text-status-danger">Failed</span> : null}
      </li>
    );
  // an edit or a new file: its "+ " and "- " lines are coloured as in the diff
  const isChange = e.text.startsWith("Edited ") || e.text.startsWith("Created ");
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center gap-1.5 rounded-lg px-1 text-left hover:bg-surface-hover hover:text-text-primary shell:min-h-8"
      >
        <CaretRight size={14} aria-hidden="true" className={cn("shrink-0 motion-safe:transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1">{e.text}</span>
        {result?.failed ? <span className="shrink-0 text-xs font-medium text-status-danger">Failed</span> : null}
      </button>
      {open ? (
        <div className="mb-1 mt-1 rounded-card bg-surface-sunken">
          {e.detail ? (
            <pre tabIndex={0} className="mono overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 text-xs text-text-secondary">
              {isChange
                ? e.detail.split("\n").map((line, i) => (
                    <Fragment key={i}>
                      {i > 0 ? "\n" : null}
                      <span className={line.startsWith("+ ") ? "text-status-running" : line.startsWith("- ") ? "text-status-danger" : undefined}>{line}</span>
                    </Fragment>
                  ))
                : e.detail}
            </pre>
          ) : null}
          {result?.output ? (
            <>
              <p className="px-3 pt-2 text-xs text-text-muted">Output</p>
              <pre tabIndex={0} className="mono overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 text-xs text-text-secondary">
                {result.output}
              </pre>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The question Claude asked, and the answer, once given: one muted line. A plan keeps its text behind "Show plan". */
function AnsweredAsk({ e, allowed, reply }: { e: AskEvent; allowed: boolean; reply?: string }) {
  const who = useContext(AgentCtx);
  const Icon = allowed ? Check : X;
  if (e.form === "question") {
    const said = allowed ? (reply ? `You answered: ${reply}` : `You answered ${who}'s question`) : `You skipped ${who}'s question`;
    return (
      <div className="text-small text-text-muted">
        <p className="flex items-start gap-1.5">
          <Icon size={14} className="mt-[5px] shrink-0" aria-hidden="true" />
          <span className="min-w-0">{said}</span>
        </p>
      </div>
    );
  }
  if (e.form === "plan") {
    const said = allowed ? "You approved the plan" : reply ? `You asked for changes: ${reply}` : "You didn't approve the plan";
    return (
      <div className="text-small text-text-muted">
        <p className="flex items-start gap-1.5">
          <Icon size={14} className="mt-[5px] shrink-0" aria-hidden="true" />
          <span className="min-w-0">{said}</span>
        </p>
        <details className="ml-5 text-sm text-text-muted">
          <summary className="flex min-h-11 cursor-pointer select-none items-center hover:text-text-primary shell:min-h-8">Show plan</summary>
          <div className="mb-2">
            <Prose text={e.plan ?? ""} />
          </div>
        </details>
      </div>
    );
  }
  // "Claude wants to create the file index.html" reads as "You allowed Claude to create index.html".
  const what = e.text.replace(/^\S+ wants to /, "").replace(/^(create|change) the file /, "$1 ");
  return (
    <div className="text-small text-text-muted">
      <p className="flex items-start gap-1.5">
        <Icon size={14} className="mt-[5px] shrink-0" aria-hidden="true" />
        <span className="min-w-0">{allowed ? `You allowed ${who} to ${what}` : `You didn't allow ${who} to ${what}`}</span>
      </p>
      {e.detail || e.why ? (
        <div className="ml-5">
          <Details detail={e.detail} why={e.why} />
        </div>
      ) : null}
    </div>
  );
}

/** Claude's multiple-choice questions: each has options to pick (one, or several) and an "Other" answer, then Send answer or Skip. */
function QuestionCard({ e, can, busy, onAnswer }: { e: AskEvent; can: boolean; busy: boolean; onAnswer: (allow: boolean, extra?: { answers?: Record<string, string> }) => void }) {
  const who = useContext(AgentCtx);
  const questions = e.questions ?? [];
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});
  // The typed "Other" text wins over the chosen options; typing and choosing replace each other.
  const valueOf = (i: number) => (typed[i] ?? "").trim() || (picked[i] ?? []).join(", ");
  const complete = questions.every((_, i) => valueOf(i) !== "");
  const choose = (i: number, label: string, multi: boolean) => {
    setTyped((t) => ({ ...t, [i]: "" }));
    setPicked((p) => {
      const cur = p[i] ?? [];
      const next = !multi ? [label] : cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
      return { ...p, [i]: next };
    });
  };
  const type = (i: number, text: string) => {
    setTyped((t) => ({ ...t, [i]: text }));
    setPicked((p) => ({ ...p, [i]: [] }));
  };
  return (
    <section aria-label={`${who} is asking`} className="rounded-card bg-surface-raised px-5 py-[18px]">
      <p className="text-base font-semibold text-text-primary">{e.text}</p>
      {can ? (
        <>
          <div className="mt-4 flex flex-col gap-5">
            {questions.map((q, i) => (
              <div key={i} className="flex flex-col gap-2">
                {q.header ? <p className="text-small text-text-muted">{q.header}</p> : null}
                <p className="text-base font-semibold text-text-primary">{q.question}</p>
                <div role="group" aria-label={q.question} className="flex flex-col gap-1">
                  {q.options.map((o, j) => {
                    const selected = (picked[i] ?? []).includes(o.label);
                    return (
                      <button
                        key={j}
                        type="button"
                        aria-pressed={selected}
                        disabled={busy}
                        onClick={() => choose(i, o.label, q.multiSelect === true)}
                        className={cn("flex w-full flex-col items-start gap-0.5 rounded-row px-3 py-2 text-left", selected ? "bg-surface-active" : "hover:bg-surface-hover")}
                      >
                        <span className="text-base text-text-primary">{o.label}</span>
                        {o.description ? <span className="text-small text-text-muted">{o.description}</span> : null}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="text"
                  className="field-input border-0 bg-surface-base focus:outline-2 focus:outline-offset-2 focus:outline-focus"
                  aria-label={`Other answer to: ${q.question}`}
                  placeholder="Other…"
                  value={typed[i] ?? ""}
                  disabled={busy}
                  onChange={(ev) => type(i, ev.target.value)}
                />
              </div>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              disabled={busy || !complete}
              onClick={() => onAnswer(true, { answers: Object.fromEntries(questions.map((q, i) => [q.question, valueOf(i)])) })}
            >
              Send answer
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => onAnswer(false)}>
              Skip
            </Button>
          </div>
        </>
      ) : (
        <p className="mt-4 text-small text-text-muted">Waiting for an answer.</p>
      )}
    </section>
  );
}

/** The plan Claude made in plan mode: read it, then build it, or ask for changes first. */
function PlanCard({ e, can, busy, onAnswer }: { e: AskEvent; can: boolean; busy: boolean; onAnswer: (allow: boolean, extra?: { message?: string }) => void }) {
  const who = useContext(AgentCtx);
  const [changing, setChanging] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <section aria-label={`${who} is asking`} className="rounded-card bg-surface-raised px-5 py-[18px]">
      <p className="text-base font-semibold text-text-primary">{`${who}'s plan`}</p>
      <div className="mt-3 max-h-[50vh] overflow-y-auto">
        <Prose text={e.plan ?? ""} />
      </div>
      {can ? (
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled={busy} onClick={() => onAnswer(true)}>
              Build it
            </Button>
            <Button variant="secondary" aria-expanded={changing} disabled={busy} onClick={() => setChanging((c) => !c)}>
              Change the plan
            </Button>
          </div>
          {changing ? (
            <div className="flex flex-col items-start gap-3">
              <label className="flex w-full flex-col gap-1.5 text-small text-text-muted">
                What should change?
                <textarea className="field-textarea border-0 bg-surface-base focus:outline-2 focus:outline-offset-2 focus:outline-focus" rows={3} value={message} disabled={busy} onChange={(ev) => setMessage(ev.target.value)} />
              </label>
              <Button variant="primary" disabled={busy || !message.trim()} onClick={() => onAnswer(false, { message: message.trim() })}>
                Send changes
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 text-small text-text-muted">Waiting for an answer.</p>
      )}
    </section>
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
                {e.text.replace(/^\S+ wants to /, "")}
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
    if (e.kind === "done" || e.kind === "answer" || e.kind === "result") continue;
    const last = rows[rows.length - 1];
    if (e.kind === "tool" && last?.[0].kind === "tool") last.push(e);
    else rows.push([e]);
  }
  return rows;
}

/** Models past this many get a search box at the top of the model menu. */
const MODEL_SEARCH_AT = 12;

/** A model's short name for the chip: the last part of its provider path ("openrouter/anthropic/claude-haiku-4.5" -> "claude-haiku-4.5"). */
const shortModel = (value: string): string => value.slice(value.lastIndexOf("/") + 1);

/** The model menu's choices. Past MODEL_SEARCH_AT models, a search box leads: it filters by name or value. ArrowDown or Tab moves into the list; Enter picks the first match. */
function ModelChoices({ models, value, onPick }: { models: ModelInfo[]; value: string; onPick: (v: string) => void }) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const search = models.length > MODEL_SEARCH_AT;
  const q = query.trim().toLowerCase();
  const shown = search && q ? models.filter((m) => `${m.displayName} ${m.value}`.toLowerCase().includes(q)) : models;
  // The menu takes focus when it opens; the search box takes it a frame later.
  useEffect(() => {
    if (!search) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [search]);
  // The first item of this menu, for the keys that move into the list.
  const firstItem = (el: HTMLElement) => el.closest<HTMLElement>('[role="menu"]')?.querySelector<HTMLElement>('[role="menuitemradio"]');
  return (
    <>
      {search ? (
        <input
          ref={searchRef}
          type="search"
          aria-label="Search models"
          placeholder="Search models"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // The menu's own keys (typeahead, arrows, Tab) would take these: the search box keeps them.
            e.stopPropagation();
            if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
              e.preventDefault();
              firstItem(e.currentTarget)?.focus();
            } else if (e.key === "Enter") {
              e.preventDefault();
              firstItem(e.currentTarget)?.click();
            }
          }}
          className="field-input mx-1 mb-1 block w-[calc(100%-0.5rem)] border-0 bg-surface-base"
        />
      ) : null}
      <div className="max-h-80 overflow-y-auto">
        <MenuRadioGroup value={value} onValueChange={onPick}>
          {shown.map((m) => (
            <MenuRadioItem key={m.value} value={m.value}>
              <span className="block">{m.displayName}</span>
              {m.description ? <span className="block text-xs text-text-muted">{m.description}</span> : null}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </div>
      {search && shown.length === 0 ? <p className="px-2.5 py-1.5 text-small text-text-muted">No model matches "{query}".</p> : null}
    </>
  );
}

/** The row under a message: what it changed, going back to before it, and a new chat from it. Quiet: shown on hover or focus, always on touch. */
function MessageActions({ onChanges, onBack, onBranch }: { onChanges: () => void; onBack: () => void; onBranch: () => void }) {
  const quiet = cn(
    "text-text-faint hover:text-text-primary [@media(pointer:coarse)]:opacity-100",
    "motion-safe:transition-opacity opacity-0 group-focus-within/msg:opacity-100 group-hover/msg:opacity-100",
  );
  return (
    <div className="flex flex-wrap justify-end gap-1">
      <Button variant="quiet" size="sm" className={quiet} onClick={onChanges}>
        What this changed
      </Button>
      <Button variant="quiet" size="sm" className={quiet} onClick={onBack}>
        Go back to here
      </Button>
      <Button variant="quiet" size="sm" className={quiet} onClick={onBranch}>
        New chat from here
      </Button>
    </div>
  );
}

const CHANGE_WORD: Record<TurnFile["status"], string> = { added: "New", deleted: "Removed", modified: "Changed" };

/** Each kind of patch line: its colour, and the mark it is shown with (the diff's + and -). */
const PATCH_LINE: Record<PatchLine["kind"], { cls: string; mark: string }> = {
  add: { cls: "text-status-running", mark: "+ " },
  del: { cls: "text-status-danger", mark: "- " },
  ctx: { cls: "text-text-secondary", mark: "  " },
  gap: { cls: "text-text-muted", mark: "" },
};

/** What one message changed: each file under its heading, then its lines. Read from the server when it opens. */
function ChangesDialog({ workspaceId, n, onOpenChange }: { workspaceId: string; n: number; onOpenChange: (open: boolean) => void }) {
  const [turn, setTurn] = useState<{ files: TurnFile[]; diff: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.chatTurn(workspaceId, n).then(
      (t) => {
        if (alive) setTurn(t);
      },
      (e: Error) => {
        if (alive) setError(e.message);
      },
    );
    return () => {
      alive = false;
    };
  }, [workspaceId, n]);
  const count = turn?.files.length ?? 0;
  const files = turn ? parsePatch(turn.diff) : [];
  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content aria-describedby={undefined} className="dialog-content flex max-h-[85vh] w-[90vw] max-w-[720px] flex-col gap-3 p-4">
          <Dialog.Title className="text-base font-semibold text-text-primary">What this changed</Dialog.Title>
          {error ? (
            <p role="alert" className="text-small text-status-danger">{`Could not read the changes: ${error}`}</p>
          ) : turn === null ? (
            <p className="text-small text-text-muted">Reading the changes…</p>
          ) : count === 0 ? (
            <p className="text-small text-text-muted">No project files changed after this message.</p>
          ) : (
            <>
              <p className="text-small text-text-muted">{`${count} ${count === 1 ? "file" : "files"} changed`}</p>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto">
                {files.map((f) => (
                  <section key={f.path} className="flex min-w-0 flex-col gap-1.5">
                    <h3 className="mono text-xs break-all text-text-secondary">
                      <span className="text-text-muted">{CHANGE_WORD[f.status]}</span> {f.path}
                    </h3>
                    {f.binary ? (
                      <p className="text-xs text-text-muted">Picture or other file changed</p>
                    ) : (
                      <pre className="mono overflow-x-auto rounded-lg bg-surface-base p-3 text-xs leading-5 whitespace-pre">
                        {f.lines.map((line, i) => (
                          <span key={i} className={cn("block", PATCH_LINE[line.kind].cls)}>
                            {`${PATCH_LINE[line.kind].mark}${line.text}` || " "}
                          </span>
                        ))}
                      </pre>
                    )}
                  </section>
                ))}
              </div>
            </>
          )}
          <div className="flex justify-end">
            <Dialog.Close asChild>
              <Button variant="secondary">Close</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default function ChatView({ workspaceId, onPreview, previewing = false, previewOpen = false, onTurnEnd, compact = false, terminalProject = false }: Props) {
  const refresh = useApp((s) => s.refresh);
  const workspaces = useApp((s) => s.workspaces);
  const can = useCan().mutate;
  // The agent this chat talks to. Claude's own features (Undo, background tasks, usage, mode, effort) show only for Claude.
  const agent = findWorkspace(workspaces, workspaceId)?.agent ?? "claude";
  const who = agentName(agent);
  const isClaude = agent === "claude";
  // The AIs this chat can switch to: Claude, and the ACP agents the server reports installed.
  const agentOptions = useNewAgent().options;
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [busy, setBusy] = useState(false);
  // When the current turn started (ms), whoever started it; background tasks still running; the model and mode the CLI reports.
  const [busySince, setBusySince] = useState<number | null>(null);
  const [tasks, setTasks] = useState<BgTask[]>([]);
  const background = isClaude ? tasks.length : 0;
  const [tasksOpen, setTasksOpen] = useState(false);
  // Claude's checklist (its TodoWrite list), and the helper agents it has running, by label.
  const [todos, setTodos] = useState<Todo[]>([]);
  const [helpers, setHelpers] = useState<string[]>([]);
  const [helpersOpen, setHelpersOpen] = useState(false);
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
  // The unsent text: restored for this chat, saved 300 ms after the last key.
  const [draft, setDraft] = useState(() => readDraft(workspaceId));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    const t = window.setTimeout(() => writeDraft(workspaceId, draft), DRAFT_SAVE_MS);
    return () => window.clearTimeout(t);
  }, [draft, workspaceId]);
  // Leaving the chat keeps what was typed, even inside that 300 ms.
  useEffect(() => () => writeDraft(workspaceId, draftRef.current), [workspaceId]);
  // Set by Ctrl/Cmd+Shift+V: the next paste is text, however big.
  const plainPaste = useRef(false);
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
        // an older server sends no checklist or helpers
        setTodos(res.todos ?? []);
        setHelpers(res.helpers ?? []);
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
  // The helper list closes itself when the last helper is gone.
  useEffect(() => {
    if (helpers.length === 0) setHelpersOpen(false);
  }, [helpers.length]);

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

  // What the person wrote back to a question or plan card, by request id.
  const replies = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) if (e.kind === "answer" && e.reply) m.set(e.requestId, e.reply);
    return m;
  }, [events]);

  // What each tool line gave back, by tool id: its output, and whether it failed.
  const results = useMemo(() => {
    const m = new Map<string, { output: string; failed?: boolean }>();
    for (const e of events) if (e.kind === "result") m.set(e.toolId, { output: e.output, failed: e.failed });
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
    // A question or plan card is never merged: it reads on its own.
    const isAnswered = (row: ChatEvent[]) => row.length === 1 && row[0].kind === "ask" && !row[0].form && answers.has(row[0].requestId);
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
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v") {
      plainPaste.current = true;
      window.setTimeout(() => {
        plainPaste.current = false;
      }, 1000);
    }
    // Ctrl/Cmd+Enter while the AI works: stop it and send this message now.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && working && draft.trim() !== "" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void sendNow();
      return;
    }
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

  const answer = async (requestId: string, allow: boolean, extra?: { answers?: Record<string, string>; message?: string }) => {
    setAnswering(requestId);
    try {
      await api.chatAnswer(workspaceId, requestId, allow, extra);
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
      announce(`${who} stopped`);
    } catch {
      announce(`${who} could not stop`);
    } finally {
      repoll();
    }
  };

  const busyRef = useRef(busy);
  busyRef.current = busy;
  /** Send now: stop the turn, wait for it to end (10 s at most), then send. The server would queue it anyway after the timeout. */
  const sendingNow = useRef(false);
  const sendNow = async () => {
    const text = draft.trim();
    if (text === "" || sendingNow.current) return;
    sendingNow.current = true;
    try {
      await stop();
      const until = Date.now() + 10_000;
      while (busyRef.current && Date.now() < until) await new Promise((r) => window.setTimeout(r, 200));
      // The box changed meanwhile (Enter queued it, or it was edited): this send is stale, drop it.
      if (draftRef.current.trim() !== text) return;
      await send();
    } finally {
      sendingNow.current = false;
    }
  };

  /** Ctrl/Cmd+S and the Save button: the text goes to the saved list and the box clears. */
  const saveForLater = () => {
    const text = draft.trim();
    if (text === "") return;
    addSaved(text);
    setDraft("");
    announce("Saved for later");
    taRef.current?.focus();
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

  /** Switches the chat's AI. Reversible, so no confirmation: the conversation stays, and the new AI gets what it missed with the next message. */
  const switchAgent = async (value: string) => {
    try {
      await api.chatControl(workspaceId, "agent", value);
      await refresh();
    } catch (e) {
      toast.error(`Could not switch, ${(e as Error).message}`);
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

  /** The message whose changes are shown, and the message the person is asked to go back to. */
  const [changesOf, setChangesOf] = useState<{ n: number } | null>(null);
  const [backTo, setBackTo] = useState<{ n: number; text: string } | null>(null);
  const [goingBack, setGoingBack] = useState(false);

  /** Go back to before a message: its files return as they were, and the next message is told so. */
  const confirmGoBack = async () => {
    if (!backTo) return;
    setGoingBack(true);
    try {
      await api.chatGoBack(workspaceId, backTo.n);
      toast.success("Went back. Your files are as they were before that message.");
      await refresh();
    } catch (e) {
      toast.error(`Could not go back, ${(e as Error).message}`);
    } finally {
      setGoingBack(false);
      setBackTo(null);
      repoll();
    }
  };

  /** A new conversation that starts from what was said up to a message. The files stay as they are. */
  const branchFrom = async (n: number) => {
    try {
      await api.chatBranch(workspaceId, n);
      toast.success("Started a new chat from here");
      await refresh();
    } catch (e) {
      toast.error(`Could not start a new chat, ${(e as Error).message}`);
    }
  };

  const renderEvent = (e: ChatEvent) => {
    switch (e.kind) {
      case "user": {
        const { body, files } = splitAttached(e.text);
        // Pictures show as thumbnails; the other files stay as chips. Attachments are always saved in uploads/.
        const pictures = files.filter((name) => pictureType(name) !== null);
        const others = files.filter((name) => pictureType(name) === null);
        // Undo only for the newest message, and only once it has an id (a terminal's imported history has none).
        const uuid = e.uuid;
        const undoable = isClaude && uuid !== undefined && e.n === lastUserAllN && !busy && waiting === null && can;
        return (
          <div className="group/msg flex flex-col items-end gap-1" data-turn-start={e.n === lastUserN ? "" : undefined}>
            <div className="max-w-[70%] break-words whitespace-pre-wrap rounded-[20px] bg-surface-bubble px-[18px] py-[10px] text-base leading-6 text-text-primary max-md:text-base">
              {body}
              {pictures.map((name, i) => (
                <div key={i} className="mt-1">
                  <ProjectImage path={`uploads/${name}`} alt={name} thumbClass="max-h-32" />
                </div>
              ))}
              {others.length > 0 ? (
                <ul className="mt-1 flex flex-wrap gap-1.5 whitespace-normal">
                  {others.map((name, i) => (
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
            {e.tree !== undefined && can && !busy ? (
              <MessageActions onChanges={() => setChangesOf({ n: e.n })} onBack={() => setBackTo({ n: e.n, text: e.text })} onBranch={() => void branchFrom(e.n)} />
            ) : null}
          </div>
        );
      }
      case "assistant":
        return <Prose text={e.text} />;
      case "ask": {
        const answered = answers.get(e.requestId);
        if (answered !== undefined) return <AnsweredAsk e={e} allowed={answered} reply={replies.get(e.requestId)} />;
        if (pendingAsk?.requestId !== e.requestId) {
          // The newest question, with nothing said after it, can be asked again: the server restart lost the process that was waiting.
          const latestAskN = Math.max(0, ...events.filter((x) => x.kind === "ask").map((x) => x.n));
          const repeatable = e.n === latestAskN && !events.some((x) => x.kind === "user" && x.n > e.n) && !busy && waiting === null && can;
          return (
            <div className="flex flex-col items-start gap-3">
              <p className="text-small text-text-muted">{`Kohlab restarted before you answered, so ${who} stopped here.`}</p>
              {repeatable ? (
                <Button variant="secondary" disabled={sending} onClick={() => void sendText("Please carry on with what you were doing.")}>
                  {`Ask ${who} again`}
                </Button>
              ) : null}
            </div>
          );
        }
        if (e.form === "question") return <QuestionCard e={e} can={can} busy={answering !== null} onAnswer={(allow, extra) => void answer(e.requestId, allow, extra)} />;
        if (e.form === "plan") return <PlanCard e={e} can={can} busy={answering !== null} onAnswer={(allow, extra) => void answer(e.requestId, allow, extra)} />;
        return (
          <section aria-label={`${who} is asking`} className="rounded-card bg-surface-raised px-5 py-[18px]">
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
  const levels = isClaude ? (modelInfo?.supportedEffortLevels ?? []) : [];
  const storedModel = modelOf(ws ?? undefined);
  const modelText = !isClaude ? (model ? shortModel(model) : "Default") : (modelInfo?.displayName ?? (model ? modelName(model) : storedModel === "default" ? "Default" : MODEL_LABEL[storedModel]));
  const effortText = effort ? (EFFORT_LABEL[effort] ?? effort) : "Default";
  const modeText = mode === null ? "Mode" : (MODES[mode]?.label ?? mode);

  const placeholder =
    waiting !== null
      ? `${who} is waiting for your answer above`
      : busy
        ? `${who} is working…`
        : isPhone()
          ? `Message ${who}`
          : commandsEnabled ? `Message ${who} — / for commands, @ for files` : `Message ${who} — @ for files`;
  // Stop is the round button only while busy with nothing typed; with text, Send queues it and a quiet Stop sits beside it.
  const hasDraft = draft.trim() !== "" || attachments.length > 0;

  return (
    <WorkspaceCtx.Provider value={workspaceId}>
    <AgentCtx.Provider value={who}>
      <div className="flex h-full min-h-0" style={keyboard ? { paddingBottom: keyboard } : undefined}>
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <div ref={scrollRef} onScroll={onScroll} className="absolute inset-0 overflow-y-auto overscroll-contain">
              <div
                role="log"
                aria-live="polite"
                aria-label={`Conversation with ${who}`}
                className={cn(
                  "flex w-full flex-col gap-6 px-4 pt-6 pb-8 max-md:gap-5 max-md:pt-4 max-md:pb-4",
                  compact ? "pt-4" : "mx-auto max-w-[720px] shell:px-6",
                )}
              >
                {events.length === 0 && !busy ? (
                  <div className="flex flex-col items-center gap-2 px-2 pt-[18vh] text-center">
                    <h2 className="text-xl font-semibold text-text-primary">{`What should ${who} build?`}</h2>
                    <p className="text-base text-text-muted">{`Describe it in your own words. ${who} will ask before changing anything important.`}</p>
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
                            <ToolRun lines={row} results={results} />
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
                    <Prose text={streamed} streaming />
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
                {todos.length > 0 ? (
                  <div className="mb-2">
                    <Checklist todos={todos} />
                  </div>
                ) : null}
                {working ? (
                  <WorkingLine
                    action={currentAction}
                    since={busySince}
                    background={background}
                    tasksOpen={tasksOpen}
                    onTasks={() => setTasksOpen((o) => !o)}
                    helpers={helpers}
                    helpersOpen={helpersOpen}
                    onHelpers={() => setHelpersOpen((o) => !o)}
                  />
                ) : null}
                {working && helpersOpen && helpers.length > 0 ? <HelperList helpers={helpers} /> : null}
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
                  ariaLabel={`Message ${who}`}
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
                  onSaveLater={saveForLater}
                  onPaste={(e) => {
                    if (e.clipboardData.files.length > 0) {
                      e.preventDefault();
                      takeFiles(e.clipboardData.files, true);
                      return;
                    }
                    const text = e.clipboardData.getData("text/plain");
                    const asText = plainPaste.current;
                    plainPaste.current = false;
                    if (asText || text.length < BIG_PASTE) return;
                    // A big paste becomes a .txt file in the box, sent like any other attachment.
                    e.preventDefault();
                    takeFiles([new File([text], pastedName("text/plain", Date.now()), { type: "text/plain" })]);
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
                      {draft.trim() !== "" ? <SaveLaterChip onClick={saveForLater} /> : null}
                      <SavedChip onPick={(text) => {
                        setDraft(text);
                        taRef.current?.focus();
                      }} />
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
                      {!terminalProject && ws?.chat ? (
                        <AgentChip
                          agent={agent}
                          options={agentOptions}
                          onChange={(v) => void switchAgent(v)}
                          disabled={busy}
                          title={busy ? "Wait until the reply finishes" : undefined}
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
                            title={models.length === 0 ? `Models load when ${who} starts` : !isClaude && model ? model : undefined}
                          />
                        }
                      >
                        <ModelChoices models={models} value={modelInfo?.value ?? ""} onPick={(v) => void pick("model", v, model, setModel)} />
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
                      {isClaude ? (
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
                      ) : null}
                    </>
                  }
                  trailing={
                    <>
                      {isClaude && usage?.context && usage.context.percent >= 50 ? (
                        <ComposerChip
                          label={usage.context.percent >= 85 ? "Chat almost full" : `Chat ${usage.context.percent}% full`}
                          popoverTarget="context-popover"
                        />
                      ) : null}
                      {working && hasDraft ? (
                        <ComposerChip
                          className={cn("shrink-0 max-md:w-[var(--control-h-sm)] max-md:justify-center max-md:px-0", draft.trim() !== "" && "max-md:hidden")}
                          icon={<Stop size={14} aria-hidden="true" />}
                          label="Stop"
                          hideLabelOnPhone
                          aria-label={`Stop ${who}`}
                          title="Stop"
                          onClick={() => void stop()}
                        />
                      ) : null}
                      {working && draft.trim() !== "" ? (
                        <ComposerChip
                          className="shrink-0 max-md:w-[var(--control-h-sm)] max-md:justify-center max-md:px-0"
                          icon={<FastForward size={14} aria-hidden="true" />}
                          label="Send now"
                          hideLabelOnPhone
                          aria-label="Send now"
                          title="Stop and send now"
                          disabled={sending || uploading}
                          onClick={() => void sendNow()}
                        />
                      ) : null}
                      {working && !hasDraft ? (
                        <Button variant="secondary" iconOnly aria-label={`Stop ${who}`} title={`Stop ${who}`} onClick={() => void stop()}>
                          <Stop size={16} aria-hidden="true" />
                        </Button>
                      ) : (
                        <Button
                          variant="primary"
                          iconOnly
                          aria-label="Send"
                          title={busy ? `Send (queued until ${who} is ready)` : "Send"}
                          disabled={waiting !== null || sending || uploading || !hasDraft}
                          onClick={() => void send()}
                        >
                          <ArrowUp size={18} aria-hidden="true" />
                        </Button>
                      )}
                    </>
                  }
                />
                {working && draft.trim() !== "" && !isPhone() ? (
                  <p className="mt-1 px-4 text-xs text-text-muted">{`Enter adds to the queue · ${isApple ? "Cmd" : "Ctrl"}+Enter stops and sends now`}</p>
                ) : null}
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
            {isClaude && usage ? (
              <div className="mt-3">
                <UsagePanel usage={usage} />
              </div>
            ) : null}
          </div>
        </div>
  
        {changesOf !== null ? (
          <ChangesDialog
            workspaceId={workspaceId}
            n={changesOf.n}
            onOpenChange={(v) => {
              if (!v) setChangesOf(null);
            }}
          />
        ) : null}
        <ConfirmDialog
          open={backTo !== null}
          onOpenChange={(v) => {
            if (!v) setBackTo(null);
          }}
          title="Go back to before this message?"
          description="Your files return to how they were before you sent it. You can undo this from Earlier versions."
          confirmLabel="Go back"
          tone="commit"
          busy={goingBack}
          onConfirm={() => void confirmGoBack()}
        />
        <ConfirmDialog
          open={rewindPlan !== null}
          onOpenChange={(v) => {
            if (!v) setRewindPlan(null);
          }}
          title="Undo these changes?"
          description={
            rewindPlan
              ? `${who} changed ${rewindPlan.files.length} ${rewindPlan.files.length === 1 ? "file" : "files"} since that message. They go back to how they were before it.`
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
          description={`Everything ${who} changed since you last pressed Keep will be removed. This can't be reversed.`}
          confirmLabel="Undo"
          tone="danger"
          busy={undoing}
          onConfirm={() => void undo()}
        />
      </div>
    </AgentCtx.Provider>
    </WorkspaceCtx.Provider>
  );
}
