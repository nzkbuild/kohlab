#!/usr/bin/env node
// The Team tab in the browser: the agents, the board's four columns, the activity feed, the one primary button,
// the phone's segmented switch and sheet, the start dialog and the role dialog. The team itself is a page.route mock
// on /api/workspaces/<id>/team, so this check does not depend on the server's team routes. The project is a real
// chat project on a throwaway server (its own PORT, WORKS_DIR and PTY_SOCKET).
// Skips with a printed reason when playwright-core or Chromium is missing.
//
//   cd web && bun run build && node scripts/check-team-ui.mjs
import { existsSync } from "node:fs";
import { findBrowser, openContext, startFixture } from "./ui-fixture.mjs";

const found = findBrowser();
if (!found) {
  console.log("skip: needs playwright-core and Chromium");
  process.exit(0);
}
if (!existsSync("web/dist/index.html")) {
  console.log("FAIL  web/dist is not built (cd web && bun run build)");
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
};

const KEY = "team-ui-check-key";
const PORT = 7877;
const NOW = Date.now();
const GOAL = "Add a contact page with a form";

const role = (id, kind, name, over = {}) => ({
  id,
  kind,
  name,
  member: "",
  model: kind === "lead" ? "sonnet" : "haiku",
  effort: "low",
  mode: kind === "lead" ? "plan" : "acceptEdits",
  instructions: "",
  budget: { tokens: 200000, minutes: 20 },
  spent: { tokens: 0, ms: 0, turns: 0 },
  state: "idle",
  line: "",
  since: NOW,
  inboxRead: 0,
  ...over,
});
const task = (id, title, status, over = {}) => ({ id, title, brief: "", area: [], deps: [], status, rounds: 0, spent: { tokens: 0, ms: 0, turns: 0 }, created: NOW - 600000, updated: NOW, ...over });

/** The team as the server answers it, with the status and the waiting asks the case needs. */
function teamFor(status, { needsYou = false } = {}) {
  return {
    id: "t1",
    project: "ready",
    goal: GOAL,
    status,
    created: NOW - 600000,
    updated: NOW,
    base: "main",
    int: "kohlab/team-t1",
    maxAgents: 2,
    gate: "final",
    budget: { tokens: 300000, minutes: 30 },
    spent: { tokens: 120000, ms: 240000, turns: 3 },
    roles: [
      role("lead", "lead", "Lead", { state: "working", since: NOW - 120000 }),
      role("builder-1", "builder", "Builder 1", { state: "working", since: NOW - 250000, taskId: "T2" }),
      role("builder-2", "builder", "Builder 2", { state: needsYou ? "needs_you" : "idle", since: NOW - 60000 }),
      role("reviewer", "reviewer", "Reviewer", { state: "idle" }),
    ],
    tasks: [
      task("T1", "Set up the page", "done", { assignee: "builder-1" }),
      task("T2", "Build the form", "working", { assignee: "builder-1" }),
      task("T3", "Send the message", "todo", { deps: ["T2"] }),
      task("T4", "Write the tests", "blocked"),
      task("T5", "Check the copy", "review", { assignee: "builder-2" }),
    ],
    needsYou: needsYou ? [{ kind: "ask", text: "Which field comes first?", role: "builder-2" }] : [],
    seq: 4,
    wakes: 2,
  };
}

const EVENTS = [
  { n: 1, at: NOW - 300000, kind: "task", from: "lead", text: "Planned five tasks." },
  { n: 2, at: NOW - 200000, kind: "message", from: "builder-1", to: "lead", text: "Started on the form." },
  { n: 3, at: NOW - 60000, kind: "state", from: "builder-2", text: "Asked: which field comes first?" },
];

/** A page.route handler for the team read: the team (or none) and the events after the number the page asked from. */
const serveTeam = (team) => async (route) => {
  const after = Number(new URL(route.request().url()).searchParams.get("after") ?? 0);
  await route.fulfill({ contentType: "application/json", body: JSON.stringify({ team, events: EVENTS.filter((e) => e.n > after) }) });
};
/** Matches GET and POST /api/workspaces/<id>/team, with or without a query. */
const isTeamPath = (url) => url.pathname.startsWith("/api/workspaces/") && url.pathname.endsWith("/team");

