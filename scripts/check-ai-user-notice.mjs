#!/usr/bin/env node
// Settings -> AI shows the owner a plain notice when the AI runs as the server's own account (root) or its
// account is missing, and nothing when it runs as its own account or the server is not root. Members never
// see it. page.route answers /api/agents-status and /api/providers, so no AI CLI runs.
//
// Throwaway server on its own PORT (7949), WORKS_DIR and PTY_SOCKET, against the built web/dist. Skips with a
// printed reason when playwright-core or Chromium is missing.
//
//   cd web && bun run build && node scripts/check-ai-user-notice.mjs
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

const KEY = "ai-user-notice-check-key";
const NOTICE_ROOT = "Your AI runs as the server's own account (root)";
const NOTICE_MISSING = "The AI user 'kohlab-agent' is missing.";
const COPY = "Copy the command kohlab ai-user setup";

/** Answers the two routes the pane reads. `aiUser` is what the server reports; `member` makes the caller a member. */
async function mock(page, { aiUser, member = false }) {
  await page.route(/\/api\/agents-status$/, (route) => route.fulfill({ json: { claude: true, aiUser } }));
  await page.route(/\/api\/providers$/, (route) => route.fulfill({ json: { providers: [], at: Date.now() } }));
  if (member) await page.route(/\/api\/account$/, (route) => route.fulfill({ json: { id: "sam", name: "Sam", role: "member", kind: "user" } }));
}

/** Opens Settings -> AI and waits until the pane has read its status. */
async function openAi(browser, { aiUser, member = false }) {
  const ctx = await openContext(browser, { width: 1280, height: 900, key: KEY });
  const page = await ctx.newPage();
  await mock(page, { aiUser, member });
  await page.goto(`${fx.base}/settings/agents`);
  await page.getByRole("heading", { name: "Defaults for new projects" }).waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500); // the status read is a second request, after the pane
  return { ctx, page };
}

const fx = await startFixture({ port: 7949, key: KEY });
let browser;
try {
  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });

  {
    const { ctx, page } = await openAi(browser, { aiUser: { mode: "root" } });
    check("root: the owner sees the root notice", (await page.getByText(NOTICE_ROOT).count()) === 1);
    check("root: the fix is a Copy button with the exact command", (await page.getByRole("button", { name: COPY }).count()) === 1);
    check("root: the notice is a status region", (await page.getByRole("status").filter({ hasText: NOTICE_ROOT }).count()) === 1);
    await ctx.close();
  }
  {
    const { ctx, page } = await openAi(browser, { aiUser: { mode: "missing", name: "kohlab-agent" } });
    check("missing: the owner sees 'The AI user is missing'", (await page.getByText(NOTICE_MISSING).count()) === 1);
    check("missing: the same Copy button", (await page.getByRole("button", { name: COPY }).count()) === 1);
    await ctx.close();
  }
  for (const aiUser of [{ mode: "agent", name: "kohlab-agent" }, { mode: "not-root" }]) {
    const { ctx, page } = await openAi(browser, { aiUser });
    check(`${aiUser.mode}: no notice`, (await page.getByText(/runs as the server's own account|is missing\./).count()) === 0);
    await ctx.close();
  }
  {
    const { ctx, page } = await openAi(browser, { aiUser: { mode: "root" }, member: true });
    check("root, but a member: no notice", (await page.getByText(NOTICE_ROOT).count()) === 0);
    await ctx.close();
  }
} finally {
  await browser?.close();
  fx.stop();
}

console.log(failures ? `\n${failures} failed` : "\nall AI user notice checks passed");
process.exit(failures ? 1 : 0);
