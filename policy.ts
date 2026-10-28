/**
 * What the AI may do without asking, and what to do when it runs out of plan. Pure: nothing here starts a process,
 * touches a file or reads the clock except where a parameter says so. chat.ts and acp.ts call it.
 *
 * Rules are written in Claude's own permission syntax so they can be handed to `claude --allowedTools`:
 * "Bash(npm test:*)", "Edit", "WebFetch(domain:example.com)", "mcp__browser__agent_browser_click".
 */
import { isAbsolute, normalize, relative } from "node:path";
import type { FallbackStep, Mode } from "./types";

export const MODE_LIST: Mode[] = ["default", "acceptEdits", "auto", "plan", "full"];
export const isMode = (x: unknown): x is Mode => typeof x === "string" && (MODE_LIST as string[]).includes(x);

/** What Claude is started with for a mode, and whether Kohlab answers its asks itself. Claude is never started in bypassPermissions: it refuses that as root, and Kohlab can see every ask this way. Pure. */
export function claudeArgsFor(mode: string): { permissionMode: string; fullAccess: boolean } {
  if (mode === "full") return { permissionMode: "default", fullAccess: true };
  return { permissionMode: mode, fullAccess: false };
}

/** Asks that are always the person's to answer, whatever the mode. */
export const PERSONAL_ASKS = new Set(["AskUserQuestion", "ExitPlanMode"]);

// ---- saved rules ----

const RULE_OK = /^[A-Za-z_][\w:*.()\- /@=]+$/;
export const MAX_RULES = 50;

/** A rule that may be saved and handed to Claude: shape and length only. Pure. */
export function validRule(rule: unknown): rule is string {
  return typeof rule === "string" && rule.length <= 200 && RULE_OK.test(rule);
}

/** A rule list as it may be stored: valid ones only, no repeats, at most MAX_RULES. Pure. */
export function cleanRules(rules: unknown): string[] {
  const out: string[] = [];
  for (const r of Array.isArray(rules) ? rules : []) if (validRule(r) && !out.includes(r)) out.push(r);
  return out.slice(0, MAX_RULES);
}

