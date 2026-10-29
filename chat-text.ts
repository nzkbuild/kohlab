/** Pure text helpers for the chat: what a tool, an ask or an error says, in plain words. */
import { isAbsolute, relative } from "node:path";
import { limitReached, ruleParts, validRule } from "./policy";

export const MAX_TEXT = 20000;

/** One multiple-choice question from AskUserQuestion, cleaned by askForm. */
export type AskQuestion = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] };

export type Body =
  /** uuid: the id Claude keeps for this message, which Undo names. Not set on lines imported from a terminal's transcript. */
  /** tree: the project's files as they were just before this message (checkpoints.ts). Not set when the snapshot could not be taken. */
  /** with: the model this one message was sent with (Send with…), when it was not the project's own. */
  | { kind: "user"; text: string; uuid?: string; tree?: string; with?: string }
  | { kind: "assistant"; text: string }
  /** toolId: the tool's id, which its result refers to. detail: what it did (the command, the change), for the expandable line. file: the file an edit or a new file touched; the chat does not show it, a handoff to another AI does. */
  | { kind: "tool"; text: string; toolId?: string; detail?: string; file?: string }
  /** A quiet divider line for something that happened to the conversation (a switch of AI, going back, a compaction, a background task), not an AI step. */
  /** until: when a usage limit lifts (epoch ms), for a note about one: the page writes the time in the viewer's zone. */
  | { kind: "note"; text: string; until?: number }
  /** result: what a tool gave back, trimmed by resultText. failed: the tool errored. */
  | { kind: "result"; toolId: string; output: string; failed?: boolean }
  /** form: a question card ("question", with questions) or a plan card ("plan", with plan). Neither is set for a permission question. */
  /** always: the standing rule an "Always allow" would save for this ask (only for a permission question that is safe to remember). */
  | { kind: "ask"; requestId: string; text: string; detail?: string; why?: string; form?: "question" | "plan"; questions?: AskQuestion[]; plan?: string; always?: { rule: string; label: string } }
  /** reply: what the person answered or asked for, when a question or plan card was answered with text. */
  | { kind: "answer"; requestId: string; allow: boolean; reply?: string }
  /** worked: how long the turn ran (ms). planDelta: the plan's five-hour window percent the turn used, for the owner only (snapshot strips it for others). */
  | { kind: "done"; worked?: number; planDelta?: number; model?: string; tokens?: { in: number; out: number } }
  /** planDelta: the plan share of the turn that ended just before it, sent once the usage is read (owner only). The chat view merges it into that turn's done line. */
  | { kind: "plan"; planDelta: number }
  | { kind: "error"; text: string; until?: number }
  /** The handoff note a fresh session starts from (see "Continue fresh"): shown as a collapsed card. */
  | { kind: "handoff"; text: string };

export type ChatEvent = { n: number; at: number } & Body;

/** A path inside the worktree is shown relative to it; anything else as given. */
export function rel(p: unknown, cwd: string): string {
  const s = String(p ?? "");
  if (isAbsolute(s) && (s === cwd || s.startsWith(cwd + "/"))) return relative(cwd, s) || ".";
  return s;
}

/** A plain-English one-liner of an action the agent took, with no file names ("Updated your page", "Looked around").
 *  ChatView parses these prefixes to group the lines ("Updated your page", "Looked around", "Ran: ",
 *  "Searched", "Opened ", "Asked a helper"): keep them in step with its classifier (it also still reads the older "Created ", "Edited ", "Read "). */
export function describeTool(name: string, input: Record<string, any>, _cwd: string): string {
  switch (name) {
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "Updated your page";
    case "Read":
    case "Glob":
    case "Grep":
      return "Looked around";
    case "Bash":
      return `Ran: ${input.description || String(input.command ?? "").slice(0, 80)}`;
    case "WebFetch":
      return `Opened ${input.url ?? ""}`;
    case "WebSearch":
      return `Searched the web for ${input.query ?? ""}`;
    case "Agent":
    case "Task":
      return "Asked a helper to look into it";
    default:
      if (name === "mcp__browser__agent_browser_open") return `Opened ${input.url ?? "a page"} in the browser`;
      return name.startsWith("mcp__browser__") ? "Used the browser" : `Used ${name}`;
  }
}

