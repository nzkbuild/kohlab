#!/usr/bin/env node
// Sign in without a terminal (v2.8.3), in the browser: the one sign-in dialog for the main login and extra logins, the
// rows of each AI with their ⋯ menus, sign out, the add flow that finishes an unfinished login first, the chat's "Sign in"
// under a "Claude is signed out" error (owners only), and the composer's AI picker before the first message.
//
// No real AI CLI runs. page.route answers /api/providers (and its refresh), /api/ai/* sign-in and sign-out routes, the
// chat run and snapshot. A throwaway server (own PORT, WORKS_DIR, PTY_SOCKET) only serves the built web/dist.
// Skips with a printed reason when playwright-core or Chromium is missing.
//
//   cd web && bun run build && node scripts/check-signin-ui.mjs
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
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`);
};

const EMAIL = "you@example.com";
const KEY = "signin-ui-check-key";

/* ---------------------------------------------------------------- state -- */
// What the fake server holds: is the main Claude login in, and which extra logins exist.
const S = {
  claudeIn: false,
  codexIn: false,
  work: "connected", // "connected", "signed_out", or null (no such login)
  extras: [
    { id: "acc-a", label: "Account 2", state: "signed_out" },
    { id: "acc-b", label: "Account 2", state: "signed_out" },
    { id: "acc-c", label: "Account 2", state: "signed_out" },
    { id: "acc-d", label: "Account 2", state: "signed_out" },
  ],
  posts: [],
};
const SIGN_IN_URL = "https://claude.ai/oauth/authorize?state=check";

const account = (over) => ({ id: "default", label: "Claude", email: null, plan: null, auth: "oauth", state: "connected", isolation: {}, usage: null, models: [], modelsAt: 1, kind: "default", ...over });
const SONNET = [{ value: "claude-sonnet-5-5", label: "Sonnet 5.5" }];
/** The owner's cards as the server would send them now. */
function cards() {
  // The server always lists the main login: signed out (no email) until it is signed in.
  const accounts = [S.claudeIn ? account({ email: EMAIL, plan: "max", models: SONNET }) : account({ state: "signed_out" })];
  for (const e of S.extras) accounts.push(account({ id: e.id, label: e.label, state: e.state, kind: "login", models: e.state === "connected" ? SONNET : [], modelsAt: e.state === "connected" ? 1 : null }));
  if (S.work) accounts.push(account({ id: "acc-work", label: "Work", email: null, state: S.work, kind: "login", models: S.work === "connected" ? SONNET : [], modelsAt: S.work === "connected" ? 1 : null }));
  const claudeOk = accounts.some((a) => a.state === "connected");
  return [
    {
      id: "claude",
      name: "Claude",
      kind: "cli",
      installed: true,
      version: "9.9.9",
      state: claudeOk ? "connected" : "signed_out",
      checkedAt: Date.now(),
      stale: false,
      accounts,
      actions: claudeOk ? [{ kind: "refresh", label: "Refresh" }, { kind: "sign_out", label: "Sign out" }] : [{ kind: "refresh", label: "Refresh" }, { kind: "sign_in", label: "Sign in", via: "url" }],
    },
    {
      id: "codex",
      name: "Codex",
      kind: "cli",
      installed: true,
      version: "1.0.0",
      state: S.codexIn ? "connected" : "signed_out",
      checkedAt: Date.now(),
      stale: false,
      accounts: [S.codexIn ? account({ id: "default", label: "Codex", email: EMAIL, plan: "plus", models: [{ value: "gpt-5", label: "GPT-5" }] }) : account({ id: "default", label: "Codex", state: "signed_out", kind: "default" })],
      actions: S.codexIn ? [{ kind: "refresh", label: "Refresh" }, { kind: "sign_out", label: "Sign out" }] : [{ kind: "refresh", label: "Refresh" }, { kind: "sign_in", label: "Sign in", via: "url" }],
    },
  ];
}

const RUN = {
  agent: "claude",
  agentName: "Claude",
  terminalProject: false,
  instructions: { system: null, notes: "", note: null },
  tools: { builtin: [], mcp: [] },
  ready: true,
};

/** Answers the sign-in routes. The fake browser approval: the code step (or the waiting poll) turns into done. */
async function mock(page, { member = false, chatError = false } = {}) {
  await page.route(/\/api\/providers$/, (route) => route.fulfill({ json: { providers: cards(), at: Date.now() } }));
  await page.route(/\/api\/providers\/refresh$/, (route) => route.fulfill({ json: { providers: cards(), at: Date.now() } }));
  await page.route(/\/api\/ai\/defaults$/, (route) => route.fulfill({ json: { defaults: {} } }));
  await page.route(/\/api\/ai\/rules$/, (route) => route.fulfill({ json: { projects: [] } }));
  if (member) await page.route(/\/api\/account$/, (route) => route.fulfill({ json: { id: "sam", role: "member", kind: "user" } }));

  // Settings' main sign-in: POST starts it, GET reads it, POST /signin/code sends the pasted code (Claude).
  await page.route(/\/api\/ai\/providers\/(claude|codex)\/signin(\/code)?$/, (route) => {
    const req = route.request();
    const provider = /providers\/(claude|codex)/.exec(req.url())[1];
    S.posts.push(`${req.method()} ${new URL(req.url()).pathname}`);
    if (req.method() === "POST" && req.url().endsWith("/code")) {
      if (provider === "claude") S.claudeIn = true;
      return route.fulfill({ json: { state: "done" } });
    }
    if (req.method() === "POST") return route.fulfill({ json: { state: "waiting", url: SIGN_IN_URL, needsCode: provider === "claude", code: provider === "codex" ? "ABCD-1234" : undefined } });
    return route.fulfill({ json: { state: "waiting", url: SIGN_IN_URL, needsCode: provider === "claude", code: provider === "codex" ? "ABCD-1234" : undefined } });
  });
  await page.route(/\/api\/ai\/providers\/(claude|codex)\/signout$/, (route) => {
    const provider = /providers\/(claude|codex)/.exec(route.request().url())[1];
    S.posts.push(`POST /api/ai/providers/${provider}/signout`);
    if (provider === "claude") S.claudeIn = false;
    else S.codexIn = false;
    return route.fulfill({ json: { ok: true } });
  });
  // Another login: sign-out keeps the account in the list as "Not signed in".
  await page.route(/\/api\/ai\/accounts\/[^/]+\/signout$/, (route) => {
    const id = /accounts\/([^/]+)\/signout/.exec(route.request().url())[1];
    S.posts.push(`POST /api/ai/accounts/${id}/signout`);
    if (id === "acc-work") S.work = "signed_out";
    return route.fulfill({ json: { ok: true } });
  });

  await page.route(/\/api\/workspaces\/[^/]+\/chat\/run$/, (route) => route.fulfill({ json: RUN }));
  await page.route(/\/api\/workspaces\/[^/]+\/chat\?after=/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (chatError) body.events = [...body.events, { n: 9100, at: Date.now(), kind: "error", text: "Claude is signed out. Sign in to carry on." }];
    await route.fulfill({ response: res, json: body });
  });
}

const fx = await startFixture({ port: 7881, key: KEY });
let browser;
try {
  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });

  /* ------------------------------------------- Settings -> AI, signed out -- */
  {
    S.claudeIn = false;
    S.work = "signed_out";
    S.extras = S.extras.map((e) => ({ ...e, state: "signed_out" }));
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/agents`);
    const signIn = page.getByRole("button", { name: "Sign in to Claude", exact: true });
    await signIn.waitFor({ timeout: 15000 }).catch(() => {});
    const claude = page.locator("section.panel:has(.chip)").nth(0);
    const claudeText = await claude.innerText();
    check("signed-out Claude offers Sign in to Claude", (await signIn.count()) === 1);
    check("no terminal or server command in the Claude card", !/terminal|auth login|run claude|on the server/i.test(claudeText), claudeText.replace(/\n/g, " | "));
    check("each unfinished login shows as Not signed in", (claudeText.match(/Not signed in/g) ?? []).length >= 4, claudeText.replace(/\n/g, " | "));

    // The add flow finds the unfinished logins first.
    await page.getByRole("button", { name: "Add another Claude account", exact: true }).click();
    const dlg = page.getByRole("dialog");
    await dlg.waitFor({ timeout: 5000 }).catch(() => {});
    check("add flow: offers Finish signing in to the unfinished login first", (await dlg.getByRole("button", { name: "Finish signing in to Account 2", exact: true }).count()) === 1);
    check("add flow: Add a new one is the quiet alternative", (await dlg.getByRole("button", { name: "Add a new one", exact: true }).count()) === 1);
    await dlg.getByRole("button", { name: "Add a new one", exact: true }).click();
    await dlg.getByRole("button", { name: "Sign in with another Claude login", exact: true }).click();
    const name = await dlg.locator("#account-name").inputValue().catch(() => "");
    check("add flow: the default name skips the names already taken", name === "Account 3", name);
    await page.keyboard.press("Escape");
    await dlg.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});

    // The main sign-in: one dialog, the steps in words, the code, then done.
    await signIn.click();
    const sign = page.getByRole("dialog", { name: "Sign in to Claude" });
    await sign.waitFor({ timeout: 5000 }).catch(() => {});
    await sign.getByRole("button", { name: "Open the sign-in page", exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
    check("sign-in: the page button and Copy link", (await sign.getByRole("button", { name: "Open the sign-in page", exact: true }).count()) === 1 && (await sign.getByRole("button", { name: "Copy link", exact: true }).count()) === 1);
    check("sign-in: asks for the pasted code (Claude)", (await sign.getByText("Paste the code it shows you", { exact: true }).count()) === 1 && (await sign.locator("#signin-code").count()) === 1);
    check("sign-in: status says it is waiting, in words", (await sign.getByText("Waiting for you to finish in the browser…").count()) === 1);
    check("sign-in: never mentions a terminal", !/terminal|command/i.test(await sign.innerText()));
    await sign.locator("#signin-code").fill("code-123");
    await sign.getByRole("button", { name: "Continue", exact: true }).click();
    await sign.getByText(`Signed in as ${EMAIL}`, { exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    check("sign-in: the code posts to the main login and the status says who signed in", S.posts.includes("POST /api/ai/providers/claude/signin/code") && (await sign.getByText(`Signed in as ${EMAIL}`, { exact: true }).count()) === 1, S.posts.join(", "));
    await sign.getByRole("button", { name: "Done", exact: true }).click();
    await sign.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    await ctx.close();
  }

  /* ----------------------------------------- rows, ⋯ menus, sign out, again -- */
  {
    S.claudeIn = true;
    S.work = "connected";
    S.extras = [];
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    S.posts = [];
    await page.goto(`${fx.base}/settings/agents`);
    const main = page.getByRole("button", { name: "More actions for Main account", exact: true });
    await main.waitFor({ timeout: 15000 }).catch(() => {});
    const claudeCard = page.locator("section.panel:has(.chip)").nth(0);
    check("the main login is the first row, named Main account", (await claudeCard.getByText("Main account", { exact: true }).count()) === 1);
    check("one AI can hold several accounts, said plainly", (await page.getByText("Claude can hold several accounts. Each project uses one of them.").count()) === 1);

    await main.click();
    const items = await page.getByRole("menuitem").allInnerTexts();
    check("main row menu: Sign in again and Sign out, no Rename or Remove", items.includes("Sign in again") && items.includes("Sign out") && !items.includes("Rename") && !items.includes("Remove"), items.join(", "));
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    await confirm.waitFor({ timeout: 5000 }).catch(() => {});
    check("sign out asks first, with the words", /Sign out of Claude\?/.test(await confirm.innerText()) && /Chats using it stop until you sign in again\./.test(await confirm.innerText()) && !S.posts.some((p) => p.includes("signout")));
    await confirm.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("button", { name: "Sign in to Claude", exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    await page.getByText("Not signed in", { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
    await claudeCard.getByRole("button", { name: "Sign in to Claude", exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    check("sign out posts to the main login; the main row stays as Not signed in with Sign in", S.posts.includes("POST /api/ai/providers/claude/signout") && (await claudeCard.getByText("Not signed in", { exact: true }).count()) === 1 && (await claudeCard.getByRole("button", { name: "Sign in to Claude", exact: true }).count()) === 1);
    await ctx.close();
  }

  {
    // Another login: signing it out keeps the account, as Not signed in, with Sign in offered.
    S.claudeIn = true;
    S.work = "connected";
    S.extras = [];
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    S.posts = [];
    await page.goto(`${fx.base}/settings/agents`);
    const more = page.getByRole("button", { name: "More actions for Work", exact: true });
    await more.waitFor({ timeout: 15000 }).catch(() => {});
    await more.click();
    const items = await page.getByRole("menuitem").allInnerTexts();
    check("another login's menu: Sign out, Rename and Remove", items.includes("Sign out") && items.includes("Rename") && items.includes("Remove"), items.join(", "));
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByText("Not signed in", { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
    check("sign out of another login keeps the account as Not signed in, with Sign in", S.posts.includes("POST /api/ai/accounts/acc-work/signout") && (await page.getByText("Work", { exact: true }).count()) === 1 && (await page.getByRole("button", { name: "Sign in", exact: true }).count()) >= 1);
    await ctx.close();
  }

  /* ---------------------------------- the chat: the picker and Sign in -- */
  for (const member of [false, true]) {
    S.claudeIn = true;
    S.work = "connected";
    S.extras = [];
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page, { member, chatError: true });
    await page.goto(`${fx.base}/w/${fx.fresh}/chat`);
    const chip = page.locator('button[aria-label^="AI and model"]:visible').first();
    await chip.waitFor({ timeout: 15000 }).catch(() => {});
    if (!member) {
      check("picker: enabled before the first message", await chip.isEnabled());
      await chip.click();
      const menu = page.getByRole("menu");
      await menu.waitFor({ timeout: 5000 }).catch(() => {});
      const text = await menu.innerText().catch(() => "");
      check("picker: lists every signed-in account of the AI", text.includes(`Claude · ${EMAIL}`) && text.includes("Claude · Work"), text.replace(/\n/g, " | ").slice(0, 160));
      await page.keyboard.press("Escape");
      const err = page.getByRole("button", { name: "Sign in", exact: true });
      await err.first().waitFor({ timeout: 15000 }).catch(() => {});
      check("chat: a signed-out error offers Sign in to the owner", (await err.count()) === 1);
      await err.click();
      check("chat: Sign in opens the sign-in dialog for Claude", (await page.getByRole("dialog", { name: "Sign in to Claude" }).count()) === 1);
    } else {
      await page.getByText("Ask the owner to sign Claude in.", { exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
      check("chat: a member is asked to get the owner to sign in", (await page.getByText("Ask the owner to sign Claude in.", { exact: true }).count()) === 1 && (await page.getByRole("button", { name: "Sign in", exact: true }).count()) === 0);
    }
    await ctx.close();
  }
} finally {
  await browser?.close();
  fx.stop();
}

console.log(failures ? `\n${failures} failed` : "\nall sign-in UI checks passed");
process.exit(failures ? 1 : 0);
