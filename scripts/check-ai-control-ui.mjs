#!/usr/bin/env node
// "Control the AI" in the browser (v2.6): Settings -> AI defaults, accounts and always-allowed actions; the Run panel's
// Now rows, "If the limit is reached" list and "What it can do without asking"; the mode menu with its Full access
// confirm; Always allow on an ask; "Just for the next message"; a limit note in a non-UTC time zone; the router form
// that never keeps a key; the picker's group per account; the phone composer row at 360px.
//
// No real AI runs. page.route answers /api/providers, /api/ai/*, chat/run and chat/control, and adds notes, an ask and
// a model list to the chat snapshot. The throwaway server (own PORT, WORKS_DIR, PTY_SOCKET) only serves the built web/dist.
// Skips with a printed reason when playwright-core or Chromium is missing.
//
//   cd web && bun run build && node scripts/check-ai-control-ui.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`);
};

/* --------------------------------------------------------------- fixtures -- */
const TZ = "Asia/Tokyo";
const CANARY = "sk-canary-7f3a91c2d0e84b";
const SOON = Date.now() + 3 * 3_600_000;
/** A time of day as the page must print it in the time zone above. */
const clock = (ms) => new Date(ms).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).toLowerCase();
const ACCOUNT_NOTE = "Claude runs commands on this server as the server's own account, without asking.";

const model = (value, label, over = {}) => ({ value, label, ...over });
const account = (over) => ({ id: "default", label: "you@example.com", email: "you@example.com", plan: "pro", auth: "oauth", state: "connected", isolation: {}, usage: null, models: [], modelsAt: 1, kind: "default", ...over });
const baseCard = { kind: "cli", installed: true, version: "9.9.9", checkedAt: Date.now() - 60_000, stale: false, actions: [{ kind: "refresh", label: "Refresh" }] };
const cardsFor = (state) => [
  {
    ...baseCard,
    id: "claude",
    name: "Claude",
    state: "connected",
    accounts: [
      account({ models: [model("default", "Default"), model("claude-sonnet-5-5", "Sonnet 5.5"), model("claude-haiku-4-5", "Haiku 4.5")] }),
      account({ id: "work", label: "Work", email: null, plan: null, kind: "login", state: "limited", limitedUntil: SOON, models: [model("claude-sonnet-5-5", "Sonnet 5.5")] }),
      account({ id: "router", label: "Router", email: null, plan: null, auth: "router", kind: "router", baseUrlHost: "127.0.0.1:20128", hasKey: true, models: [model("or/glm-4", "GLM 4"), model("or/mine", "My model", { custom: true })] }),
      ...state.extraAccounts,
    ],
  },
  { ...baseCard, id: "hermes", name: "Hermes", state: "connected", accounts: [account({ label: "openrouter", email: null, plan: null, models: [model("hermes-1", "Hermes one")] })] },
];
const memberCards = (state) => cardsFor(state).map((c) => ({ id: c.id, name: c.name, kind: c.kind, installed: true, version: null, state: c.state, checkedAt: c.checkedAt, stale: false, actions: [], accounts: c.accounts.map((a) => ({ id: a.id, label: c.name, email: null, plan: null, auth: a.auth, state: a.state, isolation: {}, usage: null, models: a.models, modelsAt: 1 })) }));

