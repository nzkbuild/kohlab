#!/usr/bin/env bun
/**
 * The capability tiles behind Settings → AI: every AI has its tiles, each tile has a known state and words that
 * say what it is, no more than eight, and no roadmap wording ("coming", "soon", "planned"). Pure: nothing is fetched.
 * The states are not invented: capabilities.ts cites the code for each one.
 *
 * Run:  bun scripts/check-capabilities.mjs
 */
import { readFileSync } from "node:fs";
import { CAPABILITIES, capabilityTiles, modelOutcome } from "../web/src/lib/capabilities.ts";
import { PROVIDER_IDS } from "../providers.ts";

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const STATES = ["yes", "depends", "summary", "no"];
const ROADMAP = /\b(coming|soon|planned|roadmap|later|preview of)\b/i;
const card = (id, extra = {}) => ({ id, name: id, kind: "cli", installed: true, version: null, state: "connected", checkedAt: 0, stale: false, accounts: [], actions: [], ...extra });
const withEffort = [{ value: "opus", efforts: ["low", "high", "max"] }];

for (const id of PROVIDER_IDS) {
  check(`${id}: has a capability table`, Boolean(CAPABILITIES[id]));
  const tiles = capabilityTiles(card(id), []);
  check(`${id}: eight tiles, no more`, tiles.length === 8, `${tiles.length}`);
  check(`${id}: every state is known`, tiles.every((t) => STATES.includes(t.state)), tiles.filter((t) => !STATES.includes(t.state)).map((t) => t.id).join(", "));
  check(`${id}: every tile has a title and detail`, tiles.every((t) => t.title && t.detail));
  check(`${id}: no roadmap words`, tiles.every((t) => !ROADMAP.test(`${t.title} ${t.detail}`)), tiles.filter((t) => ROADMAP.test(`${t.title} ${t.detail}`)).map((t) => t.id).join(", "));
  check(`${id}: no invented numbers in details`, tiles.every((t) => !/\d/.test(t.detail) || t.id === "effort"));
}

// Claude has effort levels in its models; with none the tile says no, with some it names the levels.
const claude = capabilityTiles(card("claude"), withEffort);
check("claude: effort tile yes when the models name levels", claude.find((t) => t.id === "effort")?.state === "yes");
check("claude: effort levels named from the models", claude.find((t) => t.id === "effort")?.detail === "Levels: Low, High, Max.", claude.find((t) => t.id === "effort")?.detail);
check("claude: effort tile no without levels", capabilityTiles(card("claude"), [{ value: "sonnet" }]).find((t) => t.id === "effort")?.state === "no");
check("unknown AI has no tiles", capabilityTiles(card("gemini"), []).length === 0);
check("claude: team and plan are yes (team.ts, modeChoices)", claude.find((t) => t.id === "team")?.state === "yes" && claude.find((t) => t.id === "plan")?.state === "yes");
check("codex: team and plan are no", capabilityTiles(card("codex"), []).filter((t) => ["team", "plan"].includes(t.id)).every((t) => t.state === "no"));

// The model picker's outcome lines: the three Claude families, and nothing for the rest.
check("opus outcome", modelOutcome({ value: "opus" }) === "Strongest · for big or tricky work");
check("claude-sonnet outcome", modelOutcome({ value: "claude-sonnet-5-5" }) === "Everyday · a good default for building");
check("haiku outcome", modelOutcome({ value: "haiku" }) === "Quickest · for small edits and questions");
check("unknown model has no outcome line", modelOutcome({ value: "default" }) === null);

// Wired in check-all next to check-run-text (static text of the runner, so a removal is caught).
const all = readFileSync(new URL("./check-all.mjs", import.meta.url), "utf8");
check("wired in check-all", all.includes('"scripts/check-capabilities.mjs"') || all.includes("check-capabilities.mjs"));

console.log(failures ? `\n${failures} failed` : "\nall capability checks passed");
process.exit(failures ? 1 : 0);
