import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, X } from "@phosphor-icons/react";
import { api } from "../api";
import type { ChatEvent, Fallback, FallbackStep, HelperNode, RunInfo, Src } from "../types";
import {
  EFFORT_LABEL,
  MODE_LABEL,
  durationText,
  helperForest,
  helperWord,
  limitSentence,
  moveStep,
  replyLine,
  replyRows,
  ruleSource,
  sourceWords,
  stepLabel,
  stepsText,
  tokensText,
  type HelperTreeNode,
} from "../lib/aiHub";
import { announce } from "../lib/announce";
import { agentName } from "../lib/agentName";
import { useDragSize } from "../lib/useDragSize";
import { useProviders } from "../lib/useProviders";
import { Button, ComposerChip, Dialog, Menu, MenuItem, MenuLabel, SkeletonRows } from "./ui";
import { modelName, type ModelInfo } from "./ModelPicker";

/* ------------------------------------------------------- where it shows -- */

const WIDE = "(min-width: 1280px)";
const OPEN_KEY = "kohlab_run_panel";

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeOpen(open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    /* not remembered */
  }
}

/**
 * Where the Run panel lives. Docked on the right of the chat when the window is 1280px or wider, the Preview is closed and the
 * chat is not in a narrow dock; otherwise the same content opens as a sheet from the run strip. The docked choice is remembered
 * (open by default); the sheet always starts closed.
 */
export function useRunPanel({ previewOpen, compact }: { previewOpen: boolean; compact: boolean }) {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const [dockOpen, setDockOpen] = useState(readOpen);
  const [sheetOpen, setSheetOpen] = useState(false);
  const docked = wide && !previewOpen && !compact;
  const open = docked ? dockOpen : sheetOpen;
  const set = (value: boolean) => {
    if (docked) {
      setDockOpen(value);
      writeOpen(value);
    } else setSheetOpen(value);
  };
  return { docked, open, setOpen: set, toggle: () => set(!open) };
}

/** A clock for the elapsed times; it ticks (once a second) only while `active`. */
function useNow(active: boolean, skew: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now + skew;
}

/* -------------------------------------------------------------- helpers -- */