/** The file a Write or Edit touched, relative to the worktree, or undefined. The tool line names no file, so this is kept beside it. Pure. */
export function toolFile(name: string, input: Record<string, any>, cwd: string): string | undefined {
  if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name)) return undefined;
  const p = input.file_path ?? input.notebook_path;
  return typeof p === "string" && p ? rel(p, cwd) : undefined;
}

/** What a tool did, in full, for an expandable line: the command, the lines changed, the address or the search. Undefined when there is nothing to show. Pure. */
export function toolDetail(name: string, input: Record<string, any>, cwd: string): string | undefined {
  const cut = (s: string, cap: number) => (s.length > cap ? s.slice(0, cap - 2) + "\n…" : s);
  const diff = (oldText: unknown, newText: unknown) => [
    ...String(oldText ?? "").split("\n").map((l) => `- ${l}`),
    ...String(newText ?? "").split("\n").map((l) => `+ ${l}`),
  ];
  switch (name) {
    case "Bash":
      return String(input.command ?? "").slice(0, 2000) || undefined;
    case "Edit":
      return cut(diff(input.old_string, input.new_string).join("\n"), 4000);
    case "MultiEdit": {
      const edits: any[] = Array.isArray(input.edits) ? input.edits : [];
      return cut(edits.map((e) => diff(e?.old_string, e?.new_string).join("\n")).join("\n\n"), 4000) || undefined;
    }
    case "Write": {
      const text = String(input.content ?? "");
      return text ? cut(text.split("\n").slice(0, 40).map((l) => `+ ${l}`).join("\n"), 4000) : undefined;
    }
    case "WebFetch":
      return String(input.url ?? "") || undefined;
    case "WebSearch":
      return String(input.query ?? "") || undefined;
    case "Glob":
    case "Grep": {
      const pattern = String(input.pattern ?? "");
      if (!pattern) return undefined;
      return input.path ? `${pattern} in ${rel(input.path, cwd)}` : pattern;
    }
    default:
      return undefined;
  }
}

/** What a tool result says, for its expandable line: the text of its text blocks, ANSI colour codes removed, and only the last 60 lines and 4000 characters. Pure. */
export function resultText(content: unknown): string {
  let text = typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((c: any) => (c?.type === "text" && typeof c.text === "string" ? [c.text] : [])).join("\n") : "";
  text = text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\n+$/, "");
  const lines = text.split("\n");
  let cut = lines.length > 60;
  if (cut) text = lines.slice(-60).join("\n");
  if (text.length > 4000) {
    text = text.slice(-4000);
    cut = true;
  }
  return cut ? `…\n${text}` : text;
}

/** The permission question for a browser tool, naming the site it acts on ("a website" when the page address is not known). */
function describeBrowserAsk(name: string, input: Record<string, any>, currentUrl: string | null): { text: string; detail?: string } {
  let site = "a website";
  try {
    site = (currentUrl && new URL(currentUrl).hostname) || site;
  } catch {
    /* not an address: say "a website" */
  }
  switch (name.replace("mcp__browser__agent_browser_", "")) {
    case "click":
    case "dblclick":
      return { text: `Claude wants to click on ${site}`, ...(input.selector ? { detail: String(input.selector) } : {}) };
    case "fill":
    case "type":
      return { text: `Claude wants to type into a form on ${site}`, detail: String(input.text ?? "").slice(0, 80) };
    case "press":
      return { text: `Claude wants to press a key on ${site}`, detail: String(input.key ?? "") };
    case "eval":
      return { text: `Claude wants to run a script on ${site}`, detail: String(input.script ?? "").slice(0, 300) };
    default:
      return { text: `Claude wants to use the browser on ${site}`, detail: JSON.stringify(input).slice(0, 300) };
  }
}

/** The permission question for a risky action: what it asks, the detail to show under it, and why (the model's own words, for a command). */
export function describeAsk(name: string, input: Record<string, any>, cwd: string, currentUrl: string | null = null): { text: string; detail?: string; why?: string } {
  if (name.startsWith("mcp__browser__")) return describeBrowserAsk(name, input, currentUrl);
  switch (name) {
    case "Write":
      return { text: `Claude wants to create the file ${rel(input.file_path, cwd)}` };
    case "Edit":
    case "MultiEdit":
      return { text: `Claude wants to change the file ${rel(input.file_path, cwd)}` };
    case "Bash":
      return {
        text: "Claude wants to run a command",
        detail: String(input.command ?? ""),
        ...(input.description ? { why: String(input.description) } : {}),
      };
    case "WebFetch":
      return { text: `Claude wants to open ${input.url ?? ""}` };
    default:
      return { text: `Claude wants to use ${name}`, detail: JSON.stringify(input).slice(0, 300) };
  }
}

