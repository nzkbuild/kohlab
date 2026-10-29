#!/usr/bin/env node
// The project brain in the browser: the Brain tab (graph, list, search, note panel, edit, delete, keyboard), the empty
// state, the viewer's read-only view, the Run panel's "Recalled" line and the light and phone views. Seeds go through the
// real PUT /brain/note on a throwaway server (its own PORT, WORKS_DIR and PTY_SOCKET). The Run panel's reply and
// instructions are page.route mocks, so no AI runs.
//
// Needs the server's brain routes (Brief A). Against a server without them the seeding and the Brain view report FAIL.
// Skips with a printed reason when playwright-core or Chromium is missing.
//
//   cd web && bun run build && node scripts/check-brain-ui.mjs
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
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const KEY = "brain-ui-check-key";
const PORT = 7874;

// Notes as a person would write them. The graph and the panel are checked against what the server then says.
const SEEDS = [
  { name: "Goal", type: "Goal", body: "Ship the Blue Door shop page. Built on [[Use SQLite]]." },
  { name: "Use SQLite", type: "Decision", body: "Stored in one file. See [[Goal]]." },
  { name: "Keep the cart in the browser", type: "Decision", body: "Carts stay on the device. See [[Use SQLite]]." },
  { name: "Show opening hours", type: "Decision", body: "Hours sit on the home page. Part of [[Goal]]." },
  { name: "Shop name", type: "Fact", body: "Blue Door, Melbourne." },
  { name: "Write the about page", type: "Task", status: "open", body: "The owner reviews the story." },
  { name: "db.ts", type: "File", body: "path: src/db.ts" },
  { name: "Deploy notes", type: "Fact", body: "The steps are in [[Missing Page]]." },
];

