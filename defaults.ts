/**
 * Which AI settings a project has of its own and which it inherits from the server's defaults. Pure.
 *
 * Order for every field: the project's own value, then the server default, then the built-in value. A project field
 * that is set (even to "default") is an override; one that is undefined inherits. Terminal projects ignore the defaults.
 * The AI and the account follow the defaults only until the first message; then they are pinned to the project.
 */
import type { AiDefaults, AiResolved, AiSetting, Effort, Mode, Workspace } from "./types";
import { isMode } from "./policy";

export const EFFORT_LIST: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const isEffort = (x: unknown): x is Effort => typeof x === "string" && (EFFORT_LIST as string[]).includes(x);

const pick = <T>(own: T | undefined, inherited: T | undefined, builtin: T | null): AiSetting<T> =>
  own !== undefined ? { value: own, source: "project" } : inherited !== undefined ? { value: inherited, source: "default" } : { value: builtin, source: "builtin" };

/** Every setting of a project with where it comes from. Pure. */
export function resolveAi(ws: Workspace, defaults: AiDefaults | undefined): AiResolved {
  const d: AiDefaults = ws.chat ? (defaults ?? {}) : {};
  // a project that has not had a message yet follows the defaults for its AI and account
  const pinned = ws.agentPinned === true;
  const agent: AiSetting<string> = pinned ? { value: ws.agent, source: "project" } : d.agent ? { value: d.agent, source: "default" } : { value: ws.agent, source: "builtin" };
  const account: AiSetting<string> = pinned ? { value: ws.account ?? null, source: "project" } : d.account ? { value: d.account, source: "default" } : { value: null, source: "builtin" };
  const isClaude = agent.value === "claude";
  const mode = ws.permissionMode === "dontAsk" ? ("default" as Mode) : (ws.permissionMode as Mode | undefined);
  return {
    agent,
    account,
    model: pick(isClaude ? ws.model : ws.agentModel, d.model, "default"),
    effort: pick<Effort>(ws.effort, d.effort, null),
    mode: pick<Mode>(mode, d.mode, "default"),
    autoFresh: pick<boolean>(ws.autoFresh, d.autoFresh, true),
  };
}

/** One resolved value. Pure. */
export function effective<K extends keyof AiResolved>(ws: Workspace, defaults: AiDefaults | undefined, field: K): AiResolved[K]["value"] {
  return resolveAi(ws, defaults)[field].value;
}

/** Which project field a setting lives in, so "reset" can clear it. */
export const RESET_FIELDS = ["model", "effort", "mode", "autoFresh", "agent", "account"] as const;
export type ResetField = (typeof RESET_FIELDS)[number];

export interface DefaultsCheck {
  installed: (agent: string) => boolean;
  accountOk: (id: string, agent: string | undefined) => boolean;
  owner: boolean;
}

/** A change to the defaults: keys with null are cleared. The result is the new defaults, or a refusal with its HTTP status. Pure (the checks come in as functions). */
export function patchDefaults(current: AiDefaults | undefined, patch: unknown, ok: DefaultsCheck): { defaults: AiDefaults } | { error: string; status: number } {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { error: "Send the settings to change.", status: 400 };
  if (!ok.owner) return { error: "Only the owner can change the defaults.", status: 403 };
  const p = patch as Record<string, unknown>;
  const next: AiDefaults = { ...current };
  for (const key of Object.keys(p)) {
    if (!["agent", "account", "model", "effort", "mode", "autoFresh"].includes(key)) return { error: `“${key}” is not a setting.`, status: 400 };
    const v = p[key];
    if (v === null) {
      delete next[key as keyof AiDefaults];
      continue;
    }
    switch (key) {
      case "agent":
        if (typeof v !== "string" || !ok.installed(v)) return { error: "That AI is not installed on this server.", status: 400 };
        next.agent = v;
        break;
      case "account":
        if (typeof v !== "string" || !ok.accountOk(v, typeof p.agent === "string" ? p.agent : next.agent)) return { error: "That account does not exist.", status: 400 };
        next.account = v;
        break;
      case "model":
        if (typeof v !== "string" || v.length === 0 || v.length > 200 || /[\s\x00-\x1f]/.test(v)) return { error: "That model is not valid.", status: 400 };
        next.model = v;
        break;
      case "effort":
        if (!isEffort(v)) return { error: "That effort level is not available.", status: 400 };
        next.effort = v;
        break;
      case "mode":
        if (!isMode(v)) return { error: "That mode is not available.", status: 400 };
        next.mode = v;
        break;
      case "autoFresh":
        if (typeof v !== "boolean") return { error: "That setting must be on or off.", status: 400 };
        next.autoFresh = v;
        break;
    }
  }
  // an account belongs to one AI: changing the AI drops an account that no longer fits
  if (next.account && next.agent && !ok.accountOk(next.account, next.agent)) delete next.account;
  return { defaults: next };
}