/** A question card or plan card for AskUserQuestion / ExitPlanMode, or null for any other tool (and for an empty question or plan). Pure. */
export function askForm(tool: string, input: Record<string, any>): { text: string; form: "question"; questions: AskQuestion[] } | { text: string; form: "plan"; plan: string } | null {
  if (tool === "AskUserQuestion") {
    const questions: AskQuestion[] = [];
    for (const q of Array.isArray(input.questions) ? input.questions : []) {
      const question = typeof q?.question === "string" ? q.question.slice(0, 500) : "";
      if (!question.trim()) continue;
      const options: AskQuestion["options"] = [];
      for (const o of Array.isArray(q.options) ? q.options : []) {
        const label = typeof o?.label === "string" ? o.label.slice(0, 200) : "";
        if (!label.trim()) continue;
        options.push({ label, ...(typeof o.description === "string" ? { description: o.description.slice(0, 500) } : {}) });
        if (options.length === 8) break;
      }
      questions.push({
        question,
        ...(typeof q.header === "string" ? { header: q.header.slice(0, 40) } : {}),
        ...(q.multiSelect === true ? { multiSelect: true } : {}),
        options,
      });
      if (questions.length === 4) break;
    }
    if (questions.length === 0) return null;
    return { text: questions.length === 1 ? "Claude has a question" : `Claude has ${questions.length} questions`, form: "question", questions };
  }
  if (tool === "ExitPlanMode") {
    const plan = String(input.plan ?? "").slice(0, MAX_TEXT);
    if (!plan.trim()) return null;
    return { text: "Claude's plan is ready", form: "plan", plan };
  }
  return null;
}

/** The control_response body for a permission question, and the words the person gave (the reply, when there are any). Pure. */
export function answerResponse(
  tool: string,
  input: Record<string, unknown>,
  allow: boolean,
  extra: { answers?: Record<string, string>; message?: string; remember?: string },
): { response: Record<string, unknown>; reply?: string } {
  if (tool === "AskUserQuestion") {
    if (!allow) return { response: { behavior: "deny", message: "The user chose not to answer." } };
    // The card shows a question cut to 500 characters, so its answer may come back under the cut text: file it under the full one.
    const known = new Map<string, string>();
    for (const q of Array.isArray(input.questions) ? input.questions : []) {
      if (typeof q?.question !== "string") continue;
      known.set(q.question, q.question);
      known.set(q.question.slice(0, 500), q.question);
    }
    const answers: Record<string, string> = Object.create(null);
    for (const [question, value] of Object.entries(extra.answers ?? {})) {
      const full = known.get(question);
      if (full !== undefined && typeof value === "string" && value.trim()) answers[full] = value.slice(0, 2000);
    }
    return { response: { behavior: "allow", updatedInput: { ...input, answers } }, reply: Object.values(answers).join("; ") };
  }
  if (tool === "ExitPlanMode") {
    if (allow) return { response: { behavior: "allow", updatedInput: input } };
    const message = String(extra.message ?? "").trim().slice(0, 2000);
    if (!message) return { response: { behavior: "deny", message: "The user did not approve the plan." } };
    return { response: { behavior: "deny", message: `The user wants changes to the plan: ${message}` }, reply: message };
  }
  if (!allow) return { response: { behavior: "deny", message: "The user said no." } };
  // "Always allow": Claude is also told to remember the rule for this session (best effort; the rule is kept on the project and passed with --allowedTools at every start)
  const remember = extra.remember && validRule(extra.remember) ? [{ type: "addRules", rules: [ruleParts(extra.remember)], behavior: "allow", destination: "session" }] : undefined;
  return { response: { behavior: "allow", updatedInput: input, ...(remember ? { updatedPermissions: remember } : {}) } };
}