/** Runs in the page: primaries in the active tab, controls at least 24px (44 on touch), no spinner, no loop, no border. */
function measure(touch) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const label = (el) => `${el.tagName.toLowerCase()}[${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}]`;
  const root = document.querySelector('[role="tabpanel"][data-state="active"]') ?? document;
  const primaries = [...root.querySelectorAll(".btn-primary")].filter(visible).map(label);
  const min = touch ? 44 : 24;
  const small = [...root.querySelectorAll("button")]
    .filter(visible)
    .filter((el) => !el.matches("[disabled], [aria-disabled=true]"))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => Math.min(r.width, r.height) < min - 0.5)
    .map(({ el, r }) => `${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  const spinners = root.querySelectorAll('[aria-busy="true"], .animate-spin, [class*="spinner"]').length;
  const looping = [...root.querySelectorAll("svg *, aside *")].filter((el) => getComputedStyle(el).animationIterationCount === "infinite").length;
  // A border the eye can see: a width, a style, and a colour that is neither transparent nor the element's own fill
  // (the button base is a transparent 1px edge, and the primary button's edge is its accent fill).
  const seen = (s, side) => {
    const c = s[`border${side}Color`];
    return parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== "none" && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(c) && c !== s.backgroundColor;
  };
  const borders = [...root.querySelectorAll("*")]
    .filter((el) => {
      const s = getComputedStyle(el);
      return ["Top", "Right", "Bottom", "Left"].some((side) => seen(s, side));
    })
    .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`);
  return { primaries, small, spinners, looping, borders };
}

async function design(page, at, touch) {
  const m = await page.evaluate(measure, touch);
  check(`${at}: at most one primary button`, m.primaries.length <= 1, m.primaries.join(", "));
  check(`${at}: controls >= ${touch ? 44 : 24}px`, m.small.length === 0, m.small.slice(0, 4).join(", "));
  check(`${at}: no spinner`, m.spinners === 0);
  check(`${at}: no looping animation`, m.looping === 0, `${m.looping} elements`);
  check(`${at}: no borders in the Team view`, m.borders.length === 0, m.borders.slice(0, 4).join(", "));
  return m;
}

const pageErrors = (page, bucket) => page.on("pageerror", (e) => bucket.push(e.message));

/** Opens the project on its Team tab with the team the mock gives. Resolves once the goal is on screen. */
async function openTeam(browser, fx, { width = 1280, height = 900, touch = false, team }) {
  const ctx = await openContext(browser, { width, height, key: KEY, touch });
  const page = await ctx.newPage();
  const errors = [];
  pageErrors(page, errors);
  await page.route(isTeamPath, serveTeam(team));
  await page.goto(`${fx.base}/w/${fx.ready}/team`);
  await page.getByRole("heading", { name: GOAL, level: 2 }).waitFor({ timeout: 15000 }).catch(() => {});
  return { ctx, page, errors };
}

