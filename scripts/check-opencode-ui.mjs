#!/usr/bin/env node
// OpenCode in Settings → AI (v2.9.3), in the browser: install (and a failed install), sign in with a browser code,
// add an account, connect a service with an API key (the key never shown again), switch, sign out, remove, the
// "Another service…" id check, and a member's read-only view.
//
// No real OpenCode runs and no model is called. page.route answers the routes exactly as the Design sets them:
//   GET/POST /api/ai/providers/opencode/install          {state, error?}
//   GET      /api/ai/opencode/integrations               {popular: [{id, name}]}
//   GET      /api/ai/opencode/integrations?integration=X {integration, methods: [{id, name}]}
//   POST/GET /api/ai/accounts/:id/opencode/signin        {state, url?, code?, error?}
//   POST     /api/ai/accounts/:id/opencode/key           {connections}
//   POST     /api/ai/accounts/:id/opencode/logout|switch {connections}
// A throwaway server (own PORT, WORKS_DIR, PTY_SOCKET) only serves the built web/dist.
// Skips with a printed reason when playwright-core or Chromium is missing.
//
//   cd web && bun run build && node scripts/check-opencode-ui.mjs
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

const KEY = "sk-fake-opencode-check-key-0001";
const SIGN_IN_URL = "https://opencode.ai/console/device?user_code=GLTD-GCQN&client_id=opencode-cli";
const MAIN = "main:opencode";
const NAMES = { opencode: "OpenCode Console", openai: "OpenAI", "github-copilot": "GitHub Copilot", anthropic: "Anthropic" };
const POPULAR = [
  { id: "opencode", name: "OpenCode Console" },
  { id: "openai", name: "OpenAI" },
  { id: "github-copilot", name: "GitHub Copilot" },
  { id: "anthropic", name: "Anthropic" },
];
const METHODS = {
  opencode: [{ id: "device", name: "Browser code" }, { id: "key", name: "API key" }],
  openai: [{ id: "chatgpt-headless", name: "Sign in with ChatGPT (code)" }, { id: "key", name: "API key" }],
  "github-copilot": [{ id: "device", name: "Browser code" }],
  anthropic: [{ id: "key", name: "API key" }],
};
const MODELS = [{ value: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5", group: "anthropic" }];

/* ---------------------------------------------------------------- state -- */
// What the fake server holds. `main` is the AI user's own profile; `accounts` are the extra profiles.
let S;
function reset(over = {}) {
  S = { installed: true, install: "idle", polls: 0, failInstall: false, main: [], accounts: [], signin: null, signinPolls: 0, signinFor: MAIN, posts: [], keyPosts: [], ...over };
}
const connsOf = (id) => (id === MAIN ? S.main : (S.accounts.find((a) => a.id === id)?.connections ?? []));
const oc = (over) => ({ id: "default", label: "OpenCode", email: null, plan: null, auth: "api_key", state: "signed_out", isolation: {}, usage: null, models: [], modelsAt: null, kind: "default", connections: [], ...over });

/** The owner's card as the server would send it now. */
function cards() {
  const accounts = [oc({ id: "default", state: S.main.length ? "connected" : "signed_out", connections: S.main, models: S.main.length ? MODELS : [], modelsAt: S.main.length ? 1 : null })];
  for (const a of S.accounts) accounts.push(oc({ id: a.id, label: a.label, kind: "login", state: a.connections.length ? "connected" : "signed_out", connections: a.connections, models: a.connections.length ? MODELS : [], modelsAt: a.connections.length ? 1 : null }));
  const state = !S.installed ? "not_installed" : accounts.some((a) => a.state === "connected") ? "connected" : "signed_out";
  return [{ id: "opencode", name: "OpenCode", kind: "cli", installed: S.installed, version: S.installed ? "2.3.0" : null, state, checkedAt: Date.now(), stale: false, accounts: S.installed ? accounts : [], actions: [] }];
}

async function mock(page, { member = false } = {}) {
  const json = (route, body) => route.fulfill({ json: body });
  await page.route(/\/api\/providers$/, (r) => json(r, { providers: cards(), at: Date.now() }));
  await page.route(/\/api\/providers\/refresh$/, (r) => json(r, { providers: cards(), at: Date.now() }));
  await page.route(/\/api\/ai\/defaults$/, (r) => json(r, { defaults: {} }));
  await page.route(/\/api\/ai\/rules$/, (r) => json(r, { projects: [] }));
  if (member) await page.route(/\/api\/account$/, (r) => json(r, { id: "sam", role: "member", kind: "user" }));

  // Install: POST starts it; the first poll after that finishes it (or fails it, when the check asks).
  await page.route(/\/api\/ai\/providers\/opencode\/install$/, (route) => {
    if (route.request().method() === "POST") {
      S.posts.push("POST install");
      S.install = "installing";
      S.polls = 0;
      return json(route, { state: "installing" });
    }
    if (S.install === "installing" && ++S.polls >= 1) {
      S.install = S.failInstall ? "failed" : "done";
      S.installed = !S.failInstall;
    }
    return json(route, S.install === "failed" ? { state: "failed", error: "npm exited with code 1." } : { state: S.install });
  });

  await page.route(/\/api\/ai\/opencode\/integrations(\?|$)/, (route) => {
    const id = new URL(route.request().url()).searchParams.get("integration");
    if (!id) return json(route, { popular: POPULAR });
    S.posts.push(`GET methods ${id}`);
    return json(route, { integration: id, methods: METHODS[id] ?? [] });
  });

  // Browser-code sign-in: POST starts it (code and link); GET after one poll says done and adds the connection.
  await page.route(/\/api\/ai\/accounts\/[^/]+\/opencode\/signin$/, (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const body = req.postDataJSON();
      S.posts.push(`POST signin ${body.integration} ${body.method}`);
      S.signinFor = decodeURIComponent(/accounts\/([^/]+)\//.exec(req.url())[1]);
      S.signinPolls = 0;
      // A form-only service (GitHub Copilot) cannot sign in here: the server answers failed, in words.
      S.signin = body.integration === "github-copilot" ? { state: "failed", error: "Not available here yet." } : { state: "waiting", url: SIGN_IN_URL, code: "GLTD-GCQN" };
      return json(route, S.signin);
    }
    if (S.signin?.state === "waiting" && ++S.signinPolls >= 1) {
      S.signin = { state: "done" };
      connsOf(S.signinFor).push({ integration: "opencode", name: "OpenCode Console", label: "Main", active: true });
    }
    return json(route, S.signin);
  });

  // An API key: the five fields go to the server; the check keeps what arrived and returns nothing secret.
  await page.route(/\/api\/ai\/accounts\/[^/]+\/opencode\/key$/, (route) => {
    const body = route.request().postDataJSON();
    const id = decodeURIComponent(/accounts\/([^/]+)\//.exec(route.request().url())[1]);
    S.keyPosts.push(body);
    S.posts.push(`POST key ${body.integration}`);
    const conns = connsOf(id);
    conns.push({ integration: body.integration, name: NAMES[body.integration] ?? body.integration, label: body.label || body.integration, active: Boolean(body.useNow) || conns.length === 0 });
    return json(route, { connections: conns });
  });

  await page.route(/\/api\/ai\/accounts\/[^/]+\/opencode\/(logout|switch)$/, (route) => {
    const body = route.request().postDataJSON();
    const act = /opencode\/(logout|switch)$/.exec(route.request().url())[1];
    const id = decodeURIComponent(/accounts\/([^/]+)\//.exec(route.request().url())[1]);
    S.posts.push(`POST ${act} ${body.integration} ${body.label}`);
    const conns = connsOf(id);
    if (act === "logout") conns.splice(0, conns.length, ...conns.filter((c) => !(c.integration === body.integration && c.label === body.label)));
    else for (const c of conns) c.active = c.integration === body.integration && c.label === body.label;
    return json(route, { connections: conns });
  });

  await page.route(/\/api\/ai\/accounts$/, (route) => {
    const body = route.request().postDataJSON();
    S.posts.push(`POST accounts ${body.provider} ${body.label}`);
    const acc = { id: `acc-${S.accounts.length + 1}`, label: body.label, connections: [] };
    S.accounts.push(acc);
    return json(route, { account: { id: acc.id, provider: "opencode", kind: "login", label: acc.label, createdAt: Date.now() } });
  });
  await page.route(/\/api\/ai\/accounts\/[^/]+$/, (route) => {
    const id = decodeURIComponent(/accounts\/([^/]+)$/.exec(route.request().url())[1]);
    S.posts.push(`DELETE ${id}`);
    S.accounts = S.accounts.filter((a) => a.id !== id);
    return json(route, { ok: true });
  });
}

const fx = await startFixture({ port: 7943, key: KEY });
let browser;
const card = (page) => page.locator("section.panel", { has: page.getByRole("heading", { name: /^OpenCode/ }) });
try {
  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });

  /* ------------------------------------------------- not installed: install -- */
  for (const failInstall of [false, true]) {
    reset({ installed: false, failInstall });
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/agents`);
    const install = page.getByRole("button", { name: "Install OpenCode", exact: true });
    await install.waitFor({ timeout: 15000 }).catch(() => {});
    const c = card(page);
    check(`${failInstall ? "failed install" : "install"}: the card says Not installed and offers Install OpenCode`, (await c.getByText("Not installed", { exact: true }).count()) === 1 && (await install.count()) === 1);
    await install.click();
    await c.getByText("Installing… this takes a minute.", { exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
    check("install: the words while it runs, and no terminal", (await c.getByText("Installing… this takes a minute.", { exact: true }).count()) === 1 && !/terminal/i.test(await c.innerText()) && S.posts.includes("POST install"));
    if (failInstall) {
      await c.getByRole("button", { name: "Try again", exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
      const text = await c.innerText();
      check("failed install: a plain sentence and Try again", /Couldn't install OpenCode\. npm exited with code 1\./.test(text) && (await c.getByRole("button", { name: "Try again", exact: true }).count()) === 1, text.replace(/\n/g, " | "));
    } else {
      await c.getByRole("button", { name: "Sign in", exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
      check("install done: the card reads again and offers Sign in for the main account", (await c.getByText("Main account", { exact: true }).count()) === 1 && (await c.getByRole("button", { name: "Sign in", exact: true }).count()) === 1);
    }
    await ctx.close();
  }

  /* -------------------------------- signed out: browser-code sign-in, Done -- */
  {
    reset({ installed: true });
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/agents`);
    const c = card(page);
    await c.getByRole("button", { name: "Sign in", exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
    check("signed out: Main account, Not signed in, Sign in", (await c.getByText("Main account", { exact: true }).count()) === 1 && (await c.getByText("Not signed in", { exact: true }).count()) === 1);
    await c.getByRole("button", { name: "Sign in", exact: true }).click();
    const dlg = page.getByRole("dialog", { name: "Sign in to OpenCode" });
    await dlg.getByRole("button", { name: "OpenCode Console", exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    const pick = await dlg.innerText();
    check("sign-in: asks what to connect, with the popular services and Another service…", /What do you want to connect\?/.test(pick) && ["OpenCode Console", "OpenAI", "GitHub Copilot", "Anthropic", "Another service…"].every((n) => pick.includes(n)), pick.replace(/\n/g, " | "));
    await dlg.getByRole("button", { name: "OpenCode Console", exact: true }).click();
    await dlg.getByRole("button", { name: "Browser code", exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    check("sign-in: two ways, Browser code and API key, for OpenCode Console", (await dlg.getByRole("button", { name: "Browser code", exact: true }).count()) === 1 && (await dlg.getByRole("button", { name: "API key", exact: true }).count()) === 1);
    await dlg.getByRole("button", { name: "Browser code", exact: true }).click();
    await dlg.getByText("GLTD-GCQN", { exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    check("browser code: the code is shown big, with Open the sign-in page and Copy link", (await dlg.getByText("GLTD-GCQN", { exact: true }).count()) === 1 && (await dlg.getByRole("button", { name: "Open the sign-in page", exact: true }).count()) === 1 && (await dlg.getByRole("button", { name: "Copy link", exact: true }).count()) === 1);
    check("browser code: status says it is waiting, and never mentions a terminal", (await dlg.getByText("Waiting for you to finish in the browser…", { exact: true }).count()) === 1 && !/terminal|\brun\b|auth login/i.test(await dlg.innerText()));
    check("browser code: posts the integration and the method", S.posts.includes("POST signin opencode device"), S.posts.join(", "));
    await dlg.getByText("OpenCode Console is connected.", { exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    check("browser code: done says it is connected and offers Done", (await dlg.getByText("OpenCode Console is connected.", { exact: true }).count()) === 1 && (await dlg.getByRole("button", { name: "Done", exact: true }).count()) === 1);
    await dlg.getByRole("button", { name: "Done", exact: true }).click();
    await dlg.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    await c.getByText("OpenCode Console — Main — Active", { exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    check("after sign-in: the connection shows as a row, Active, and the main account reads Signed in", (await c.getByText("OpenCode Console — Main — Active", { exact: true }).count()) === 1 && (await c.getByText("Signed in", { exact: true }).count()) === 1);
    await ctx.close();
  }

  /* ---------------------- connected: menus, add, API key, sign out, remove -- */
  {
    reset({ installed: true, main: [{ integration: "opencode", name: "OpenCode Console", label: "Main", active: true }] });
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/agents`);
    const c = card(page);
    await c.getByText("OpenCode Console — Main — Active", { exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
    await c.getByRole("button", { name: "More actions for Main account", exact: true }).click();
    const items = await page.getByRole("menuitem").allInnerTexts();
    check("main account menu: Add a connection, and no Rename or Remove", items.includes("Add a connection") && !items.includes("Rename") && !items.includes("Remove"), items.join(", "));
    await page.keyboard.press("Escape");

    await c.getByRole("button", { name: "Add another OpenCode account", exact: true }).click();
    await c.getByText("Account 2", { exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    check("add another: an empty account named Account 2 is created, not signed in", S.posts.includes("POST accounts opencode Account 2") && (await c.getByText("Account 2", { exact: true }).count()) === 1);

    await c.getByRole("button", { name: "Sign in", exact: true }).click();
    const dlg = page.getByRole("dialog", { name: "Sign in to Account 2" });
    await dlg.getByRole("button", { name: "Anthropic", exact: true }).click();
    await dlg.getByText("Paste the API key for Anthropic", { exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    check("API key: a single method goes straight to the key step, with the key field as a password", (await dlg.locator("#opencode-key").getAttribute("type")) === "password" && (await dlg.getByRole("button", { name: "Connect", exact: true }).count()) === 1);
    await dlg.locator("#opencode-key").fill(KEY);
    await dlg.locator("#opencode-label").fill("Work");
    await dlg.getByRole("checkbox", { name: "Use this one now", exact: true }).check();
    await dlg.getByRole("button", { name: "Connect", exact: true }).click();
    await dlg.getByRole("button", { name: "Done", exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    const sent = S.keyPosts[0] ?? {};
    check("API key: the five fields reach the server (integration, key, label, use now)", sent.integration === "anthropic" && sent.key === KEY && sent.label === "Work" && sent.useNow === true, JSON.stringify(sent).replace(KEY, "<key>"));
    check("API key: the key is never shown again after it is sent", !(await dlg.innerText()).includes(KEY) && (await page.content()).indexOf(KEY) === -1 && (await dlg.locator("#opencode-key").count()) === 0);
    await dlg.getByRole("button", { name: "Done", exact: true }).click();
    await dlg.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    await c.getByText("Anthropic — Work — Active", { exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    check("API key: the connection shows under Account 2 as Anthropic — Work — Active", (await c.getByText("Anthropic — Work — Active", { exact: true }).count()) === 1);

    await c.getByRole("button", { name: "More actions for OpenCode Console Main", exact: true }).click();
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    await confirm.waitFor({ timeout: 5000 }).catch(() => {});
    check("sign out of a connection asks first, by name", /Sign out of OpenCode Console\?/.test(await confirm.innerText()) && !S.posts.some((p) => p.startsWith("POST logout")));
    await confirm.getByRole("button", { name: "Sign out", exact: true }).click();
    await c.getByRole("button", { name: "Sign in", exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    check("sign out posts the connection's integration and label", S.posts.includes("POST logout opencode Main"), S.posts.join(", "));

    await c.getByRole("button", { name: "More actions for Account 2", exact: true }).click();
    await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove", exact: true }).click();
    await c.getByText("Account 2", { exact: true }).waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
    check("remove an extra account: it is deleted and its row goes", S.posts.includes("DELETE acc-1") && (await c.getByText("Account 2", { exact: true }).count()) === 0);

    // "Another service…": an id is checked before it is used; a service with no way to connect says so.
    await c.getByRole("button", { name: "Sign in", exact: true }).click();
    const other = page.getByRole("dialog", { name: "Sign in to OpenCode" });
    await other.getByRole("button", { name: "Another service…", exact: true }).click();
    await other.locator("#opencode-service").fill("Bad Id!");
    await other.getByText("Use lower-case letters, numbers, dots, dashes or underscores.", { exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
    check("another service: a bad id is refused in words and Continue is off", (await other.getByText("Use lower-case letters, numbers, dots, dashes or underscores.", { exact: true }).count()) === 1 && (await other.getByRole("button", { name: "Continue", exact: true }).isDisabled()));
    await other.locator("#opencode-service").fill("openrouter");
    await other.getByRole("button", { name: "Continue", exact: true }).click();
    await other.getByText("Not available here yet.", { exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    check("another service: no way to connect here says Not available here yet", (await other.getByText("Not available here yet.", { exact: true }).count()) === 1 && S.posts.includes("GET methods openrouter"));
    await page.keyboard.press("Escape");
    await ctx.close();
  }

  /* ----------------------------- a form-only service: plain words and Back -- */
  {
    reset({ installed: true });
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/agents`);
    const c = card(page);
    await c.getByRole("button", { name: "Sign in", exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
    await c.getByRole("button", { name: "Sign in", exact: true }).click();
    const dlg = page.getByRole("dialog", { name: "Sign in to OpenCode" });
    await dlg.getByRole("button", { name: "GitHub Copilot", exact: true }).click();
    await dlg.getByText("Not available here yet.", { exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    const txt = await dlg.innerText();
    check("form-only service: Not available here yet. in plain words, with Back and no crash", /Not available here yet\./.test(txt) && (await dlg.getByRole("button", { name: "Back", exact: true }).count()) === 1 && S.posts.includes("POST signin github-copilot device"), txt.replace(/\n/g, " | "));
    await dlg.getByRole("button", { name: "Back", exact: true }).click();
    check("form-only service: Back returns to the list", (await dlg.getByRole("button", { name: "OpenCode Console", exact: true }).count()) === 1);
    await ctx.close();
  }

  /* ---------------------------------------- a member: the states, no actions -- */
  for (const connected of [false, true]) {
    reset({ installed: true, main: connected ? [{ integration: "opencode", name: "OpenCode Console", label: "Main", active: true }] : [] });
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page, { member: true });
    await page.goto(`${fx.base}/settings/agents`);
    const c = card(page);
    await c.getByRole("heading", { name: "OpenCode", exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
    const text = await c.innerText();
    if (connected) {
      check("member: a connected OpenCode shows its state and no actions", !/Install|Sign in|Add another|More actions/.test(text) && /Connected/.test(text), text.replace(/\n/g, " | "));
    } else {
      check("member: signed out is said in words, asking the owner, with no actions", /Ask the owner to sign in to OpenCode\./.test(text) && !/Install|Sign in|Add another|More actions/.test(text), text.replace(/\n/g, " | "));
    }
    await ctx.close();
  }
} finally {
  await browser?.close();
  fx.stop();
}

console.log(failures ? `\n${failures} failed` : "\nall OpenCode UI checks passed");
process.exit(failures ? 1 : 0);