const RUN_BASE = {
  agent: "claude",
  agentName: "Claude",
  terminalProject: false,
  instructions: { system: "You help a person build a small website.", notes: "", note: null },
  tools: { builtin: ["Read", "Edit"], mcp: [] },
  ready: true,
};
const RULES = [
  { rule: "Bash(npm test:*)", label: "Run npm test", source: "kohlab", removable: true },
  { rule: "Edit", label: "Change files", source: "claude-settings", removable: false },
  { rule: "WebFetch(domain:example.com)", label: "Open example.com", source: "session", removable: false },
];
const SNAPSHOT_MODELS = [
  { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Everyday work", supportedEffortLevels: ["low", "medium", "high"] },
  { value: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "Fast", supportedEffortLevels: [] },
];

/** Everything the mocked server remembers for one page. */
function freshState(over = {}) {
  return {
    extraAccounts: [],
    defaults: { model: "claude-sonnet-5-5" },
    rules: structuredClone(RULES),
    projectRules: [{ id: "p1", name: "Shop", rules: structuredClone(RULES) }],
    fallback: { auto: true, steps: [{ account: "work" }, { account: null, model: "claude-haiku-4-5" }], custom: false },
    limit: { from: "Claude Pro", to: "Work", until: SOON, at: Date.now(), fromAccount: null },
    sources: { agent: "default", account: "default", model: "project", effort: "builtin", mode: "default", autoFresh: "default" },
    mode: "default",
    activeAccount: { id: "work", label: "Work", kind: "login" },
    posts: [],
    controls: [],
    puts: [],
    sends: [],
    answers: [],
    models: [],
    fullStatus: 200,
    routerCheck: "key_rejected",
    ...over,
  };
}

const runInfo = (s) => ({
  ...RUN_BASE,
  ai: {
    agent: { value: "claude", source: s.sources.agent },
    account: { value: s.activeAccount ? s.activeAccount.id : null, source: s.sources.account },
    model: { value: "claude-sonnet-5-5", source: s.sources.model },
    effort: { value: null, source: s.sources.effort },
    mode: { value: s.mode, source: s.sources.mode },
    autoFresh: { value: true, source: s.sources.autoFresh },
  },
  account: s.activeAccount,
  fallback: s.fallback,
  limit: s.limit,
  rules: s.rules,
  accessNote: ACCOUNT_NOTE,
});

/** Answers the routes on a page. `member` makes the app think this person is a member. */
async function mock(page, s, { member = false, snapshot = {} } = {}) {
  const json = (route, body, status = 200) => route.fulfill({ status, json: body });
  await page.route(/\/api\/providers$/, (route) => json(route, { providers: member ? memberCards(s) : cardsFor(s), at: Date.now() }));
  await page.route(/\/api\/providers\/refresh$/, (route) => json(route, { providers: member ? memberCards(s) : cardsFor(s), at: Date.now() }));
  if (member) await page.route(/\/api\/account$/, (route) => json(route, { id: "sam", role: "member", kind: "user" }));
  await page.route(/\/api\/ai\/defaults$/, (route) => {
    if (route.request().method() === "PUT") {
      const patch = route.request().postDataJSON();
      s.puts.push(patch);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete s.defaults[k];
        else s.defaults[k] = v;
      }
    }
    return json(route, { defaults: s.defaults });
  });
  await page.route(/\/api\/ai\/rules$/, (route) => json(route, { projects: s.projectRules }));
  await page.route(/\/api\/ai\/accounts$/, (route) => {
    const body = route.request().postDataJSON();
    s.posts.push({ url: "/api/ai/accounts", body });
    const id = "r2";
    s.extraAccounts.push(account({ id, label: body.label, email: null, plan: null, auth: "router", kind: "router", baseUrlHost: "127.0.0.1:20128", hasKey: true, models: [model("a", "A"), model("b", "B"), model("c", "C")] }));
    return json(route, { account: { id, provider: "claude", kind: body.kind, label: body.label, createdAt: Date.now() }, check: body.kind === "router" ? s.routerCheck : undefined });
  });
  await page.route(/\/api\/ai\/accounts\/[^/]+\/(models|test|key)$/, (route) => {
    s.posts.push({ url: new URL(route.request().url()).pathname, method: route.request().method(), body: route.request().postData() ? route.request().postDataJSON() : null });
    return json(route, route.request().url().endsWith("/test") ? { check: "ok" } : { ok: true });
  });
  await page.route(/\/api\/ai\/accounts\/[^/]+$/, (route) => {
    s.posts.push({ url: new URL(route.request().url()).pathname, method: route.request().method(), body: route.request().postData() ? route.request().postDataJSON() : null });
    return json(route, { ok: true });
  });
  await page.route(/\/api\/workspaces\/[^/]+\/chat\/run$/, (route) => json(route, runInfo(s)));
  await page.route(/\/api\/workspaces\/[^/]+\/chat\/control$/, (route) => {
    const { action, value } = route.request().postDataJSON();
    s.controls.push({ action, value });
    if (action === "mode" && value === "full" && s.fullStatus !== 200) return json(route, { error: "Full access is only for the owner." }, s.fullStatus);
    if (action === "mode") s.mode = value;
    if (action === "reset" && value === "model") s.sources.model = "default";
    if (action === "reset" && value === "account") {
      s.limit = null;
      s.activeAccount = null;
    }
    if (action === "fallback") s.fallback = value === null ? { auto: true, steps: [{ account: "work" }, { account: null, model: "claude-haiku-4-5" }], custom: false } : { auto: value.auto, steps: value.steps, custom: true };
    if (action === "rule_remove") s.rules = s.rules.filter((r) => r.rule !== value);
    return json(route, { ok: true });
  });
  await page.route(/\/api\/workspaces\/[^/]+\/chat\/answer$/, (route) => {
    s.answers.push(route.request().postDataJSON());
    return json(route, { ok: true });
  });
  await page.route(/\/api\/workspaces\/[^/]+\/chat$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    s.sends.push(route.request().postDataJSON());
    return json(route, { ok: true });
  });
  await page.route(/\/api\/workspaces\/[^/]+\/chat\?after=/, async (route) => {
    const res = await route.fetch().catch(() => null);
    const body = await res?.json().catch(() => null);
    if (!res || !body) return; // the page closed while this was in flight
    body.models = SNAPSHOT_MODELS;
    body.model = "claude-sonnet-5-5";
    body.mode = s.mode;
    body.events = [...body.events, ...(snapshot.events ?? [])];
    Object.assign(body, snapshot.fields ?? {});
    await route.fulfill({ response: res, json: body }).catch(() => undefined);
  });
}