/** What the user reads when Claude fails. The raw CLI text goes to the server log, not the chat. */
export function friendlyError(raw: string): string {
  if (/overloaded|\b529\b/i.test(raw) && !limitReached(raw)) return "Claude is busy right now. Try again in a little while.";
  if (/usage limit|rate limit|limit reached|quota/i.test(raw) || limitReached(raw)) return "Claude has reached its usage limit for now. Try again in a little while.";
  if (/not logged in|log ?in|login|authenticat|401|invalid api key|credential/i.test(raw)) return "Claude is signed out on this server. Open Settings → Agents to check the connection.";
  if (/is not installed on this server/i.test(raw)) return "Claude is not set up on this server yet. Open Settings → Agents.";
  return "Something went wrong on Claude's side. Try again.";
}

/** The names the "Switched to" line shows: the same as web/src/lib/agentName.ts. */
export const AGENT_NAMES: Record<string, string> = { claude: "Claude", hermes: "Hermes", omp: "omp", codex: "Codex", gemini: "Gemini", opencode: "OpenCode", pi: "Pi", sh: "Terminal" };
/** Lines that were notes before they had their own kind: saved conversations still hold them as tool lines. */
const OLD_NOTE_LINE = /^(Switched to |Went back to before: |Background task finished|A background task finished|Conversation compacted)/;

/** The conversation as one line per message or action, oldest first, for an AI that joins it: the first message the person sent is always kept, then the latest lines as far as the budget goes, and a line says how many were left out. "" when there is nothing. Pure.
 *  ponytail: the summary is cut by characters, not by tokens. _fromName is not used: the lines say "Assistant", so the new AI is not told which AI it replaces. */
export function handoffText(events: ChatEvent[], _fromName: string, budget = 12000): string {
  const oneLine = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > 240 ? `${t.slice(0, 237)}...` : t;
  };
  const answered = new Set(events.flatMap((e) => (e.kind === "answer" ? [e.requestId] : [])));
  const lines: string[] = [];
  for (const e of events) {
    if (e.kind === "user") lines.push(oneLine(`Person: ${e.text}`));
    else if (e.kind === "assistant") lines.push(oneLine(`Assistant: ${e.text}`));
    else if (e.kind === "tool" && e.text.trim() && !OLD_NOTE_LINE.test(e.text)) lines.push(oneLine(`Did: ${e.text}${e.file ? ` (${e.file})` : ""}`));
    else if (e.kind === "ask" && answered.has(e.requestId)) lines.push(oneLine(`Assistant asked: ${e.questions?.map((q) => q.question).join(" ") || e.plan || e.text}`));
  }
  if (lines.length === 0) return "";
  const omit = (n: number) => `(… ${n} earlier lines left out …)`;
  const reserve = omit(lines.length).length + 1;
  const first = lines.findIndex((l) => l.startsWith("Person: "));
  const keep = new Set<number>();
  let used = 0;
  if (first >= 0) {
    keep.add(first);
    used += lines[first].length + 1;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (keep.has(i)) continue;
    if (used + lines[i].length + 1 + reserve > budget) break;
    keep.add(i);
    used += lines[i].length + 1;
  }
  const omitted = lines.length - keep.size;
  const out: string[] = [];
  if (first < 0 && omitted > 0) out.push(omit(omitted));
  lines.forEach((l, i) => {
    if (!keep.has(i)) return;
    out.push(l);
    if (i === first && omitted > 0) out.push(omit(omitted));
  });
  return out.join("\n");
}

/** The one-line note for a finished background task, from its <task-notification> text. */
export function taskFinishedLine(text: string): string {
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1].trim().slice(0, 120);
  return summary ? `Background task finished: ${summary}` : "A background task finished";
}

/** The quiet line for a CLI system notice (a model switch, a compaction), or null for any other notice. Pure. */
export function noticeText(m: any): string | null {
  if (m?.subtype === "model_fallback") {
    const model = typeof m.fallback_model === "string" ? m.fallback_model : "another model";
    return `Switched to ${model} because the first choice was unavailable`;
  }
  if (m?.subtype === "compact_boundary") return "Conversation compacted to save space";
  return null;
}

/** One item of Claude's checklist: its text and where it stands. */
export type Todo = { text: string; status: "pending" | "active" | "done"; id?: string; subject?: string; form?: string };

/** What a clock time reads as in a sentence the server writes: UTC, because the server does not know the viewer's zone. The page writes its own in the viewer's zone. */
export const clockText = (at: number) => `${new Date(at).toISOString().slice(11, 16)} UTC`;
