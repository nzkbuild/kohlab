#!/usr/bin/env node
// Change Kohlab itself (v2.9.0), in the browser: the owner's Home entry, the Release tab of a Change Kohlab project
// (the three steps, Send for checking, the 5 s poll while checks are pending, Merge and update behind a confirm, then
// the existing update panel), the dirty-tree problem, and that a member or a normal project sees no Release tab.
//
// No real GitHub or gh runs. page.route answers /api/workspaces/:id/release (GET and POST), /api/kohlab/project, the
// update routes and the account role, in the shapes of the design. A throwaway server (own PORT, WORKS_DIR, PTY_SOCKET)
// only serves the built web/dist and the real project list. Skips with a printed reason when playwright-core or
// Chromium is missing.
//
//   cd web && bun run build && cd .. && node scripts/check-kohlab-ui.mjs
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

const KEY = "kohlab-ui-check-key";
const PR_URL = "https://github.com/example/kohlab/pull/7";

/* ---------------------------------------------------------------- state -- */
// What the fake server holds: the role, whether the project is a Change Kohlab one, and its release state.
const S = {
  role: "owner",
  kohlab: false,
  rel: null,
  posts: [],
};
const rel = (over = {}) => ({
  branch: "kohlab/check",
  ahead: 2,
  behind: 0,
  dirty: false,
  version: "2.9.0",
  base: { version: "2.8.3" },
  changelogTouched: true,
  pr: null,
  live: { behind: 0 },
  ...over,
});
const STATUS = {
  current: "2.8.3",
  latest: "2.9.0",
  available: false,
  commits: [],
  notes: "",
  upstream: null,
  head: "",
  checkedAt: Date.now(),
  error: null,
  running: false,
  startedAt: null,
  finishedAt: null,
  exit: null,
  unfinished: false,
  log: "",
};

/** The routes the Home and the Release tab read. The project list is the real one, with the flag set on the Change Kohlab project. */
async function mock(page, fresh) {
  await page.route(/\/api\/account$/, (route) => route.fulfill({ json: { id: S.role, role: S.role, kind: "user" } }));
  await page.route(/\/api\/providers$/, (route) => route.fulfill({ json: { providers: [], at: Date.now() } }));
  await page.route(/\/api\/ai\/defaults$/, (route) => route.fulfill({ json: { defaults: {} } }));
  await page.route(/\/api\/ai\/rules$/, (route) => route.fulfill({ json: { projects: [] } }));
  await page.route(/\/api\/release(\?.*)?$/, (route) => route.fulfill({ json: STATUS }));
  await page.route(/\/api\/release\/update$/, (route) => {
    S.posts.push("POST update");
    return route.fulfill({ json: { started: true } });
  });

  // The real list, with the Change Kohlab flag on the project made for this check.
  await page.route(/\/api\/workspaces$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const list = await res.json();
    for (const w of list) if (w.id === fresh && S.kohlab) w.kohlab = true;
    await route.fulfill({ status: res.status(), json: list });
  });

  await page.route(/\/api\/kohlab\/project$/, (route) => {
    S.posts.push("POST kohlab/project");
    S.kohlab = true;
    return route.fulfill({ json: { id: fresh, repo: "kohlab-source", task: "", agent: "claude", created: Date.now(), started: null, stopped: null, running: false, path: "", chat: true, kohlab: true } });
  });

  // The release state: GET reads it, POST open and merge act on it, the way the server answers.
  await page.route(/\/api\/workspaces\/[^/]+\/release$/, (route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fulfill({ json: S.rel });
    const { action } = JSON.parse(req.postData() || "{}");
    S.posts.push(`POST release ${action}`);
    if (action === "open") {
      S.rel.pr = S.rel.pr?.state === "open" ? S.rel.pr : { number: 7, url: PR_URL, state: "open", checks: "pending" };
      return route.fulfill({ json: S.rel });
    }
    if (S.rel.pr?.checks !== "passing") return route.fulfill({ status: 409, json: { error: "GitHub is still checking" } });
    S.rel.pr.state = "merged";
    return route.fulfill({ json: S.rel });
  });
}