/** A command that is not one plain command (a second command, a pipe, a redirection, an expansion). */
const COMPOUND = /[;&|`<>$\n\r\\]/;
/** First words no rule is ever offered for: they hand the AI more than the one thing that was asked. */
const NO_RULE_WORDS = new Set(["sudo", "rm", "dd", "curl", "wget", "sh", "bash", "zsh", "eval", "exec", "ssh", "nc", "ncat", "mkfs", "shutdown", "reboot", "xargs", "env", "su", "doas"]);
/** git subcommands that lose work or leave the machine. */
const GIT_NO_RULE = new Set(["push", "reset", "clean", "rebase", "checkout", "restore", "filter-branch"]);

/** A path the AI is never given a standing yes for: outside the project, or a place secrets and history live. Pure. */
export function deniedPath(path: unknown, cwd: string): boolean {
  if (typeof path !== "string" || !path || !cwd) return true;
  const abs = isAbsolute(path) ? normalize(path) : normalize(`${cwd}/${path}`);
  const rel = relative(cwd, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return true;
  const parts = rel.split("/");
  return parts.some((p) => p === ".git" || p === ".ssh" || p === ".aws" || p === ".gnupg" || p === ".kohlab") || /(^|\/)\.env(\.|$)/.test(rel) || /(^|\/)(id_rsa|id_ed25519|credentials[^/]*|\.npmrc|\.netrc)$/.test(rel);
}

/** The one plain command of a Bash call: its first word and an optional second plain word. Null when it is not one plain command. Pure. */
function plainCommand(command: unknown): { cmd: string; sub: string | null } | null {
  if (typeof command !== "string") return null;
  const c = command.trim();
  if (!c || c.length > 400 || COMPOUND.test(c)) return null;
  const words = c.split(/\s+/);
  const cmd = words[0];
  if (!/^[A-Za-z][\w+]*$/.test(cmd) || NO_RULE_WORDS.has(cmd)) return null;
  return { cmd, sub: words[1] && /^[A-Za-z][\w]*$/.test(words[1]) ? words[1] : null };
}

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** The standing rule an "Always allow" would save for this ask, or null when none is safe to offer (compound commands, pipes, redirections, sudo, rm, dd, curl, a denied path, an unknown tool). Pure. */
export function ruleFor(tool: string, input: Record<string, unknown>, cwd?: string): { rule: string; label: string } | null {
  if (tool === "Bash") {
    const p = plainCommand(input.command);
    // one word alone ("python3", "ls") would be too wide; the second word narrows it ("npm test")
    if (!p || p.sub === null) return null;
    if (p.cmd === "git" && GIT_NO_RULE.has(p.sub)) return null;
    return mk(`Bash(${p.cmd} ${p.sub}:*)`);
  }
  if (EDIT_TOOLS.has(tool)) {
    const path = input.file_path ?? input.notebook_path ?? input.path;
    return cwd && !deniedPath(path, cwd) ? mk("Edit") : null;
  }
  if (tool === "WebFetch") {
    try {
      const u = new URL(String(input.url ?? ""));
      return (u.protocol === "https:" || u.protocol === "http:") && u.hostname ? mk(`WebFetch(domain:${u.hostname})`) : null;
    } catch {
      return null;
    }
  }
  if (/^mcp__browser__[\w-]+$/.test(tool)) return mk(tool);
  return null;
}

function mk(rule: string): { rule: string; label: string } | null {
  if (!validRule(rule)) return null;
  const words = describeRule(rule);
  return { rule, label: words.charAt(0).toLowerCase() + words.slice(1) };
}

/** A rule split the way Claude's permission updates want it: the tool, and what narrows it. "Bash(npm test:*)" is {Bash, "npm test:*"}. Pure. */
export function ruleParts(rule: string): { toolName: string; ruleContent?: string } {
  const m = /^([\w-]+)\((.*)\)$/.exec(rule);
  return m ? { toolName: m[1], ruleContent: m[2] } : { toolName: rule };
}

/** A rule in plain words. Pure. */
export function describeRule(rule: string): string {
  const bash = /^Bash\((.+):\*\)$/.exec(rule);
  if (bash) return `Run commands that start with “${bash[1]}”`;
  const web = /^WebFetch\(domain:(.+)\)$/.exec(rule);
  if (web) return `Open pages on ${web[1]}`;
  if (rule === "Edit") return "Change files in the project";
  if (rule.startsWith("mcp__browser__")) return `Use the browser: ${rule.replace(/^mcp__browser__(agent_browser_)?/, "").replace(/_/g, " ")}`;
  if (rule === "Bash") return "Run any command";
  if (rule === "Read" || rule === "Glob" || rule === "Grep") return "Look at files in the project";
  if (rule === "WebFetch" || rule === "WebSearch") return "Open pages and search the web";
  return rule.replace(/\(.*$/, "").replace(/_/g, " ");
}

/** Whether a saved rule covers this call. Same subset as ruleFor: used for the agents Kohlab decides for (ACP, Codex), never for Claude, which matches its own rules. Pure. */
export function ruleMatches(rule: string, tool: string, input: Record<string, unknown>, cwd?: string): boolean {
  if (rule === tool) return !EDIT_TOOLS.has(tool) || (!!cwd && !deniedPath(input.file_path ?? input.notebook_path ?? input.path, cwd));
  if (rule === "Edit") return EDIT_TOOLS.has(tool) && !!cwd && !deniedPath(input.file_path ?? input.notebook_path ?? input.path, cwd);
  const bash = /^Bash\((.+):\*\)$/.exec(rule);
  if (bash) {
    if (tool !== "Bash" || typeof input.command !== "string" || !plainCommand(input.command)) return false;
    const c = input.command.trim();
    return c === bash[1] || c.startsWith(`${bash[1]} `);
  }
  const web = /^WebFetch\(domain:(.+)\)$/.exec(rule);
  if (web && tool === "WebFetch") {
    try {
      return new URL(String(input.url ?? "")).hostname === web[1];
    } catch {
      return false;
    }
  }
  return false;
}

// ---- what Kohlab decides itself for ACP agents (Codex, Hermes, omp) ----

/** What an ACP agent's tool kind is called in a rule. */
export function acpToolName(kind: string, raw: Record<string, unknown>): string {
  if (kind === "execute") return "Bash";
  if (kind === "edit") return "Edit";
  if (kind === "fetch") return "WebFetch";
  return String(raw.tool ?? kind);
}

/** A command the "Auto" mode still asks about. */
const RISKY = [
  /(^|[\s;&|])sudo(\s|$)/,
  /(^|[\s;&|])rm\s+(-\S*[rRfF]\S*|--recursive|--force)/,
  /(curl|wget)\b[^|;]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
  /\bgit\s+push\b[^;&|]*(--force|-f\b|--force-with-lease)/,
  /\bchmod\s+(-\S*R|--recursive)/,
  /(^|[\s;&|])dd\s/,
  /\bmkfs/,
  />\s*\/dev\/(sd|nvme|disk)/,
];

/** Whether Auto still asks about a command. Pure. */
export function riskyCommand(command: unknown): boolean {
  const c = Array.isArray(command) ? command.map(String).join(" ") : typeof command === "string" ? command : "";
  return RISKY.some((r) => r.test(c));
}

/** Allow it at once, or ask the person. ask = looking is free, the rest asks; edits = + changing files; auto = + commands and web pages except risky commands; full = everything. Saved rules allow in every mode but full (which needs none). Pure. */
export function acpDecision(mode: string, kind: string, raw: Record<string, unknown> | undefined, rules: string[], cwd?: string): "allow" | "ask" {
  const input = raw && typeof raw === "object" ? raw : {};
  if (mode === "full") return "allow";
  const tool = acpToolName(kind, input);
  if (rules.some((r) => ruleMatches(r, tool, input, cwd))) return "allow";
  if (kind === "read" || kind === "search" || kind === "think") return "allow";
  if (mode === "acceptEdits" && kind === "edit") return "allow";
  if (mode === "auto") {
    if (kind === "edit") return "allow";
    if (kind === "execute") return riskyCommand(input.command) ? "ask" : "allow";
    if (kind === "fetch") return "allow";
  }
  return "ask";
}

// ---- usage limits ----

/** The stop of a plan: a usage limit, a rate limit or a weekly limit. An overloaded service (529) is the service's trouble, not the plan's. */
const LIMIT = /usage limit|limit reached|hit your limit|reached (your|its|the) .{0,20}limit|5-hour limit|weekly limit|rate[_ ]limit(_error)?|too many requests|\b429\b|quota (exceeded|reached)/i;
const OVERLOAD = /overloaded|\b529\b/i;

/** The reset time a CLI names in its own words ("resets 2:49pm", "resets at 14:49"), as epoch ms, or null. The time is read in the server's zone, as the CLI printed it. Pure. */
export function resetHint(raw: string, now: number): number | null {
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(raw);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Whether a failure says the plan is used up, and until when if it says so. Overload is not a limit. `windows` are the account's usage windows, when known. Pure. */
export function limitReached(raw: string, now = Date.now(), windows?: { resetsAt: string | null; severity?: string }[]): { until: number } | null {
  if (!raw || !LIMIT.test(raw) || (OVERLOAD.test(raw) && !/usage limit|limit reached|hit your limit|weekly limit|5-hour limit|rate[_ ]limit/i.test(raw))) return null;
  const hint = resetHint(raw, now);
  if (hint !== null) return { until: hint };
  const ends = (windows ?? [])
    .filter((w) => w.severity === "limit" && w.resetsAt)
    .map((w) => Date.parse(w.resetsAt!))
    .filter((t) => Number.isFinite(t) && t > now);
  if (ends.length) return { until: Math.min(...ends) };
  return { until: now + 30 * 60_000 };
}

/** The order to try when the AI hits its limit and the person set none: other signed-in accounts of the same AI that are not at a limit, then cheaper Claude models on the same account. Pure. */
export function defaultSteps(x: {
  agent: string;
  /** the lane that hit the limit: an account id, or null for the AI's own login */
  account: string | null;
  model: string | null;
  accounts: { id: string | null; connected: boolean; limited: boolean }[];
}): FallbackStep[] {
  const steps: FallbackStep[] = [];
  for (const a of x.accounts) if (a.id !== x.account && a.connected && !a.limited) steps.push({ account: a.id });
  if (x.agent === "claude") {
    const now = x.model && x.model !== "default" ? x.model : "sonnet";
    for (const m of ["haiku", "sonnet"]) if (m !== now && !(m === "sonnet" && (now === "haiku" || now === "sonnet"))) steps.push({ model: m });
  }
  return steps;
}
