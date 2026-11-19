/**
 * What each AI can really do in Kohlab, for Settings → AI ("What it can do") and the model picker's outcome lines.
 *
 * Pure: no React, no fetches. Every fact below is backed by code, cited in the comment beside it. A tile whose
 * fact the code cannot show is not here; there are no "coming" tiles and no invented numbers.
 * scripts/check-capabilities.mjs checks the table: every provider, every tile, at most eight, no roadmap words.
 */
import type { ProviderCard, ProviderModel } from "../types";
import { EFFORT_LABEL } from "./aiHub";

export type CapabilityId = "pictures" | "web" | "code" | "apps" | "effort" | "memory" | "team" | "plan";
/** yes: it does it. depends: it does it only under conditions the words say. summary: a summary only, not the full tools. no: Kohlab does not do it for this AI. */
export type CapabilityState = "yes" | "depends" | "summary" | "no";
export interface CapabilityTile {
  id: CapabilityId;
  title: string;
  state: CapabilityState;
  detail: string;
}

const TITLE: Record<CapabilityId, string> = {
  pictures: "Sees pictures",
  web: "Uses the web",
  code: "Runs code",
  apps: "Connected apps",
  effort: "Thinks longer",
  memory: "Remembers this project",
  team: "Works in a team",
  plan: "Plans first",
};

/** One fact per capability; `effort` is read from the models list, so it is not in this table. */
type Facts = Record<Exclude<CapabilityId, "effort">, [CapabilityState, string]>;

// ACP agents (chat.ts routes them through acp.ts): the facts they share. Each one's own tools are its own business,
// so "depends" where the AI decides. Runs code: policy.ts maps the ACP "execute" kind to Bash and handles it under the
// chosen mode. Apps: acp.ts sends mcpServers: [] to every session. Memory: chat.ts notesMessagePrefix sends the brain's
// summary in the first message only. Team: team.ts builds members with agent "claude" and accepts only Claude accounts.
// Plan first: aiHub.ts modeChoices offers it to Claude only.
const ACP: Facts = {
  pictures: ["depends", "Depends on the AI and its model. The picture reaches it as a file to open."],
  web: ["depends", "Depends on the AI. Kohlab allows its page fetches under the chosen mode."],
  code: ["yes", "Runs commands and edits files, under the mode you choose."],
  apps: ["no", "Chats connect no outside apps."],
  memory: ["summary", "Reads a summary of this project's notes when a chat starts."],
  team: ["no", "A team is Claude only."],
  plan: ["no", "Plan first is Claude's only."],
};

// Claude: the chat runs `claude` with its built-in tools (chat.ts spawn args, no tool list); Kohlab's brain tools
// (chat.ts brainMcp: recall, remember) for a chat, with --strict-mcp-config so no user MCP servers load in chats (chat.ts ~1028); attachments are saved in the project's uploads folder
// (server.ts handleImageUpload, chat.ts system prompt line 56). Team members use Claude (team.ts ensureMember).
const CLAUDE: Facts = {
  pictures: ["yes", "Opens the pictures you attach."],
  web: ["yes", "Fetches pages and searches the web, under the mode you choose."],
  code: ["yes", "Runs commands and edits files, under the mode you choose."],
  apps: ["depends", "Chats use only Kohlab's own tools. Other projects also load your own Claude apps."],
  memory: ["yes", "Recalls and saves this project's notes with its own tools."],
  team: ["yes", "A team of Claude helpers works on one project, each in its own copy."],
  plan: ["yes", "Plans first, then waits for your go-ahead before it changes anything."],
};

/** Per provider. Keys are ProviderId values from providers.ts. */
export const CAPABILITIES: Record<string, Facts> = {
  claude: CLAUDE,
  codex: ACP,
  hermes: ACP,
  omp: ACP,
  // OpenCode is an ACP agent too: acp.ts sends mcpServers: [] to it, so Kohlab connects no apps. Its "connections" (providers.ts
  // OpencodeConnection) are model-service sign-ins, not apps, so this is a plain no.
  opencode: ACP,
};

/** The tiles for one AI card, in the order the grid shows them. At most eight. Unknown AIs get none. */
export function capabilityTiles(card: ProviderCard, models: ProviderModel[]): CapabilityTile[] {
  const facts = CAPABILITIES[card.id];
  if (!facts) return [];
  const efforts = [...new Set(models.flatMap((m) => m.efforts ?? []))];
  // Effort levels exist only where the models list names them (providers.ts claudeModels).
  const effort: CapabilityTile = efforts.length
    ? { id: "effort", title: TITLE.effort, state: "yes", detail: `Levels: ${efforts.map((e) => EFFORT_LABEL[e] ?? e).join(", ")}.` }
    : { id: "effort", title: TITLE.effort, state: "no", detail: "Its models set no effort levels." };
  type Fact = Exclude<CapabilityId, "effort">;
  const tile = (id: Fact): CapabilityTile => ({ id, title: TITLE[id], state: facts[id][0], detail: facts[id][1] });
  const before: Fact[] = ["pictures", "web", "code", "apps"];
  const after: Fact[] = ["memory", "team", "plan"];
  return [...before.map(tile), effort, ...after.map(tile)];
}

/** Plain-words outcome for the known Claude models, keyed by the id's family name (the id after any "claude-"). */
const OUTCOME: [prefix: string, line: string][] = [
  ["opus", "Strongest · for big or tricky work"],
  ["sonnet", "Everyday · a good default for building"],
  ["haiku", "Quickest · for small edits and questions"],
];

/** The outcome line for a model, or null when the model is not one of the known Claude families. Pure. */
export function modelOutcome(model: Pick<ProviderModel, "value">): string | null {
  const id = model.value.toLowerCase().replace(/^claude-/, "");
  return OUTCOME.find(([prefix]) => id.startsWith(prefix))?.[1] ?? null;
}