const TOOL_STATUS: Record<string, string> = { connected: "Connected", failed: "Not working", pending: "Starting", needs_auth: "Needs sign-in", disabled: "Off" };
const toolStatusWord = (s: string): string => TOOL_STATUS[s] ?? (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ") : "Unknown");

function HelperRow({ t, now, canMutate, stopping, onStop }: { t: HelperTreeNode; now: number; canMutate: boolean; stopping: string | null; onStop: (taskId: string) => void }) {
  const [open, setOpen] = useState(false);
  const n = t.node;
  const running = n.status === "running";
  const elapsed = durationText((n.endedAt ?? now) - n.startedAt);
  const facts = [
    n.kind,
    n.model ? modelName(n.model) : null,
    running || n.endedAt ? elapsed : null,
    n.tools !== null ? stepsText(n.tools) : null,
    n.tokens !== null ? tokensText(n.tokens) : null,
  ].filter(Boolean);
  const hasMore = !!(n.lastTool || n.summary);
  return (
    <li className="flex flex-col">
      <div className="flex items-start gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="min-h-8 min-w-0 flex-1 rounded-lg px-2 py-1 text-left hover:bg-surface-hover pointer-coarse:min-h-11"
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{n.label || "A helper"}</span>
            <span className="shrink-0 text-xs text-text-secondary">{helperWord(n.status)}</span>
          </span>
          {facts.length > 0 ? <span className="block text-xs break-words text-text-muted tabular-nums">{facts.join(" · ")}</span> : null}
        </button>
        {n.canStop && canMutate && n.taskId ? (
          <Button
            variant="quiet"
            size="sm"
            className="shrink-0 text-xs text-text-secondary"
            disabled={stopping !== null}
            aria-label={`Stop ${n.label || "helper"}`}
            onClick={() => onStop(n.taskId!)}
          >
            Stop
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="flex flex-col gap-1 px-2 pb-1 text-xs text-text-muted">
          {n.lastTool ? <p>{`Last step: ${n.lastTool}`}</p> : null}
          {n.summary ? <p className="break-words">{n.summary}</p> : null}
          {!hasMore ? <p>Nothing more to show yet.</p> : null}
        </div>
      ) : null}
      {t.children.length > 0 ? (
        <ul aria-label={`Helpers of ${n.label || "a helper"}`} className="ml-4 flex flex-col">
          {t.children.map((c) => (
            <HelperRow key={c.node.id} t={c} now={now} canMutate={canMutate} stopping={stopping} onStop={onStop} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/* -------------------------------------------------------------- content -- */

export interface RunSlice {
  workspaceId: string;
  agent: string;
  who: string;
  isClaude: boolean;
  busy: boolean;
  waiting: string | null;
  /** When the current turn started (ms, this device's clock). */
  since: number | null;
  background: number;
  helperTree: HelperNode[];
  /** Server clock minus this device's clock, so helper times add up. */
  skew: number;
  canMutate: boolean;
  owner: boolean;
  stopping: string | null;
  onStopHelper: (taskId: string) => void;
  /** The checklist and the background tasks, drawn by the chat (they are its own parts). */
  nowExtra: ReactNode;
  events: ChatEvent[];
  autoFresh: boolean;
  onAutoFresh: (on: boolean) => void;
  onContinueFresh: () => void;
  ctxPercent: number | null;
  /** The run info the chat read (null until it lands, or on an older server), and a way to read it again. */
  info: RunInfo | null;
  infoFailed: boolean;
  onReload: () => void;
  /** The person may change this project's AI settings (not a viewer, not a terminal project). */
  canSet: boolean;
  /** The chip texts the composer shows, so the panel names the model the same way. */
  modelText: string;
  models: ModelInfo[];
  /** The composer's own menus, so each row here opens the same one. */
  menus: { ai: ReactNode; account: ReactNode; model: ReactNode; effort: ReactNode | null; mode: ReactNode };
  /** Back to the inherited value: "model", "effort", "mode", "autoFresh", "agent" or "account". */
  onReset: (field: string) => void;
}

/** Reads GET .../chat/run for the chat: again when `key` changes. The chat holds it, so the strip can name the account and the panel can show it. */
export function useRunInfo(workspaceId: string, key: string, enabled = true) {
  const [info, setInfo] = useState<RunInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setInfo(null), [workspaceId]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setFailed(false);
    api.chatRun(workspaceId).then(
      (r) => {
        if (alive) setInfo(r);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [workspaceId, key, attempt, enabled]);
  return { info, failed, reload: () => setAttempt((n) => n + 1) };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-text-primary">{title}</h3>
      {children}
    </section>
  );
}

const PRE = "mono max-h-56 overflow-auto rounded-lg bg-surface-sunken p-3 text-xs leading-5 whitespace-pre-wrap break-words text-text-secondary";

/** One row of "Now": the setting, its value (a menu for someone who can change it), where it comes from, and Reset when this project set it. */
function SettingRow({ label, value, source, menu, canSet, onReset, inheritedNote }: { label: string; value: string; source: Src | undefined; menu: ReactNode; canSet: boolean; onReset: () => void; inheritedNote?: string }) {
  return (
    <div className="flex flex-col">
      <div className="flex min-h-8 items-center gap-2 pointer-coarse:min-h-11">
        <span className="w-16 shrink-0 text-xs text-text-muted">{label}</span>
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {canSet && menu ? (
            <Menu label={`${label}: ${value}`} align="start" trigger={<ComposerChip className="-ml-2.5 max-w-full" label={value} menu />}>
              {menu}
            </Menu>
          ) : (
            <span className="min-w-0 truncate text-sm text-text-primary">{value}</span>
          )}
          {canSet && source === "project" ? (
            <Button variant="quiet" size="sm" className="shrink-0 text-xs text-text-secondary" aria-label={`Reset ${label.toLowerCase()} to the Settings choice`} onClick={onReset}>
              Reset
            </Button>
          ) : null}
        </div>
      </div>
      {source ? <p className="pl-16 text-xs text-text-muted">{source !== "project" && inheritedNote ? `${sourceWords(source)}. ${inheritedNote}` : sourceWords(source)}</p> : null}
    </div>
  );
}

const FIRST_MESSAGE = "Applies until the first message.";

/** "If the limit is reached": where the project is now, the order of what to try next, and whether to carry on by itself. Keyboard only: Move up, Move down, Remove. */
function FallbackBlock({ p, info, fallback }: { p: RunSlice; info: RunInfo; fallback: Fallback }) {
  const { cards } = useProviders();
  const card = cards?.find((c) => c.id === (info.agent || p.agent));
  const accounts = card?.accounts ?? [];
  const current = info.account?.id ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = (s: FallbackStep) => stepLabel(s, accounts, current, modelName);
  const save = async (body: { auto: boolean; steps: FallbackStep[] } | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.chatControl(p.workspaceId, "fallback", body);
      announce("Saved");
      p.onReload();
    } catch (e) {
      setError(`Couldn't save that. ${e instanceof Error && e.message ? e.message : "Try again."}`);
    } finally {
      setBusy(false);
    }
  };
  const keyOf = (s: FallbackStep) => `${s.account === undefined ? "same" : (s.account ?? "default")}|${s.model ?? ""}`;
  // What can be added: another account, or another model on this one. Anything already in the list is left out.
  const candidates: FallbackStep[] = [
    ...accounts.filter((a) => a.state !== "signed_out" && a.state !== "error" && a.id !== (current ?? "default")).map((a): FallbackStep => ({ account: a.id === "default" ? null : a.id })),
    ...p.models.filter((m) => m.value !== "default" && modelName(m.value) !== p.modelText).map((m): FallbackStep => ({ model: m.value })),
  ].filter((c) => !fallback.steps.some((s) => keyOf(s) === keyOf(c)));
  const canEdit = p.canSet;
  const auto = (
    <label className="flex min-h-8 cursor-pointer items-start gap-3 pointer-coarse:min-h-11" htmlFor="run-fallback-auto">
      <input id="run-fallback-auto" type="checkbox" className="mt-0.5 size-4 shrink-0 accent-accent" checked={fallback.auto} disabled={busy || !canEdit} onChange={(e) => void save({ auto: e.target.checked, steps: fallback.steps })} />
      <span className="text-sm text-text-primary">Continue on the next one automatically</span>
    </label>
  );
  return (
    <Section title="If the limit is reached">
      {info.limit ? (
        <div className="flex flex-col items-start gap-1">
          <p className="text-sm text-text-secondary">{limitSentence(info.limit)}</p>
          {canEdit ? (
            <Button variant="quiet" size="sm" className="text-text-secondary" onClick={() => p.onReset("account")}>
              Switch back now
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-text-muted">If this AI reaches its limit, Kohlab can carry on with the next one below.</p>
      )}
      <p className="text-xs text-text-muted">{fallback.custom ? "Your order" : "Suggested order"}</p>
      {fallback.steps.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing to switch to yet.</p>
      ) : (
        <ol aria-label="If the limit is reached" className="flex flex-col gap-1">
          {fallback.steps.map((s, i) => (
            <li key={`${i}-${label(s)}`} className="flex min-w-0 items-center gap-1">
              <span className="w-5 shrink-0 text-xs text-text-muted tabular-nums">{`${i + 1}.`}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{label(s)}</span>
              {canEdit ? (
                <>
                  <Button variant="quiet" size="sm" iconOnly aria-label={`Move ${label(s)} up`} disabled={busy || i === 0} onClick={() => void save({ auto: fallback.auto, steps: moveStep(fallback.steps, i, -1) })}>
                    <ArrowUp size={14} aria-hidden="true" />
                  </Button>
                  <Button variant="quiet" size="sm" iconOnly aria-label={`Move ${label(s)} down`} disabled={busy || i === fallback.steps.length - 1} onClick={() => void save({ auto: fallback.auto, steps: moveStep(fallback.steps, i, 1) })}>
                    <ArrowDown size={14} aria-hidden="true" />
                  </Button>
                  <Button variant="quiet" size="sm" className="text-xs text-text-secondary" aria-label={`Remove ${label(s)}`} disabled={busy} onClick={() => void save({ auto: fallback.auto, steps: fallback.steps.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Menu
            label="Add a step"
            align="start"
            trigger={
              <Button variant="quiet" size="sm" className="text-text-secondary" disabled={busy || candidates.length === 0}>
                Add a step
              </Button>
            }
          >
            <MenuLabel>Try next</MenuLabel>
            {candidates.map((c, i) => (
              <MenuItem key={i} onSelect={() => void save({ auto: fallback.auto, steps: [...fallback.steps, c] })}>
                {label(c)}
              </MenuItem>
            ))}
          </Menu>
          {fallback.custom ? (
            <Button variant="quiet" size="sm" className="text-text-secondary" disabled={busy} onClick={() => void save(null)}>
              Use the suggested order
            </Button>
          ) : null}
        </div>
      ) : null}
      {auto}
      {error ? <p role="status" className="text-xs text-text-muted">{error}</p> : null}
    </Section>
  );
}

/** "What it can do without asking": each saved rule in words, where it comes from, and Remove for the ones Kohlab keeps. */
function RulesBlock({ p, info }: { p: RunSlice; info: RunInfo }) {
  const [note, setNote] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const remove = async (rule: string) => {
    setRemoving(rule);
    setNote(null);
    try {
      await api.chatControl(p.workspaceId, "rule_remove", rule);
      const text = p.busy ? "Removed. It takes effect after the current reply." : "Removed.";
      setNote(text);
      announce(text);
      p.onReload();
    } catch (e) {
      setNote(`Couldn't remove that. ${e instanceof Error && e.message ? e.message : "Try again."}`);
    } finally {
      setRemoving(null);
    }
  };
  const rules = info.rules ?? [];
  return (
    <Section title="What it can do without asking">
      {rules.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing is allowed without asking yet.</p>
      ) : (
        <ul aria-label="Allowed without asking" className="flex flex-col gap-1">
          {rules.map((r) => (
            <li key={`${r.source}-${r.rule}`} className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm text-text-primary">{r.label}</span>
                <span className="block text-xs text-text-muted">{ruleSource(r.source)}</span>
              </span>
              {r.removable && p.canSet ? (
                <Button variant="quiet" size="sm" className="shrink-0 text-xs text-text-secondary" aria-label={`Remove: ${r.label}`} disabled={removing !== null} onClick={() => void remove(r.rule)}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {info.accessNote && info.ai?.mode.value === "full" ? <p className="text-xs leading-relaxed text-text-muted">{info.accessNote}</p> : null}
      {note ? <p role="status" className="text-xs text-text-muted">{note}</p> : null}
    </Section>
  );
}

function RunContent(p: RunSlice) {
  const { info, infoFailed: failed } = p;
  const ai = info?.ai;
  const { cards } = useProviders();
  const usableAccounts = (cards?.find((c) => c.id === (info?.agent ?? p.agent))?.accounts ?? []).filter((a) => a.state !== "signed_out" && a.state !== "error");
  const autoSource = ai?.autoFresh.source;
  const forest = helperForest(p.helperTree);
  const running = p.helperTree.some((h) => h.status === "running");
  const now = useNow(running || p.busy, p.skew);
  const replies = replyRows(p.events, p.owner, 20, modelName);
  const state = p.waiting !== null ? `${p.who} is waiting for your answer.` : p.busy ? "Working" : p.background > 0 || running ? "Some work is still running in the background." : `${p.who} is ready.`;

  return (
    <div className="flex flex-col gap-6">
      <Section title="Now">
        <p className="text-sm text-text-secondary tabular-nums">
          {state}
          {p.busy && p.waiting === null && p.since !== null ? ` ${durationText(now - p.since)}` : ""}
        </p>
        {ai ? (
          <div className="flex flex-col gap-1">
            <SettingRow label="AI" value={agentName(ai.agent.value ?? info!.agent)} source={ai.agent.source} menu={p.menus.ai} canSet={p.canSet} onReset={() => p.onReset("agent")} inheritedNote={FIRST_MESSAGE} />
            {usableAccounts.length > 1 ? (
              <SettingRow label="Account" value={info!.account?.label ?? "Main account"} source={ai.account.source} menu={p.menus.account} canSet={p.canSet} onReset={() => p.onReset("account")} inheritedNote={FIRST_MESSAGE} />
            ) : null}
            <SettingRow label="Model" value={p.modelText} source={ai.model.source} menu={p.menus.model} canSet={p.canSet} onReset={() => p.onReset("model")} />
            {p.menus.effort ? (
              <SettingRow label="Effort" value={ai.effort.value ? (EFFORT_LABEL[ai.effort.value] ?? ai.effort.value) : "Default"} source={ai.effort.source} menu={p.menus.effort} canSet={p.canSet} onReset={() => p.onReset("effort")} />
            ) : null}
            <SettingRow label="Mode" value={MODE_LABEL[ai.mode.value ?? "default"] ?? MODE_LABEL.default} source={ai.mode.source} menu={p.menus.mode} canSet={p.canSet} onReset={() => p.onReset("mode")} />
          </div>
        ) : null}
        {p.nowExtra}
        {p.ctxPercent !== null ? <p className="text-xs text-text-muted">{`This chat is ${p.ctxPercent}% full.`}</p> : null}
        {p.canMutate ? (
          <div className="flex flex-col items-start gap-2">
            <label className="flex min-h-8 cursor-pointer items-start gap-3 pointer-coarse:min-h-11" htmlFor="run-auto-fresh">
              <input
                id="run-auto-fresh"
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-accent"
                checked={p.autoFresh}
                onChange={(e) => p.onAutoFresh(e.target.checked)}
              />
              <span className="min-w-0">
                <span className="block text-sm text-text-primary">Continue fresh automatically</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-text-muted">When this chat is nearly full, Kohlab starts a fresh memory once the AI is idle. Nothing is lost.</span>
                {autoSource ? <span className="mt-0.5 block text-xs text-text-muted">{sourceWords(autoSource)}</span> : null}
              </span>
            </label>
            {autoSource === "project" ? (
              <Button variant="quiet" size="sm" className="text-xs text-text-secondary" aria-label="Reset continue fresh to the Settings choice" onClick={() => p.onReset("autoFresh")}>
                Reset
              </Button>
            ) : null}
            <Button variant="quiet" size="sm" className="text-text-secondary" disabled={p.busy || p.background > 0 || p.waiting !== null} onClick={p.onContinueFresh}>
              Continue fresh now
            </Button>
          </div>
        ) : null}
      </Section>

      {info?.fallback ? <FallbackBlock p={p} info={info} fallback={info.fallback} /> : null}

      <Section title="Helpers">
        {forest.length === 0 ? (
          <p className="text-sm text-text-muted">No helpers</p>
        ) : (
          <ul aria-label="Helpers" className="-mx-2 flex flex-col">
            {forest.map((t) => (
              <HelperRow key={t.node.id} t={t} now={now} canMutate={p.canMutate} stopping={p.stopping} onStop={p.onStopHelper} />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Replies">
        {replies.length === 0 ? (
          <p className="text-sm text-text-muted">No replies yet.</p>
        ) : (
          <ul aria-label="Replies" className="flex flex-col gap-1">
            {replies.map((r) => (
              <li key={r.n} className="flex min-w-0 items-baseline justify-between gap-3 text-xs text-text-muted tabular-nums">
                <span className="min-w-0 break-words text-text-secondary">{replyLine(r) || "Reply"}</span>
                <span className="shrink-0">{new Date(r.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase()}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {failed && !info ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-text-secondary">Couldn't read the details right now.</p>
          <Button variant="secondary" size="sm" onClick={p.onReload}>
            Try again
          </Button>
        </div>
      ) : info === null ? (
        <SkeletonRows rows={3} />
      ) : (
        <>
          <Section title="What it was told">
            {info.instructions.system ? (
              <>
                <p className="text-xs text-text-muted">From Kohlab</p>
                <pre className={PRE}>{info.instructions.system}</pre>
              </>
            ) : null}
            {info.instructions.notes.trim() ? (
              <>
                <p className="text-xs text-text-muted">Your notes for this project</p>
                <pre className={PRE}>{info.instructions.notes}</pre>
              </>
            ) : null}
            {info.instructions.note ? <p className="text-xs leading-relaxed text-text-muted">{info.instructions.note}</p> : null}
          </Section>

          <Section title="What it can use">
            {info.tools === null ? (
              <p className="text-sm text-text-muted">{p.isClaude ? "Listed once it has started." : "Not listed by this AI."}</p>
            ) : (
              <>
                <p className="text-sm break-words text-text-secondary">{info.tools.builtin.length > 0 ? info.tools.builtin.join(", ") : "No built-in tools listed."}</p>
                {info.tools.mcp.length > 0 ? (
                  <ul aria-label="Connected tool servers" className="flex flex-col gap-1">
                    {info.tools.mcp.map((m) => (
                      <li key={m.name} className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate text-text-secondary">{m.name}</span>
                        <span className="shrink-0 text-xs text-text-muted">{toolStatusWord(m.status)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </Section>

          {info.rules !== undefined ? <RulesBlock p={p} info={info} /> : null}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- panel -- */

function Dock({ onClose, ...slice }: RunSlice & { onClose: () => void }) {
  const { size, handleProps } = useDragSize("kohlab_run_width", 320, 260, () => Math.max(260, Math.min(480, window.innerWidth - 700)), "left");
  return (
    <aside aria-label="Run" className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-line-subtle bg-surface-raised" style={{ width: size }}>
      <div {...handleProps} aria-label="Resize run details" className="resize-handle resize-handle-x" />
      <div className="flex items-center justify-between gap-2 py-2 pr-2 pl-4">
        <h2 className="text-sm font-medium text-text-primary">Run details</h2>
        <Button variant="quiet" size="sm" iconOnly aria-label="Close run details" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        <RunContent {...slice} />
      </div>
    </aside>
  );
}

function Sheet({ onClose, ...slice }: RunSlice & { onClose: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content aria-describedby={undefined} className="dialog-content flex max-h-[85vh] w-[90vw] max-w-[560px] flex-col gap-3 p-4">
          <Dialog.Title className="text-base font-semibold text-text-primary">Run details</Dialog.Title>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <RunContent {...slice} />
          </div>
          <div className="flex justify-end">
            <Dialog.Close asChild>
              <Button variant="quiet" size="sm">
                Done
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The Run panel: a dock on the right of the chat when there is room, else a sheet. Nothing is fetched while it is closed. */
export default function RunPanel({ docked, open, onClose, ...slice }: RunSlice & { docked: boolean; open: boolean; onClose: () => void }) {
  if (!open) return null;
  return docked ? <Dock onClose={onClose} {...slice} /> : <Sheet onClose={onClose} {...slice} />;
}