/** Runs in the page: the rules of check-design (one primary, big enough controls, contrast) and the signs of a spinner. */
function measure(touch) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && !el.closest("[hidden], [inert], .xterm");
  };
  const label = (el) => `${el.tagName.toLowerCase()}[${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 28)}]`;
  const primaries = [...document.querySelectorAll(".btn-primary")].filter(visible).map(label);
  const min = touch ? 44 : 24;
  const small = [...document.querySelectorAll("button, [role=tab], [role=menuitem]")]
    .filter(visible)
    .filter((el) => !el.matches("[disabled], [aria-disabled=true]"))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => Math.min(r.width, r.height) < min - 0.5)
    .map(({ el, r }) => `${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  const canvas = document.createElement("canvas").getContext("2d");
  const rgba = (c) => {
    canvas.clearRect(0, 0, 1, 1);
    canvas.fillStyle = "#000";
    canvas.fillStyle = c;
    canvas.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const bgOf = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const c = rgba(getComputedStyle(e).backgroundColor);
      if (c[3] > 0.95) return c;
    }
    return [255, 255, 255, 1];
  };
  const low = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.trim();
    const el = n.parentElement;
    if (!text || !el || !visible(el) || el.closest("script, style, [disabled], [aria-disabled=true], .dark-pane, .sr-only")) continue;
    let dimmed = false;
    for (let e = el; e; e = e.parentElement) if (+getComputedStyle(e).opacity < 1) dimmed = true;
    if (dimmed) continue;
    const st = getComputedStyle(el);
    const bg = bgOf(el);
    const fg = rgba(st.color);
    const mix = [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    const [hi, lo] = [lum(mix), lum(bg)].sort((a, b) => b - a);
    const large = parseFloat(st.fontSize) >= 24 || (parseFloat(st.fontSize) >= 18.66 && +st.fontWeight >= 700);
    const ratio = (hi + 0.05) / (lo + 0.05);
    if (ratio < (large ? 3 : 4.5)) low.push(`"${text.slice(0, 24)}" ${ratio.toFixed(2)}:1`);
  }
  const spinners = document.querySelectorAll('[aria-busy="true"], .animate-spin, [class*="spinner"]').length;
  return { primaries, small, low: [...new Set(low)], spinners, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
}

async function design(page, at, touch) {
  const m = await page.evaluate(measure, touch);
  check(`${at}: at most one primary button`, m.primaries.length <= 1, m.primaries.join(", "));
  check(`${at}: controls >= ${touch ? 44 : 24}px`, m.small.length === 0, m.small.slice(0, 4).join(", "));
  check(`${at}: text contrast >= 4.5:1`, m.low.length === 0, m.low.slice(0, 4).join(", "));
  check(`${at}: no spinner and no aria-busy`, m.spinners === 0);
  check(`${at}: no sideways scroll`, m.overflow <= 0, String(m.overflow));
}

const BAD_WORDS = /\bagents?\b|\btokens?\b|config dir|CLAUDE_CONFIG_DIR|\broot\b|\bMCP\b/i;
const announced = (page) => page.locator('[role="status"][aria-live="polite"]').first().textContent();
const waitText = async (page, text) => page.getByText(text).first().waitFor({ timeout: 6000 }).then(() => true, () => false);

const KEY = "ai-control-check-key";
const fx = await startFixture({ port: 7875, key: KEY });
let browser;
try {
  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });

  /* ----------------------------------------------------- Settings -> AI, owner -- */
  {
    const s = freshState();
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY, timezoneId: TZ });
    const page = await ctx.newPage();
    await mock(page, s);
    await page.goto(`${fx.base}/settings/agents`);
    const defaults = page.locator("section.panel", { has: page.getByRole("heading", { name: "Defaults for new projects" }) });
    await defaults.waitFor({ timeout: 15000 }).catch(() => {});
    check("defaults: the panel comes first", (await page.locator("section.panel h3").first().innerText()) === "Defaults for new projects");
    const text = await defaults.innerText();
    check("defaults: the helper line", /Projects start with these\. A project can set its own\./.test(text));
    check("defaults: AI, Account, Model, Effort, Mode and Continue fresh rows", ["AI", "Account", "Model", "Effort", "Mode", "Continue fresh automatically"].every((w) => text.includes(w)), text.replace(/\n/g, " | "));
    const clears = await defaults.getByRole("button", { name: /^Use the built-in/ }).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    check("defaults: 'Use built-in' only on the one that is set", JSON.stringify(clears) === JSON.stringify(["Use the built-in model"]), clears.join(", "));

    // effort: saves on change, one "Saved"
    await defaults.getByRole("button", { name: /^Effort/ }).click();
    await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
    await page.waitForFunction(() => /Saved/.test(document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
    check("defaults: a change is saved at once, with one 'Saved'", JSON.stringify(s.puts.at(-1)) === JSON.stringify({ effort: "high" }) && /Saved/.test(await announced(page)), JSON.stringify(s.puts));
    // built-in
    await defaults.getByRole("button", { name: "Use the built-in model" }).click();
    await page.waitForTimeout(300);
    check("defaults: 'Use built-in' sends null", JSON.stringify(s.puts.at(-1)) === JSON.stringify({ model: null }), JSON.stringify(s.puts.at(-1)));
    // full access asks first
    const before = s.puts.length;
    await defaults.getByRole("button", { name: /^Mode:/ }).click();
    await page.getByRole("menuitemradio", { name: /Full access/ }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ timeout: 5000 }).catch(() => {});
    check("defaults: Full access asks first, nothing saved yet", (await dialog.isVisible()) && s.puts.length === before && /Allow full access/.test(await dialog.innerText()));
    const allowClass = await dialog.getByRole("button", { name: "Allow full access" }).getAttribute("class");
    check("Full access confirm: the allowing button is not the primary one", !/btn-primary/.test(allowClass ?? ""), allowClass ?? "");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(200);
    check("Full access confirm: Cancel changes nothing", s.puts.length === before);
    await defaults.getByRole("button", { name: /^Mode:/ }).click();
    await page.getByRole("menuitemradio", { name: /Full access/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Allow full access" }).click();
    await page.waitForTimeout(300);
    check("Full access confirm: Allow saves it", JSON.stringify(s.puts.at(-1)) === JSON.stringify({ mode: "full" }));

    // accounts
    const claude = page.locator("section.panel", { has: page.getByRole("heading", { name: "Claude", level: 3 }) }).first();
    const ctext = await claude.innerText();
    check("accounts: kinds in words", /Signed in with Claude/.test(ctext) && /Router at 127\.0\.0\.1:20128/.test(ctext), ctext.replace(/\n/g, " | ").slice(0, 300));
    check("accounts: a limit says until when, in the viewer's time zone", ctext.includes(`Limit reached until ${clock(SOON)}`) || new RegExp(`Limit reached until .*${clock(SOON).replace(".", "\\.")}`).test(ctext), `${clock(SOON)} in ${ctext.match(/Limit reached until[^\n]*/)?.[0]}`);
    check("accounts: Test, Replace key and Remove for another account", (await claude.getByRole("button", { name: "Test" }).count()) === 1 && (await claude.getByRole("button", { name: "Replace key" }).count()) === 1 && (await claude.getByRole("button", { name: "Remove", exact: true }).count()) === 2);
    check("accounts: 'Add another Claude account'", (await claude.getByRole("button", { name: "Add another Claude account" }).count()) === 1);
    await claude.getByRole("button", { name: "Test" }).click();
    check("accounts: Test says how it went", await waitText(page, "Connected."));
    await claude.getByRole("button", { name: "Rename", exact: true }).first().click();
    const renameDlg = page.getByRole("dialog");
    await renameDlg.waitFor({ timeout: 5000 }).catch(() => {});
    await renameDlg.getByLabel("Name").fill("   ");
    await renameDlg.getByRole("button", { name: "Rename" }).click();
    check("accounts: Rename refuses an empty name in a plain sentence (the box stops at 60 characters)", (await renameDlg.innerText()).includes("Give the account a name of up to 60 characters.") && !s.posts.some((p) => p.method === "PATCH" && p.url === "/api/ai/accounts/work"));
    await renameDlg.getByLabel("Name").fill("Side job");
    await renameDlg.getByRole("button", { name: "Rename" }).click();
    await page.waitForTimeout(300);
    check("accounts: Rename sends the new name", s.posts.some((p) => p.method === "PATCH" && p.url === "/api/ai/accounts/work" && p.body?.label === "Side job"), JSON.stringify(s.posts.at(-1)));
    await claude.getByRole("button", { name: "Remove", exact: true }).first().click();
    const confirm = page.getByRole("alertdialog");
    await confirm.waitFor({ timeout: 5000 }).catch(() => {});
    check("accounts: Remove asks first", /Remove this account\?/.test(await confirm.innerText()) && !s.posts.some((p) => p.method === "DELETE"));
    await confirm.getByRole("button", { name: "Remove" }).click();
    await page.waitForTimeout(300);
    check("accounts: confirming removes it", s.posts.some((p) => p.method === "DELETE" && p.url === "/api/ai/accounts/work"), JSON.stringify(s.posts.at(-1)));

    // custom models
    const routerBlock = claude.locator("details").nth(2); // default, Work, Router: the router's models
    await routerBlock.locator("summary").click();
    const rtext = await routerBlock.innerText();
    check("models: a model added by hand says Custom and has Remove", /My model/.test(rtext) && /Custom/.test(rtext) && (await routerBlock.getByRole("button", { name: "Remove My model" }).count()) === 1, rtext.replace(/\n/g, " | "));
    await routerBlock.getByRole("button", { name: "Add a model" }).click();
    await routerBlock.getByLabel("Model id").fill("has space");
    await routerBlock.getByRole("button", { name: "Add model" }).click();
    check("models: a bad id gets a plain sentence", await waitText(page, "The id can't have spaces."));
    await routerBlock.getByLabel("Model id").fill("or/new-one");
    await routerBlock.getByRole("button", { name: "Add model" }).click();
    await page.waitForTimeout(300);
    check("models: add sends the id and the name", s.posts.some((p) => p.method === "POST" && /models$/.test(p.url) && p.body?.value === "or/new-one"), JSON.stringify(s.posts.at(-1)));
    await routerBlock.getByRole("button", { name: "Rename GLM 4" }).click();
    const box = routerBlock.getByLabel("New name for GLM 4");
    await box.fill("Faster GLM");
    await box.press("Enter");
    await page.waitForTimeout(300);
    check("models: rename saves on Enter", s.posts.some((p) => p.method === "PATCH" && p.body?.value === "or/glm-4" && p.body?.label === "Faster GLM"), JSON.stringify(s.posts.at(-1)));
    const patches = s.posts.length;
    await routerBlock.getByRole("button", { name: "Rename My model" }).click();
    await routerBlock.getByLabel("New name for My model").press("Escape");
    check("models: Escape cancels a rename", s.posts.length === patches && (await routerBlock.getByLabel("New name for My model").count()) === 0);

    // always-allowed actions
    const allowed = page.locator("section.panel", { has: page.getByRole("heading", { name: "Always-allowed actions" }) });
    await allowed.waitFor({ timeout: 5000 }).catch(() => {});
    const atext = await allowed.innerText();
    check("always-allowed: grouped by project with the source in words", /Shop/.test(atext) && /Run npm test/.test(atext) && /You allowed this/.test(atext) && /From this project's settings/.test(atext) && /This session/.test(atext), atext.replace(/\n/g, " | "));
    check("always-allowed: Remove only where a rule can be removed", (await allowed.getByRole("button", { name: /^Remove/ }).count()) === 1);
    await allowed.getByRole("button", { name: /^Remove/ }).click();
    await page.waitForTimeout(300);
    check("always-allowed: Remove goes to that project", s.controls.some((c) => c.action === "rule_remove" && c.value === "Bash(npm test:*)"));
    check("always-allowed: the one explanatory line about limits", /carry on with another account or a cheaper model/.test(await page.locator("body").innerText()));
    check("Settings -> AI: no developer words", !BAD_WORDS.test(await page.locator(".settings-pane").innerText()), (await page.locator(".settings-pane").innerText()).match(BAD_WORDS)?.[0]);
    await design(page, "Settings -> AI @1440", false);

    // empty rules sentence
    s.projectRules = [];
    await page.reload();
    await page.getByRole("heading", { name: "Always-allowed actions" }).waitFor({ timeout: 10000 }).catch(() => {});
    check("always-allowed: empty says so", await waitText(page, "Nothing is allowed without asking yet."));
    await ctx.close();
  }

  /* -------------------------------------------------- the router form, never echoed -- */
  for (const verdict of ["key_rejected", "ok"]) {
    const s = freshState({ routerCheck: verdict });
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    const spoken = [];
    await page.exposeFunction("__spoken", (m) => spoken.push(m));
    await page.addInitScript(() => {
      new MutationObserver(() => window.__spoken?.(document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? "")).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await mock(page, s);
    await page.goto(`${fx.base}/settings/agents`);
    await page.getByRole("button", { name: "Add another Claude account" }).waitFor({ timeout: 15000 }).catch(() => {});
    await page.getByRole("button", { name: "Add another Claude account" }).click();
    const dlg = page.getByRole("dialog");
    check(`router form (${verdict}): both ways to add are offered`, (await dlg.getByRole("button", { name: "Sign in with another Claude login" }).count()) === 1 && (await dlg.getByRole("button", { name: "Use Claude through a router or API address" }).count()) === 1);
    await dlg.getByRole("button", { name: "Use Claude through a router or API address" }).click();
    const keyField = dlg.getByLabel("Key");
    check(`router form (${verdict}): the key field hides, is not remembered, is not spell-checked`, (await keyField.getAttribute("type")) === "password" && (await keyField.getAttribute("autocomplete")) === "off" && (await keyField.getAttribute("spellcheck")) === "false");
    check(`router form (${verdict}): the address placeholder and the one-time note`, (await dlg.getByLabel("Address").getAttribute("placeholder")) === "http://127.0.0.1:20128" && (await dlg.innerText()).includes("The key is stored on the server and can't be shown again."));
    await dlg.getByLabel("Name").fill("My router");
    await dlg.getByLabel("Address").fill("http://127.0.0.1:20128");
    await keyField.fill(CANARY);
    await dlg.getByRole("button", { name: "Add", exact: true }).click();
    const want = verdict === "ok" ? "Connected. 3 models found." : "The router didn't accept that key.";
    check(`router form (${verdict}): says "${want}"`, await waitText(page, want));
    check(`router form (${verdict}): the key was sent once`, s.posts.filter((p) => p.body?.key === CANARY).length === 1);
    await page.waitForTimeout(1200);
    const where = {
      "the page text": await page.locator("body").innerText(),
      "the page markup": await page.content(),
      "every field": JSON.stringify(await page.locator("input, textarea").evaluateAll((els) => els.map((e) => e.value))),
      "local storage": await page.evaluate(() => JSON.stringify(localStorage)),
      "session storage": await page.evaluate(() => JSON.stringify(sessionStorage)),
      "the address": page.url(),
      "the announcements": spoken.join("|"),
    };
    for (const [name, value] of Object.entries(where)) check(`router form (${verdict}): the key is not in ${name}`, !value.includes(CANARY));
    check(`router form (${verdict}): the key field is empty after submit`, (await page.locator("#router-key").count()) === 0 || (await page.locator("#router-key").inputValue()) === "");
    await ctx.close();
  }

  /* ---------------------------------------------- the project page, wide (owner) -- */
  {
    const s = freshState();
    const ctx = await openContext(browser, { width: 1440, height: 1000, key: KEY, timezoneId: TZ });
    const page = await ctx.newPage();
    const events = [
      { n: 9100, at: Date.now() - 5000, kind: "user", text: "Make the page blue", with: "claude-haiku-4-5" },
      { n: 9101, at: Date.now() - 4000, kind: "note", text: "Claude Pro hit its limit — continued on Work", until: SOON },
    ];
    await mock(page, s, { snapshot: { events } });
    await page.goto(`${fx.base}/w/${fx.ready}/chat`);
    const aside = page.locator('aside[aria-label="Run"]');
    await aside.getByRole("heading", { name: "If the limit is reached", level: 3 }).waitFor({ timeout: 15000 }).catch(() => {});
    const heads = await aside.getByRole("heading", { level: 3 }).allInnerTexts();
    check("Run panel: sections in order", JSON.stringify(heads) === JSON.stringify(["Now", "If the limit is reached", "Helpers", "Replies", "What it was told", "What it can use", "What it can do without asking"]), heads.join(", "));

    // the strip and the note
    const strip = page.locator('button[aria-label^="Run details"]');
    const stripText = (await strip.innerText()).trim();
    check("strip: names the AI, the new account, the model and the mode", /^Claude · Work · .+ · Asks first/.test(stripText), stripText);
    const chat = await page.locator("body").innerText();
    check("note: a limit note with `until` reads 'until <time>' in the viewer's time zone", chat.includes(`Claude Pro hit its limit — continued on Work until ${clock(SOON)}`) || new RegExp(`continued on Work until .*${clock(SOON).replace(".", "\\.")}`).test(chat), chat.match(/continued on Work[^\n]*/)?.[0]);
    check("sent-with: a message sent on another model says so", /Sent with Haiku 4\.5/.test(chat), chat.match(/Sent with[^\n]*/)?.[0]);

    // Now rows
    const now = aside.locator("section", { has: page.getByRole("heading", { name: "Now", level: 3 }) });
    const ntext = await now.innerText();
    check("Now: AI, Account, Model, Effort and Mode rows", ["AI", "Account", "Model", "Effort", "Mode"].every((w) => new RegExp(`(^|\\n)${w}\\n`).test(ntext)), ntext.replace(/\n/g, " | ").slice(0, 400));
    check("Now: inherited values say where they come from", (ntext.match(/Inherits from Settings/g) ?? []).length >= 3 && /Set for this project/.test(ntext));
    check("Now: AI and Account say they apply until the first message", (ntext.match(/Applies until the first message\./g) ?? []).length === 2, ntext.replace(/\n/g, " | "));
    const resets = await now.getByRole("button", { name: /^Reset/ }).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    check("Now: Reset only on the setting this project set", JSON.stringify(resets) === JSON.stringify(["Reset model to the Settings choice"]), resets.join(", "));
    await now.getByRole("button", { name: /^Reset model/ }).click();
    await page.waitForFunction(() => !document.body.innerText.includes("Set for this project"), null, { timeout: 5000 }).catch(() => {});
    check("Now: Reset asks the server and reads the run info again", s.controls.some((c) => c.action === "reset" && c.value === "model") && (await now.getByRole("button", { name: /^Reset/ }).count()) === 0);

    // mode menu
    await now.getByRole("button", { name: /^Mode:/ }).click();
    const modes = await page.getByRole("menuitemradio").allInnerTexts();
    check("mode menu: Asks first, Edits allowed, Auto, Full access, Plan first", modes.map((m) => m.split("\n")[0]).join(",") === "Asks first,Edits allowed,Auto,Full access,Plan first", modes.map((m) => m.split("\n")[0]).join(","));
    check("mode menu: plain details", modes.join("|").includes("Asks before it changes a file or runs a command") && modes.join("|").includes("Never asks. It can change and delete anything the AI can reach."));
    await page.getByRole("menuitemradio", { name: /Full access/ }).click();
    const fa = page.getByRole("alertdialog");
    await fa.waitFor({ timeout: 5000 }).catch(() => {});
    check("Full access: the confirm shows what the server says", (await fa.innerText()).includes(ACCOUNT_NOTE) && !s.controls.some((c) => c.action === "mode" && c.value === "full"));
    check("Full access: no developer words", !BAD_WORDS.test(await fa.innerText()));
    await fa.getByRole("button", { name: "Cancel" }).click();
    check("Full access: Cancel sends nothing", !s.controls.some((c) => c.action === "mode"));
    s.fullStatus = 403;
    await now.getByRole("button", { name: /^Mode:/ }).click();
    await page.getByRole("menuitemradio", { name: /Full access/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Allow full access" }).click();
    check("Full access: a refusal says it is only for the owner", await waitText(page, "Full access is only for the owner."));
    s.fullStatus = 200;
    await now.getByRole("button", { name: /^Mode:/ }).click();
    await page.getByRole("menuitemradio", { name: /Full access/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Allow full access" }).click();
    await page.waitForTimeout(400);
    check("Full access: Allow sends the mode", s.controls.some((c) => c.action === "mode" && c.value === "full"));
    check("the strip follows the mode", /Full access/.test(await strip.innerText()));

    // the limit block
    const limit = aside.locator("section", { has: page.getByRole("heading", { name: "If the limit is reached", level: 3 }) });
    const ltext = await limit.innerText();
    check("limit: 'Using Work until <time>. Claude Pro will be used again after that.'", ltext.includes("Using Work until") && ltext.includes(clock(SOON)) && ltext.includes("Claude Pro will be used again after that."), ltext.replace(/\n/g, " | "));
    check("limit: the suggested order is named and numbered", /Suggested order/.test(ltext) && (await limit.locator("ol > li").count()) === 2);
    const rows = await limit.locator("ol > li").allInnerTexts();
    check("limit: rows read 'Work account' and 'Haiku 4.5 on Pro'", rows[0].includes("Work account") && rows[1].includes("Haiku 4.5 on Pro"), rows.join(" | "));
    check("limit: 'Continue on the next one automatically' is on", await limit.getByLabel("Continue on the next one automatically").isChecked());
    check("limit: no developer words", !BAD_WORDS.test(ltext), ltext.match(BAD_WORDS)?.[0]);
    // keyboard: focus the button, press Enter
    await limit.getByRole("button", { name: "Move Haiku 4.5 on Pro up" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.body.innerText.includes("Your order"), null, { timeout: 5000 }).catch(() => {});
    const moved = s.controls.find((c) => c.action === "fallback");
    check("limit: Move up by keyboard sends the new order", moved && JSON.stringify(moved.value.steps) === JSON.stringify([{ account: null, model: "claude-haiku-4-5" }, { account: "work" }]), JSON.stringify(moved));
    const rows2 = await limit.locator("ol > li").allInnerTexts();
    check("limit: the list reads in the new order and says it is yours", rows2[0].includes("Haiku 4.5 on Pro") && /Your order/.test(await limit.innerText()));
    await limit.getByRole("button", { name: "Remove Work account" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll('ol[aria-label="If the limit is reached"] > li').length === 1, null, { timeout: 5000 }).catch(() => {});
    check("limit: Remove by keyboard drops the step", (await limit.locator("ol > li").count()) === 1);
    await limit.getByRole("button", { name: "Use the suggested order" }).click();
    await page.waitForFunction(() => document.body.innerText.includes("Suggested order"), null, { timeout: 5000 }).catch(() => {});
    check("limit: 'Use the suggested order' sends null", s.controls.at(-1)?.action === "fallback" && s.controls.at(-1)?.value === null);
    await limit.getByRole("button", { name: "Add a step" }).click();
    const addable = (await page.getByRole("menuitem").allInnerTexts()).join("|");
    check("limit: 'Add a step' offers another account and a model", addable.includes("Router account") && /Haiku 4\.5 on/.test(addable), addable);
    await page.keyboard.press("Escape");
    await limit.getByRole("button", { name: "Switch back now" }).click();
    await page.waitForTimeout(400);
    check("limit: 'Switch back now' resets the account", s.controls.some((c) => c.action === "reset" && c.value === "account") && !(await limit.innerText()).includes("Using Work until"));

    // rules
    const rules = aside.locator("section", { has: page.getByRole("heading", { name: "What it can do without asking", level: 3 }) });
    const rtext = await rules.innerText();
    check("rules: label and source in words", /Run npm test/.test(rtext) && /You allowed this/.test(rtext) && /From this project's settings/.test(rtext) && /This session/.test(rtext), rtext.replace(/\n/g, " | "));
    check("rules: Remove only on the one Kohlab keeps", (await rules.getByRole("button", { name: /^Remove/ }).count()) === 1);
    await rules.getByRole("button", { name: /^Remove/ }).click();
    check("rules: Remove says so", await waitText(page, "Removed."));
    check("rules: Remove asked the server by rule", s.controls.some((c) => c.action === "rule_remove" && c.value === "Bash(npm test:*)"));
    check("Run panel: no developer words in the new parts", !BAD_WORDS.test(await now.innerText()) && !BAD_WORDS.test(await rules.innerText()));
    await design(page, "chat @1440 with the Run panel", false);

    // the picker: a group per account
    const chip = page.locator('button[aria-label^="AI and model"]:visible').first();
    await chip.click();
    const menu = page.getByRole("menu");
    await menu.waitFor({ timeout: 5000 }).catch(() => {});
    const mtext = await menu.innerText();
    check("picker: a heading per account", mtext.includes("Claude · Work") && mtext.includes("Claude · you@example.com") && mtext.includes("Claude · Router") && mtext.includes("Hermes"), mtext.replace(/\n/g, " | ").slice(0, 300));
    check("picker: a model added by hand says Custom", /My model\s*Custom/.test(mtext.replace(/\n/g, " ")), mtext.replace(/\n/g, " | "));
    check("picker: 'Just for the next message…' leads", /^Claude · Work\s*\n?Just for the next message…/.test(mtext) || mtext.indexOf("Just for the next message…") < mtext.indexOf("Sonnet 5.5"));
    // other account's model
    await menu.getByRole("menuitemradio", { name: /GLM 4/ }).click();
    await page.waitForTimeout(500);
    const sw = s.controls.find((c) => c.action === "agent");
    check("picker: another account's model switches agent and account together", sw && sw.value && sw.value.agent === "claude" && sw.value.account === "router", JSON.stringify(sw));

    // one-shot
    await chip.click();
    await page.getByRole("menuitem", { name: "Just for the next message…" }).click();
    await page.getByRole("menuitemradio", { name: /^Haiku 4\.5 Fast/ }).click();
    await page.waitForTimeout(300);
    const armed = (await strip.innerText()).trim();
    check("one-shot: the strip names it", /next message: Haiku 4\.5/.test(armed), armed);
    check("one-shot: a small button drops it", (await page.getByRole("button", { name: "Don't use Haiku 4.5 for the next message" }).count()) === 1);
    await page.getByRole("button", { name: "Don't use Haiku 4.5 for the next message" }).click();
    check("one-shot: dropped", !/next message/.test(await strip.innerText()));
    await chip.click();
    await page.getByRole("menuitem", { name: "Just for the next message…" }).click();
    await page.getByRole("menuitemradio", { name: /^Haiku 4\.5 Fast/ }).click();
    await page.locator("textarea[data-composer]").fill("Try again");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForTimeout(500);
    check("one-shot: Send carries the model and clears it", s.sends.length === 1 && s.sends[0].text === "Try again" && s.sends[0].with?.model === "claude-haiku-4-5" && !/next message/.test(await strip.innerText()), JSON.stringify(s.sends));
    await ctx.close();
  }

  /* ------------------------------------------------------ asks: Always allow -- */
  for (const withAlways of [true, false]) {
    const s = freshState();
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    const ask = { n: 9200, at: Date.now(), kind: "ask", requestId: "r1", text: "Claude wants to run a command", why: "To check the tests pass", ...(withAlways ? { always: { rule: "Bash(npm test:*)", label: "Run npm test" } } : {}) };
    await mock(page, s, { snapshot: { events: [ask], fields: { busy: true, waiting: "r1" } } });
    await page.goto(`${fx.base}/w/${fx.ready}/chat`);
    await page.getByRole("button", { name: "Allow", exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
    const n = await page.getByRole("button", { name: /^Always allow/ }).count();
    check(`ask ${withAlways ? "with" : "without"} an always offer: ${withAlways ? "'Always allow: Run npm test' is there" : "no Always allow"}`, n === (withAlways ? 1 : 0));
    if (withAlways) {
      const cls = await page.getByRole("button", { name: /^Always allow/ }).getAttribute("class");
      check("ask: Always allow is not the primary button", !/btn-primary/.test(cls ?? ""));
      await page.getByRole("button", { name: /^Always allow/ }).click();
      await page.waitForTimeout(300);
      check("ask: Always allow answers allow with always", s.answers.length === 1 && s.answers[0].allow === true && s.answers[0].always === true, JSON.stringify(s.answers));
    }
    await ctx.close();
  }

  /* -------------------------------------------------- busy: one-shot unavailable -- */
  {
    const s = freshState();
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page, s, { snapshot: { fields: { busy: true, busySince: Date.now() } } });
    await page.goto(`${fx.base}/w/${fx.ready}/chat`);
    const chip = page.locator('button[aria-label^="AI and model"]:visible').first();
    await chip.waitFor({ timeout: 15000 });
    await page.waitForTimeout(600);
    await chip.click();
    const item = page.getByRole("menuitem", { name: /Just for the next message/ });
    check("one-shot: unavailable while the AI works", (await item.count()) === 1 && (await item.getAttribute("aria-disabled")) === "true" && /Wait until the reply finishes/.test(await item.innerText()));
    await ctx.close();
  }

  /* ------------------------------------------------------------ the member's view -- */
  {
    const s = freshState();
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page, s, { member: true });
    await page.goto(`${fx.base}/settings/agents`);
    await page.getByRole("heading", { name: "Defaults for new projects" }).waitFor({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    const body = await page.locator("body").innerText();
    check("member: defaults are read-only", /Only the owner can change these\./.test(body) && (await page.getByRole("button", { name: /Use the built-in/ }).count()) === 0);
    check("member: no account buttons, no key, no router address", (await page.getByRole("button", { name: /Add another|Replace key|Test$/ }).count()) === 0 && !/127\.0\.0\.1/.test(body) && !body.includes(CANARY));
    await ctx.close();
  }

  /* ------------------------------------------------------------ phone composer row -- */
  for (const width of [360, 390]) {
    const s = freshState();
    const ctx = await openContext(browser, { width, height: 780, key: KEY, touch: true, timezoneId: TZ });
    const page = await ctx.newPage();
    await mock(page, s);
    await page.goto(`${fx.base}/w/${fx.ready}/chat`);
    await page.locator('button[aria-label^="Mode:"]:visible').first().waitFor({ timeout: 15000 }).catch(() => {});
    await page.locator("textarea[data-composer]").fill("hello");
    await page.waitForTimeout(500);
    const row = await page.evaluate(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none";
      };
      const pick = (sel) => [...document.querySelectorAll(sel)].find(vis);
      const box = (el) => (el ? el.getBoundingClientRect() : null);
      const attach = pick('button[aria-label="Add files"]');
      const model = pick('button[aria-label^="AI and model"]');
      const mode = pick('button[aria-label^="Mode:"]');
      const send = pick('button[aria-label="Send"]');
      return {
        attach: box(attach),
        model: box(model),
        modelText: model?.innerText.trim() ?? "",
        mode: box(mode),
        modeText: mode?.innerText.trim() ?? "",
        modeLabel: mode?.getAttribute("aria-label") ?? "",
        send: box(send),
        vw: document.documentElement.clientWidth,
        scrollW: document.documentElement.scrollWidth,
      };
    });
    const parts = [row.attach, row.model, row.mode, row.send];
    check(`${width}px composer: attach, model chip, mode icon and Send are all there`, parts.every(Boolean), JSON.stringify(row).slice(0, 200));
    if (parts.every(Boolean)) {
      const tops = parts.map((b) => b.top + b.height / 2);
      check(`${width}px composer: they sit on one row`, Math.max(...tops) - Math.min(...tops) < 8, tops.map(Math.round).join(","));
      check(`${width}px composer: all inside the screen`, parts.every((b) => b.left >= 0 && b.right <= row.vw + 0.5), parts.map((b) => `${Math.round(b.left)}-${Math.round(b.right)}`).join(" "));
      check(`${width}px composer: the model chip shows its name (12+ characters or all of it)`, row.modelText.replace(/…$/, "").length >= 10 && !row.modelText.endsWith("…") || row.modelText.length >= 12, row.modelText);
      check(`${width}px composer: the mode is a shield with a name for screen readers, no word`, row.modeText === "" && row.modeLabel === "Mode: Asks first", `${row.modeText} | ${row.modeLabel}`);
      check(`${width}px composer: the phone chip says Sonnet and not the AI's name`, !/^Claude/.test(row.modelText), row.modelText);
    }
    check(`${width}px: no sideways scroll`, row.scrollW <= row.vw, `${row.scrollW} > ${row.vw}`);
    await page.screenshot({ path: `/tmp/v26-web-${width}.png` });
    // the Run panel as a sheet on a phone
    await page.locator('button[aria-label^="Run details"]').click();
    const sheet = page.getByRole("dialog", { name: "Run details" });
    await sheet.getByRole("heading", { name: "If the limit is reached", level: 3 }).waitFor({ timeout: 10000 }).catch(() => {});
    check(`${width}px: the Run panel sheet has the limit block and the rules`, (await sheet.getByRole("heading", { name: "What it can do without asking", level: 3 }).count()) === 1 && (await sheet.getByRole("heading", { name: "If the limit is reached", level: 3 }).count()) === 1);
    await design(page, `${width}px with the Run panel sheet`, true);
    await page.screenshot({ path: `/tmp/v26-web-${width}-run.png` });
    await ctx.close();
  }
} finally {
  await browser?.close();
  fx.stop();
}