/** Runs in the page: one primary per view, controls at least 24px (44 on touch), no spinner, no looping animation. */
function measure(touch) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const label = (el) => `${el.tagName.toLowerCase()}[${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}]`;
  // Only the Brain view itself: the app's top bar is not part of this check.
  const root = document.querySelector('[role="tabpanel"][data-state="active"]') ?? document;
  const primaries = [...root.querySelectorAll(".btn-primary")].filter(visible).map(label);
  const min = touch ? 44 : 24;
  // Links in prose are out of scope (DESIGN.md); the rest of the buttons are held to the size.
  const small = [...root.querySelectorAll("button:not([data-prose-link])")]
    .filter(visible)
    .filter((el) => !el.matches("[disabled], [aria-disabled=true]"))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => Math.min(r.width, r.height) < min - 0.5)
    .map(({ el, r }) => `${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  const spinners = root.querySelectorAll('[aria-busy="true"], .animate-spin, [class*="spinner"]').length;
  const looping = [...root.querySelectorAll("svg *, aside *")].filter((el) => getComputedStyle(el).animationIterationCount === "infinite").length;
  return { primaries, small, spinners, looping };
}

async function design(page, at, touch) {
  const m = await page.evaluate(measure, touch);
  check(`${at}: at most one primary button`, m.primaries.length <= 1, m.primaries.join(", "));
  check(`${at}: controls >= ${touch ? 44 : 24}px`, m.small.length === 0, m.small.slice(0, 4).join(", "));
  check(`${at}: no spinner and no aria-busy`, m.spinners === 0);
  check(`${at}: no looping animation`, m.looping === 0, `${m.looping} elements`);
}

const collectErrors = (page, bucket) => {
  page.on("pageerror", (e) => bucket.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") bucket.push(`console: ${m.text()}`);
  });
};

/** GET or PUT a JSON route on the fixture; null (and a FAIL line) when the server does not answer with JSON. */
async function api(base, path, { method = "GET", headers, body } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) return { ok: false, status: res.status, json: null };
  return { ok: true, status: res.status, json: await res.json().catch(() => null) };
}

const graphOf = "[data-brain-node]";

async function brainView(found, fx, auth, graph) {
  const errors = [];
  const ctx = await openContext(found.browser, { width: 1280, height: 900, key: KEY });
  const page = await ctx.newPage();
  collectErrors(page, errors);
  await page.goto(`${fx.base}/w/${fx.ready}/brain`);
  const svg = page.getByRole("img", { name: "Project brain graph" });
  await svg.waitFor({ timeout: 15000 }).catch(() => {});
  check("the Brain tab is in the project's switch", await page.getByRole("tab", { name: "Brain", exact: true }).isVisible().catch(() => false));
  check("the graph is drawn", await svg.isVisible().catch(() => false));
  const nodes = await page.locator(graphOf).count();
  const edges = await page.locator("[data-brain-edge]").count();
  check("one node per server note", nodes === graph.nodes.length, `${nodes} vs ${graph.nodes.length}`);
  check("one line per server link", edges === graph.edges.length, `${edges} vs ${graph.edges.length}`);
  check("the list lists every note", (await page.getByRole("list", { name: "All notes" }).getByRole("button").count()) === graph.nodes.length);

  // The note panel: title, body, backlinks, and a [[link]] that selects its note.
  const aside = page.locator('aside[aria-label="Note"]');
  await page.locator(`${graphOf}[aria-label="Use SQLite, Decision"]`).click();
  await page.getByRole("heading", { name: "Use SQLite", level: 2 }).waitFor({ timeout: 5000 }).catch(() => {});
  const panelText = await aside.innerText().catch(() => "");
  check("a node opens its note: title and body", panelText.includes("Use SQLite") && panelText.includes("Stored in one file"), panelText.slice(0, 80).replace(/\n/g, " | "));
  check("the backlinks list the notes that link here", panelText.includes("Linked from") && panelText.includes("Keep the cart in the browser") && panelText.includes("Goal"));
  await aside.getByRole("button", { name: "Goal", exact: true }).first().click();
  await page.getByRole("heading", { name: "Goal", level: 2 }).waitFor({ timeout: 5000 }).catch(() => {});
  check("clicking a [[link]] selects its note", await page.getByRole("heading", { name: "Goal", level: 2 }).isVisible().catch(() => false));

  // An unresolved link is plain muted text, not a button.
  await page.locator(`${graphOf}[aria-label="Deploy notes, Fact"]`).click();
  await page.getByRole("heading", { name: "Deploy notes", level: 2 }).waitFor({ timeout: 5000 }).catch(() => {});
  check("an unresolved link is not a button", (await aside.getByRole("button", { name: "Missing Page" }).count()) === 0);
  check("an unresolved link still reads as text", (await aside.getByText("Missing Page", { exact: true }).count()) === 1);

  // Edit and save: one primary while editing, then the change survives a reload.
  await page.locator(`${graphOf}[aria-label="Shop name, Fact"]`).click();
  await aside.getByRole("button", { name: "Edit", exact: true }).click();
  const textarea = aside.getByRole("textbox", { name: "Note text" });
  check("the note text is capped at 8000 characters", (await textarea.getAttribute("maxlength")) === "8000");
  await textarea.fill("Blue Door, Melbourne. Updated.");
  check("while editing there is exactly one primary button", (await page.locator(".btn-primary:visible").count()) === 1);
  await aside.getByRole("button", { name: "Save", exact: true }).click();
  await aside.getByText("Updated.", { exact: false }).waitFor({ timeout: 5000 }).catch(() => {});
  await page.reload();
  await page.locator(`${graphOf}[aria-label="Shop name, Fact"]`).click();
  await aside.getByText("Updated.", { exact: false }).waitFor({ timeout: 5000 }).catch(() => {});
  check("an edit survives a reload", (await aside.innerText().catch(() => "")).includes("Updated."));

  // Search: the graph narrows to the server's hits.
  const search = page.getByRole("searchbox", { name: "Search notes" });
  await search.fill("sqlite");
  const hits = await api(fx.base, "/api/workspaces/" + fx.ready + "/brain/search?q=sqlite", { headers: auth });
  await page.waitForTimeout(600);
  const hitCount = hits.json?.hits?.length ?? -1;
  check("search narrows the graph to the hits", (await page.locator(graphOf).count()) === hitCount, `${await page.locator(graphOf).count()} vs ${hitCount} hits`);
  await search.fill("");
  await page.waitForTimeout(300);

  // Keyboard: Tab reaches a node, Enter selects it.
  await search.click();
  let reached = false;
  for (let i = 0; i < 12 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => document.activeElement?.hasAttribute("data-brain-node") ?? false);
  }
  check("Tab reaches a graph node", reached);
  if (reached) {
    const label = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
    await page.keyboard.press("Enter");
    const title = label.split(",")[0];
    await page.getByRole("heading", { name: title, level: 2 }).waitFor({ timeout: 5000 }).catch(() => {});
    check("Enter selects the focused node", (await aside.innerText().catch(() => "")).includes(title), label);
  }

  await design(page, "brain @1280 dark", false);
  check("no console errors on the desktop Brain view", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();

  // The empty state: a fresh project, with only its seed goal (or nothing) in the brain.
  const fctx = await openContext(found.browser, { width: 1280, height: 900, key: KEY });
  const fpage = await fctx.newPage();
  await fpage.goto(`${fx.base}/w/${fx.fresh}/brain`);
  const empty = fpage.getByText("Kohlab remembers goals, decisions and handoffs here as you work.");
  await empty.waitFor({ timeout: 15000 }).catch(() => {});
  check("a fresh project says what the brain is for", await empty.isVisible().catch(() => false));
  await fctx.close();
}

async function viewerView(found, fx, auth) {
  const made = await api(fx.base, "/api/users", { method: "POST", headers: auth, body: { id: "brain-viewer", name: "brain-viewer", role: "viewer" } });
  const viewerKey = made.json?.key ?? null;
  check("a viewer can be made for the check", !!viewerKey, `status ${made.status}`);
  if (!viewerKey) return;
  try {
    const vctx = await openContext(found.browser, { width: 1280, height: 900, key: viewerKey });
    const vpage = await vctx.newPage();
    await vpage.goto(`${fx.base}/w/${fx.ready}/brain`);
    await vpage.locator(graphOf).first().waitFor({ timeout: 15000 }).catch(() => {});
    await vpage.locator(`${graphOf}[aria-label="Use SQLite, Decision"]`).click().catch(() => {});
    await vpage.getByRole("heading", { name: "Use SQLite", level: 2 }).waitFor({ timeout: 5000 }).catch(() => {});
    check("a viewer sees no New note", (await vpage.getByRole("button", { name: "New note", exact: true }).count()) === 0);
    check("a viewer sees no Edit or Delete", (await vpage.getByRole("button", { name: /^(Edit|Delete)$/ }).count()) === 0);
    await vctx.close();
  } finally {
    await api(fx.base, "/api/users/brain-viewer", { method: "DELETE", headers: auth });
  }
}

async function runPanelView(found, fx) {
  const errors = [];
  const ctx = await openContext(found.browser, { width: 1440, height: 900, key: KEY });
  const page = await ctx.newPage();
  collectErrors(page, errors);
  await page.route(/\/api\/workspaces\/[^/]+\/chat\?after=/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.events = [...body.events, { n: 9100, at: Date.now(), kind: "done", worked: 72_000, model: "claude-sonnet-5-5", tokens: { in: 12000, out: 345 }, recalled: ["Goal", "Use SQLite"] }];
    await route.fulfill({ response: res, json: body });
  });
  await page.route(/\/api\/workspaces\/[^/]+\/chat\/run$/, (route) =>
    route.fulfill({
      json: {
        agent: "claude",
        agentName: "Claude",
        terminalProject: false,
        instructions: { system: null, notes: "", note: null, brain: { notes: 5, tokens: 640 } },
        tools: null,
        ready: true,
      },
    }),
  );
  await page.goto(`${fx.base}/w/${fx.ready}/chat`);
  const dock = page.locator('aside[aria-label="Run"]');
  await dock.waitFor({ timeout: 15000 }).catch(() => {});
  const recalledLine = dock.locator("p", { hasText: "Recalled 2 notes" }).first();
  await recalledLine.waitFor({ timeout: 5000 }).catch(() => {});
  const lineText = ((await recalledLine.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  check("a reply says what it recalled", lineText === "Recalled 2 notes: Goal, Use SQLite", lineText);
  check("the Run panel says what the AI was given", (await dock.innerText().catch(() => "")).includes("Project brain: 5 notes in memory."));
  await dock.getByRole("button", { name: "Use SQLite", exact: true }).click();
  await page.waitForURL(/\/w\/[^/]+\/brain/, { timeout: 5000 }).catch(() => {});
  check("a recalled title opens the Brain tab", page.url().includes("/brain"), page.url());
  await page.getByRole("heading", { name: "Use SQLite", level: 2 }).waitFor({ timeout: 5000 }).catch(() => {});
  check("the Brain tab shows that note", await page.getByRole("heading", { name: "Use SQLite", level: 2 }).isVisible().catch(() => false));
  check("no console errors on the Run panel", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

async function lightViews(found, fx) {
  for (const [width, height, touch, scheme, at] of [
    [390, 800, true, "dark", "brain @390 dark"],
    [390, 800, true, "light", "brain @390 light"],
    [1280, 900, false, "light", "brain @1280 light"],
  ]) {
    const ctx = await openContext(found.browser, { width, height, key: KEY, touch, scheme });
    const page = await ctx.newPage();
    await page.goto(`${fx.base}/w/${fx.ready}/brain`);
    await page.getByRole("img", { name: "Project brain graph" }).waitFor({ timeout: 15000 }).catch(() => {});
    await page.locator(`${graphOf}[aria-label="Use SQLite, Decision"]`).click().catch(() => {});
    await design(page, at, touch);
    await ctx.close();
  }
}

const fx = await startFixture({ port: PORT, key: KEY });
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
let browser;
try {
  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });
  const handle = { ...found, browser };

  // Seed through the real PUT route. A route that is missing answers 404 and is reported, not skipped.
  const seeded = [];
  for (const note of SEEDS) {
    const r = await api(fx.base, `/api/workspaces/${fx.ready}/brain/note`, { method: "PUT", headers: auth, body: note });
    seeded.push(r.status);
  }
  check("seeding through PUT /brain/note works", seeded.every((s) => s === 200), `statuses ${seeded.join(", ")}`);

  const graph = await api(fx.base, `/api/workspaces/${fx.ready}/brain`, { headers: auth });
  check("the server answers GET /brain with a graph", graph.ok && Array.isArray(graph.json?.nodes), `status ${graph.status}`);
  if (graph.ok && Array.isArray(graph.json?.nodes)) {
    await brainView(handle, fx, auth, graph.json);
    await viewerView(handle, fx, auth);
    await lightViews(handle, fx);
  }
  await runPanelView(handle, fx);
} finally {
  await browser?.close();
  fx.stop();
}

console.log(failures ? `\n${failures} failed` : "\nall brain UI checks passed");
process.exit(failures ? 1 : 0);
