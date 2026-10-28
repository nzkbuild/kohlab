/** Pure helpers for the AI hub, the model picker, the run strip and the Run panel. No React, no fetches: scripts/check-run-text.mjs runs these. */
import type { ChatEvent, FallbackStep, HelperNode, Mode, PermissionRule, ProviderAccount, ProviderCard, ProviderModel, Src } from "../types";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "7:20 pm", "tomorrow at 9:00 am" or "Monday at 9:00 am": when a plan limit resets, in this device's time. Pure. */
export function resetsText(iso: string | null, now = new Date()): string | null {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  if (days === 0) return `resets at ${time}`;
  if (days === 1) return `resets tomorrow at ${time}`;
  return `resets ${at.toLocaleDateString([], { weekday: "long" })} at ${time}`;
}

/** "2:49 pm", "tomorrow at 2:49 pm" or "Monday at 2:49 pm": a moment in ms, in this device's time zone. Pure. */
export function untilText(at: number, now = new Date()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(now)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString([], { weekday: "long" })} at ${time}`;
}

/** A note as the chat shows it: a limit note carries `until` (ms), shown in this device's time zone. */
export const noteLine = (text: string, until?: number | null): string => (typeof until === "number" && Number.isFinite(until) ? `${text} until ${untilText(until)}` : text);

/** "34% used · resets at 7:20 pm", or "Limit reached. Resets at 7:20 pm" for a window that is full. */
export function usageText(percent: number, resetsAt: string | null, limited = false, now = new Date()): string {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  const reset = resetsText(resetsAt, now);
  if (limited) return reset ? `Limit reached. ${cap(reset)}` : "Limit reached.";
  return `${pct}% used${reset ? ` · ${reset}` : ""}`;
}

/** "12s" under a minute, then "1m 05s". */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** "980 tokens", "12.3k tokens", "1.2M tokens". */
export function tokensText(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n === 1) return "1 token";
  if (n < 1000) return `${Math.round(n)} tokens`;
  const short = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (n < 1_000_000) return `${n < 100_000 ? short(n / 1000) : Math.round(n / 1000)}k tokens`;
  return `${short(n / 1_000_000)}M tokens`;
}

/** "just now", "2 min ago", "3 hr ago", "2 days ago". */
export function agoText(at: number, now = Date.now()): string {
  const min = Math.floor(Math.max(0, now - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const d = Math.floor(hr / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

/* ------------------------------------------------------------ providers -- */

const STATE_WORD: Record<ProviderCard["state"], string> = {
  connected: "Connected",
  signed_out: "Signed out",
  not_installed: "Not installed",
  limited: "Limit reached",
  error: "Problem",
  checking: "Checking",
};

/** The word a person sees for a provider's state. Never colour alone. */
export const stateWord = (state: ProviderCard["state"]): string => STATE_WORD[state] ?? "Checking";

/** A card whose AI can be used right now. */
export const isUsable = (card: ProviderCard): boolean => card.state === "connected" || card.state === "limited";

/**
 * The account a card shows: the owner sees the email, or the provider's own label when it differs from the AI's name.
 * Everyone else sees none (the server already hides it; this is the second guard).
 */
export function accountLabel(card: ProviderCard, isOwner = true, account?: ProviderAccount): string | null {
  if (!isOwner) return null;
  const a = account ?? card.accounts[0];
  if (!a) return null;
  if (a.email) return a.email;
  return a.label && a.label !== card.name ? a.label : null;
}

/** Claude first, then connected, then signed out or in trouble, then not installed. Stable inside a rank. */
export function orderCards(cards: ProviderCard[]): ProviderCard[] {
  const rank = (c: ProviderCard) => (c.id === "claude" ? 0 : isUsable(c) ? 1 : c.state === "not_installed" ? 3 : 2);
  return cards.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
}

export interface PickerGroup {
  /** `${card.id}:${accountId}` */
  id: string;
  /** The AI's id ("claude"). */
  agent: string;
  /** The account's id ("default" for the AI's own login). */
  accountId: string;
  name: string;
  /** "Claude · you@example.com" for the owner, "Claude" for everyone else. */
  label: string;
  models: ProviderModel[];
}

/** An account's name in a heading: the owner sees the email, or the label when it differs from the AI's name. */
function accountName(card: ProviderCard, a: ProviderAccount, isOwner: boolean): string | null {
  if (!isOwner) return a.id !== "default" && a.label && a.label !== card.name ? a.label : null;
  if (a.email) return a.email;
  return a.label && a.label !== card.name ? a.label : null;
}

/** The model menu's groups: one per usable account of every AI that is connected or at its limit, Claude first. A signed-out or broken account has none. */
export function pickerGroups(cards: ProviderCard[], isOwner: boolean): PickerGroup[] {
  return orderCards(cards)
    .filter(isUsable)
    .flatMap((c) =>
      c.accounts
        .filter((a) => a.state !== "signed_out" && a.state !== "error")
        .map((a) => {
          const account = accountName(c, a, isOwner);
          return { id: `${c.id}:${a.id}`, agent: c.id, accountId: a.id, name: c.name, label: account ? `${c.name} · ${account}` : c.name, models: a.models };
        }),
    );
}

/* --------------------------------------------------------------- strip -- */

export interface StripParts {
  ai: string;
  account?: string | null;
  model?: string | null;
  mode?: string | null;
  /** "Ready", "Working 1m 12s", "Waiting for you", "In the background" */
  state: string;
  /** The state without a timer, for a phone. */
  stateShort?: string;
  /** More to say after the state ("2 helpers working"). Dropped on a phone. */
  extra?: string | null;
  /** "next message: Haiku 4.5": the one-off model, kept on a phone too. */
  next?: string | null;
}

/** The run strip's one line: "Claude · you@example.com · Sonnet 5.5 · Asks first · Working 1m 12s". Missing parts are left out; a phone keeps AI, model and state. */
export function stripText(p: StripParts, phone = false): string {
  const next = p.next ? `next message: ${p.next}` : null;
  const parts = phone
    ? [p.ai, p.model, p.stateShort ?? p.state, next]
    : [p.ai, p.account, p.model, p.mode, p.state, p.extra, next];
  return parts.filter((x): x is string => typeof x === "string" && x.trim() !== "").join(" · ");
}

/* ------------------------------------------------------------- helpers -- */

export interface HelperTreeNode {
  node: HelperNode;
  children: HelperTreeNode[];
}

/** The helpers as a forest: a helper whose parent is not in the list is a root. Order of the list is kept; a loop cannot hang it. */
export function helperForest(tree: HelperNode[], cap = 50): HelperTreeNode[] {
  const list = tree.slice(0, cap);
  const byId = new Map<string, HelperTreeNode>();
  for (const node of list) if (!byId.has(node.id)) byId.set(node.id, { node, children: [] });
  const roots: HelperTreeNode[] = [];
  const placed = new Set<string>();
  const parentOf = (n: HelperNode) => (n.parentId && n.parentId !== n.id ? byId.get(n.parentId) : undefined);
  // A node reaches the root through its parents; a loop of parents has no root, so its first member becomes one.
  const hasRoot = (n: HelperNode): boolean => {
    const seen = new Set<string>([n.id]);
    for (let p = parentOf(n); p; p = parentOf(p.node)) {
      if (seen.has(p.node.id)) return false;
      seen.add(p.node.id);
    }
    return true;
  };
  for (const node of list) {
    const me = byId.get(node.id)!;
    if (placed.has(node.id)) continue;
    placed.add(node.id);
    const parent = parentOf(node);
    if (parent && hasRoot(node)) parent.children.push(me);
    else roots.push(me);
  }
  return roots;
}

/** The helpers as rows with their depth, each parent before its children. */
export function flattenHelpers(tree: HelperNode[], cap = 50): { node: HelperNode; depth: number }[] {
  const rows: { node: HelperNode; depth: number }[] = [];
  const walk = (list: HelperTreeNode[], depth: number) => {
    for (const t of list) {
      rows.push({ node: t.node, depth });
      walk(t.children, depth + 1);
    }
  };
  walk(helperForest(tree, cap), 0);
  return rows;
}

const HELPER_WORD: Record<HelperNode["status"], string> = { running: "Working", done: "Done", failed: "Failed", stopped: "Stopped" };

/** The word for a helper's status. */
export const helperWord = (status: HelperNode["status"]): string => HELPER_WORD[status] ?? "Working";

/** "1 step", "4 steps". */
export const stepsText = (n: number): string => `${n} ${n === 1 ? "step" : "steps"}`;

/** "1 helper working", "2 helpers working"; empty for none. */
export const helpersWorkingText = (n: number): string => (n > 0 ? `${n} ${n === 1 ? "helper" : "helpers"} working` : "");

/* ------------------------------------------------------------- replies -- */

export interface ReplyRow {
  n: number;
  at: number;
  model: string | null;
  /** how long the reply took, e.g. "1m 12s" */
  time: string | null;
  tokens: string | null;
  /** "12% of your plan"; owner only */
  plan: string | null;
}

/** The last `limit` replies, newest first: each "done" event with its model, time, tokens and (for the owner) plan share. A "plan" event that follows a done line belongs to it. */
export function replyRows(events: ChatEvent[], isOwner = false, limit = 20, nameOf: (model: string) => string = (m) => m): ReplyRow[] {
  const rows: ReplyRow[] = [];
  const planOf = new Map<number, number>();
  let last: number | null = null;
  for (const e of events) {
    if (e.kind === "done") {
      last = e.n;
      if (e.planDelta !== undefined) planOf.set(e.n, e.planDelta);
      const total = e.tokens ? (e.tokens.in ?? 0) + (e.tokens.out ?? 0) : null;
      rows.push({
        n: e.n,
        at: e.at,
        model: e.model ? nameOf(e.model) : null,
        time: e.worked !== undefined && e.worked > 0 ? durationText(e.worked) : null,
        tokens: total !== null && total > 0 ? tokensText(total) : null,
        plan: null,
      });
    } else if (e.kind === "plan" && last !== null) planOf.set(last, e.planDelta);
  }
  for (const r of rows) {
    const d = planOf.get(r.n);
    if (isOwner && d !== undefined && Math.round(d) > 0) r.plan = `${Math.round(d)}% of your plan`;
  }
  return rows.slice(-limit).reverse();
}

/** A reply row as one line: "Sonnet 5.5 · 1m 12s · 12.3k tokens · 4% of your plan". */
export const replyLine = (r: ReplyRow): string => [r.model, r.time, r.tokens, r.plan].filter(Boolean).join(" · ");

/* ------------------------------------------------------- AI control -- */

/** Every mode in plain words. The Mode menu offers four (five for Claude); the others are names the CLI may report. */
export const MODE_LABEL: Record<string, string> = {
  default: "Asks first",
  acceptEdits: "Edits allowed",
  auto: "Auto",
  full: "Full access",
  plan: "Plan first",
  manual: "Asks first",
  bypassPermissions: "Full access",
};

/** The modes the menu offers, in order. "Plan first" is Claude's only. */
export const modeChoices = (isClaude: boolean): Mode[] => (isClaude ? ["default", "acceptEdits", "auto", "full", "plan"] : ["default", "acceptEdits", "auto", "full"]);

/** The one line under a mode in the menu. */
export function modeDetail(mode: string, isClaude = true): string {
  switch (mode) {
    case "default":
      return "Asks before it changes a file or runs a command";
    case "acceptEdits":
      return "Changes files without asking; still asks before commands";
    case "auto":
      return isClaude ? "Decides for itself; still asks before risky steps" : "Decides for itself; still asks before risky steps. This AI uses a simple built-in rule.";
    case "full":
      return "Never asks. It can change and delete anything the AI can reach.";
    case "plan":
      return "Plans and explains before changing anything";
    default:
      return "";
  }
}

export const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
export const EFFORT_CHOICES = ["low", "medium", "high", "xhigh", "max"];

/** Where a setting comes from, in words. */
export const sourceWords = (src: Src | undefined): string => (src === "project" ? "Set for this project" : src === "default" ? "Inherits from Settings" : "Built-in choice");

/** Words for a rule's origin in the Run panel. */
export const ruleSource = (s: PermissionRule["source"]): string => (s === "claude-settings" ? "From this project's settings" : s === "session" ? "This session" : "You allowed this");

/** "Using Work until 2:49 pm. Claude Pro will be used again after that." */
export function limitSentence(l: { from: string; to: string; until: number | null }): string {
  return l.until === null ? `Using ${l.to}. ${l.from} will be used again when its limit lifts.` : `Using ${l.to} until ${untilText(l.until)}. ${l.from} will be used again after that.`;
}

/** An account's name in a sentence: its plan for the AI's own login ("Pro"), its label for another, "the main account" if neither is known. */
export function accountWord(account: ProviderAccount | undefined): string {
  if (account && account.id !== "default") return account.label;
  return account?.plan ? account.plan.charAt(0).toUpperCase() + account.plan.slice(1) : "the main account";
}

/** A fallback step as a row: "Work account", "Haiku 4.5 on Pro". `accounts` are the AI's accounts; `current` the one in use (a step with no account means that one). */
export function stepLabel(step: FallbackStep, accounts: ProviderAccount[], current: string | null | undefined, modelName: (id: string) => string): string {
  const id = step.account === undefined ? current : step.account;
  const who = accountWord(accounts.find((a) => a.id === (id ?? "default")));
  if (step.model) return `${modelName(step.model)} on ${who}`;
  return who === "the main account" ? "Main account" : `${who} account`;
}

/** The list with one step moved by `by` places (-1 up, 1 down). A move past either end changes nothing. */
export function moveStep<T>(steps: T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (index < 0 || index >= steps.length || to < 0 || to >= steps.length) return steps;
  const next = steps.slice();
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}