/* ------------------------------------------------------- the files themselves -- */
const root = new URL("../web/src/", import.meta.url).pathname;
const read = (f) => readFileSync(join(root, f), "utf8");
for (const f of ["components/AccountDialogs.tsx", "components/AiDefaultsPanel.tsx", "components/AiMenus.tsx", "components/RulesPanel.tsx"]) {
  const text = read(f);
  check(`${f}: no colour literal or primitive`, !/#[0-9a-fA-F]{3,8}\b|oklch\(|rgba?\(/.test(text) && !/(?:^|[^\w-])(?:text|bg|border|fill|stroke|ring)-(?:neutral|red|lime)-\d/.test(text));
}
const dialogs = read("components/AccountDialogs.tsx");
check("AccountDialogs: the key is read from the field and never put in state, storage or a URL", !/useState\([^)]*key/i.test(dialogs) && !/localStorage|sessionStorage|location\./.test(dialogs));
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const radix = walk(root).filter((f) => /\.tsx?$/.test(f) && !f.endsWith("components/ui.tsx") && /from ["']@radix-ui\//.test(readFileSync(f, "utf8")));
check("no @radix-ui import outside ui.tsx", radix.length === 0, radix.join(", "));

console.log(failures ? `\n${failures} failed` : "\nall AI control UI checks passed");
process.exit(failures ? 1 : 0);