async function desktopRunning(browser, fx) {
  const { ctx, page, errors } = await openTeam(browser, fx, { team: teamFor("running", { needsYou: true }) });
  check("the Team tab is in the project's switch", await page.getByRole("tablist", { name: "Project views" }).getByRole("tab", { name: "Team", exact: true }).isVisible().catch(() => false));
  check("the goal is the page's second-level heading", await page.getByRole("heading", { name: GOAL, level: 2 }).isVisible().catch(() => false));
  check("the page has one h1 (the project's)", (await page.locator("h1").count()) === 1, `${await page.locator("h1").count()} h1`);

  for (const name of ["Lead", "Builder 1", "Builder 2", "Reviewer"]) {
    check(`the org chart shows ${name}`, await page.getByText(name, { exact: true }).first().isVisible().catch(() => false));
  }
  const columns = ["To do", "Working", "Review", "Done"];
  const heads = await page.locator('[role="tabpanel"][data-state="active"] h3').allTextContents();
  check("the board has four columns in order", columns.every((c, i) => heads[i]?.startsWith(c)) && heads.length === 4, heads.join(" | "));
  check("the activity feed lists what happened", await page.getByRole("list", { name: "Activity" }).getByText("Started on the form.").isVisible().catch(() => false));
  check("the needs-you line is shown", await page.getByRole("list", { name: "Needs you" }).getByText("Which field comes first?").isVisible().catch(() => false));
  check("the picked agent is the one that needs you", await page.getByRole("region", { name: /Builder 2, its chat/ }).isVisible().catch(() => false));
  check("a running team has no primary button", (await page.locator('[role="tabpanel"][data-state="active"] .btn-primary:visible').count()) === 0);
  await design(page, "desktop running", false);
  check("no page errors on the desktop Team view", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

async function desktopAwaiting(browser, fx) {
  const { ctx, page, errors } = await openTeam(browser, fx, { team: teamFor("awaiting_approval") });
  const land = page.getByRole("button", { name: "Approve and bring into project", exact: true });
  check("a team waiting on the person has the approve button", await land.isVisible().catch(() => false));
  check("the approve button is the one primary", (await page.locator('[role="tabpanel"][data-state="active"] .btn-primary:visible').count()) === 1);
  await design(page, "desktop awaiting", false);
  check("no page errors when a team waits to be approved", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

async function phone(browser, fx) {
  const { ctx, page, errors } = await openTeam(browser, fx, { width: 390, height: 844, touch: true, team: teamFor("running", { needsYou: true }) });
  check("the phone shows the Board, Team and Activity switch", await page.getByRole("tablist", { name: "Team views" }).isVisible().catch(() => false));
  check("the Team segment shows the agents first", await page.getByText("Lead", { exact: true }).first().isVisible().catch(() => false));
  check("the Board is not shown in the Team segment", !(await page.getByRole("heading", { name: "Board", exact: true }).isVisible().catch(() => false)));

  const segment = (name) => page.getByRole("tablist", { name: "Team views" }).getByRole("tab", { name, exact: true });
  await segment("Activity").click();
  check("Activity shows the feed", await page.getByRole("list", { name: "Activity" }).isVisible().catch(() => false));
  await segment("Board").click();
  check("Board shows the board", await page.getByRole("heading", { name: "Board", exact: true }).isVisible().catch(() => false));
  check("Board shows its columns as one stack", (await page.locator('[role="tabpanel"][data-state="active"] h3').count()) === 4);
  await segment("Team").click();

  await page.getByRole("button", { name: /^Builder 1/ }).first().click();
  check("tapping an agent opens its chat as a sheet", await page.getByRole("region", { name: /Builder 1, its chat/ }).isVisible().catch(() => false));
  check("the sheet has a way back", await page.getByRole("button", { name: "Back to team", exact: true }).isVisible().catch(() => false));
  await design(page, "phone", true);
  check("no page errors on the phone Team view", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

async function startDialog(browser, fx) {
  const { ctx, page, errors } = await openTeam(browser, fx, { team: null });
  // No team yet: the goal heading is absent, so wait for the empty state instead.
  await page.getByText("Work as a team", { exact: true }).first().waitFor({ timeout: 15000 }).catch(() => {});
  const start = page.getByRole("button", { name: "Start a team", exact: true });
  check("with no team, the empty state offers one primary button", (await start.isVisible().catch(() => false)) && (await page.locator('[role="tabpanel"][data-state="active"] .btn-primary:visible').count()) === 1);
  await start.click();
  const dialog = page.getByRole("dialog", { name: "Work as a team" });
  check("starting a team opens the Start dialog", await dialog.isVisible().catch(() => false));
  const submit = dialog.getByRole("button", { name: "Start team", exact: true });
  check("Start team is off until there is a goal", await submit.isDisabled().catch(() => false));
  await dialog.getByLabel("What should the team build?").fill("Make a page for the shop");
  check("Start team is on once there is a goal", await submit.isEnabled().catch(() => false));
  check("the start dialog offers how many agents at once", await dialog.getByLabel("Agents at once").isVisible().catch(() => false));
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  check("Cancel closes the Start dialog", (await page.getByRole("dialog", { name: "Work as a team" }).count()) === 0);
  check("no page errors in the start dialog", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

async function roleDialog(browser, fx) {
  const { ctx, page, errors } = await openTeam(browser, fx, { team: teamFor("running") });
  await page.getByRole("button", { name: "Actions for Builder 2", exact: true }).click();
  await page.getByRole("menuitem", { name: "Change AI, model or mode", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change Builder 2" });
  check("the role dialog opens from the agent's menu", await dialog.isVisible().catch(() => false));
  check("the role dialog has a Mode row", await dialog.getByRole("button", { name: /^Mode:/ }).isVisible().catch(() => false));
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  check("Done closes the role dialog", (await page.getByRole("dialog", { name: "Change Builder 2" }).count()) === 0);
  check("no page errors in the role dialog", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

const fx = await startFixture({ port: PORT, key: KEY });
let browser;
try {
  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });
  await desktopRunning(browser, fx);
  await desktopAwaiting(browser, fx);
  await phone(browser, fx);
  await startDialog(browser, fx);
  await roleDialog(browser, fx);
} finally {
  await browser?.close();
  fx.stop();
}

console.log(failures ? `\n${failures} failed` : "\nall team UI checks passed");
process.exit(failures ? 1 : 0);