const fx = await startFixture({ port: 7883, key: KEY });
let browser;
try {
  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });

  /* ---------------------------------------------- owner: Home's entry, then the tab -- */
  {
    S.role = "owner";
    S.kohlab = false;
    S.rel = rel();
    S.posts = [];
    const ctx = await openContext(browser, { width: 1280, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page, fx.fresh);

    await page.goto(`${fx.base}/`);
    const entry = page.getByRole("button", { name: "Change Kohlab itself", exact: true });
    await entry.waitFor({ timeout: 15000 }).catch(() => {});
    check("Home: the owner sees Change Kohlab itself", (await entry.count()) === 1);
    await entry.click();
    await page.waitForURL(`**/w/${fx.fresh}`, { timeout: 10000 }).catch(() => {});
    check("Home: the entry makes the project and opens it", S.posts.includes("POST kohlab/project") && page.url().endsWith(`/w/${fx.fresh}`), `${S.posts.join(", ")} ${page.url()}`);

    await page.goto(`${fx.base}/w/${fx.fresh}/release`);
    await page.getByRole("heading", { name: "Your change", exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
    check("Release tab: the owner sees the Release tab", (await page.getByRole("tab", { name: "Release", exact: true }).count()) === 1);
    const body = await page.locator("main, body").first().innerText();
    check("Release tab: the three steps, in words", ["Your change", "Check on GitHub", "Put it live"].every((h) => (body.match(new RegExp(h, "g")) ?? []).length >= 1));
    check("Release tab: says what is ready, and the version change", body.includes("2 changes ready to send.") && body.includes("Version 2.8.3 → 2.9.0") && body.includes("CHANGELOG updated: yes"), body.slice(0, 200).replace(/\n/g, " | "));
    const primaries = await page.locator(".btn-primary:visible").count();
    check("Release tab: one primary button (Send for checking)", primaries === 1, `${primaries}`);
    const send = page.getByRole("button", { name: "Send for checking", exact: true });
    check("Release tab: Send for checking is enabled when the change is ready", (await send.count()) === 1 && (await send.isEnabled()));
    check("Release tab: no Merge before the change is sent", (await page.getByRole("button", { name: "Merge and update", exact: true }).count()) === 0);

    await send.click();
    await page.getByText("Checking…", { exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    check("Send: posts open, and the check says Checking…", S.posts.includes("POST release open") && (await page.getByText("Checking…", { exact: true }).count()) === 1, S.posts.join(", "));
    const link = page.getByRole("link", { name: "Open on GitHub" });
    check("Send: Open on GitHub links to the pull request", (await link.count()) === 1 && (await link.getAttribute("href")) === PR_URL);
    const merge = page.getByRole("button", { name: "Merge and update", exact: true });
    check("Put it live: Merge and update waits, disabled while checking", (await merge.count()) === 1 && !(await merge.isEnabled()));

    // The server reports the checks as passed; the open view reads them again every 5 s, with no action from the owner.
    S.rel.pr.checks = "passing";
    await page.getByText("Passed", { exact: true }).waitFor({ timeout: 9000 }).catch(() => {});
    check("Checks: the view picks up a pass by itself, and says Passed", (await page.getByText("Passed", { exact: true }).count()) === 1);
    check("Put it live: Merge and update is enabled once passed", await merge.isEnabled());

    await merge.click();
    const dlg = page.getByRole("alertdialog");
    await dlg.waitFor({ timeout: 5000 }).catch(() => {});
    check("Merge: asks first, with the words", (await dlg.getByText("This puts the change on GitHub's main branch and updates this server. Running sessions keep going.", { exact: true }).count()) === 1);
    await dlg.getByRole("button", { name: "Merge and update", exact: true }).click();
    await page.getByText("Merged.", { exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    check("Merge: posts merge, then the existing update, and shows Merged.", S.posts.includes("POST release merge") && S.posts.includes("POST update") && (await page.getByText("Merged.", { exact: true }).count()) === 1, S.posts.join(", "));
    check("Merge: the existing update panel is shown", (await page.getByText("Kohlab version 2.8.3", { exact: false }).count()) >= 1);
    await ctx.close();
  }

  /* ----------------------------------------------------- owner: a dirty tree is named -- */
  {
    S.role = "owner";
    S.kohlab = true;
    S.rel = rel({ dirty: true });
    S.posts = [];
    const ctx = await openContext(browser, { width: 1280, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page, fx.fresh);
    await page.goto(`${fx.base}/w/${fx.fresh}/release`);
    await page.getByRole("heading", { name: "Your change", exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
    check("Problems: a dirty tree is said in plain words", (await page.getByText("Some changes are not kept yet. Keep or undo them first.", { exact: true }).count()) === 1);
    const send = page.getByRole("button", { name: "Send for checking", exact: true });
    check("Problems: Send for checking is disabled while the tree is dirty", (await send.count()) === 1 && !(await send.isEnabled()));
    await ctx.close();
  }

  /* ------------------------------------------------- member: no Home entry, no tab -- */
  {
    S.role = "member";
    S.kohlab = true;
    S.rel = rel();
    S.posts = [];
    const ctx = await openContext(browser, { width: 1280, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page, fx.fresh);
    await page.goto(`${fx.base}/`);
    await page.getByRole("heading", { name: "What should we build?", exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
    check("member: no Change Kohlab itself on Home", (await page.getByRole("button", { name: "Change Kohlab itself", exact: true }).count()) === 0);
    await page.goto(`${fx.base}/w/${fx.fresh}/chat`);
    await page.locator("h1").first().waitFor({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    check("member: a Change Kohlab project has no Release tab", (await page.getByRole("tab", { name: "Release", exact: true }).count()) === 0);
    await ctx.close();
  }

  /* ------------------------------------------- owner: a normal project has no tab -- */
  {
    S.role = "owner";
    S.kohlab = false;
    S.rel = rel();
    const ctx = await openContext(browser, { width: 1280, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page, fx.fresh);
    await page.goto(`${fx.base}/w/${fx.ready}/chat`);
    await page.locator("h1").first().waitFor({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    check("normal project: the owner sees no Release tab", (await page.getByRole("tab", { name: "Release", exact: true }).count()) === 0);
    await ctx.close();
  }
} finally {
  await browser?.close();
  fx.stop();
}
console.log(failures ? `\n${failures} failed` : "\nall Change Kohlab UI checks passed");
process.exit(failures ? 1 : 0);
