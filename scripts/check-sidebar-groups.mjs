#!/usr/bin/env bun
/**
 * Sidebar list order: one flat list, projects that need the owner first, then
 * the rest by most recent change. Also the relative time the rail no longer
 * shows, kept on the formatter it still uses elsewhere. A project that needs
 * the owner buried under "Earlier" would hide a question, so the order is checked.
 *
 * Run:  bun scripts/check-sidebar-groups.mjs
 */
import { sidebarOrder } from "../web/src/lib/sidebarOrder.ts";
import { workspaceStatus } from "../web/src/lib/status.ts";
import { sidebarWhen, projectTitle } from "../web/src/lib/format.ts";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

const base = { id: "w", repo: "/r", task: "t", agent: "sh", created: 1, started: null, stopped: null, running: false, path: "/p" };
const NOW = 1_000_000_000_000;
const MIN = 60_000;
const ids = (list) => list.map((w) => w.id);

check("waiting is needs-you", workspaceStatus({ ...base, running: true, waiting: true }), "needs-you");
check("stopped with changes is ready to check", workspaceStatus({ ...base, stopped: 9 }), "needs-review");

const oldNeeds = { ...base, id: "needs-old", started: 2, stopped: 4, waiting: true };
const newestPlain = { ...base, id: "plain-new", started: 2, stopped: 8 };
const newNeeds = { ...base, id: "needs-new", started: 2, stopped: 6, waiting: true };
const running = { ...base, id: "running", running: true, started: 7 };
const reviewed = { ...base, id: "review-old", stopped: 3 };
const input = [newestPlain, reviewed, running, oldNeeds, newNeeds];
const before = ids(input);

check("needs-you first, even when older", ids(sidebarOrder(input)), ["needs-new", "needs-old", "plain-new", "running", "review-old"]);
check("rest by most recent change, no status grouping", ids(sidebarOrder([reviewed, running, newestPlain])), ["plain-new", "running", "review-old"]);
check("sort does not mutate the store's array", ids(input), before);
check("empty list", sidebarOrder([]), []);

check("under a minute is now", sidebarWhen(NOW - 30_000, NOW), "now");
check("future clock skew is now", sidebarWhen(NOW + 5 * MIN, NOW), "now");
check("minutes", sidebarWhen(NOW - 2 * MIN, NOW), "2 min");
check("hours", sidebarWhen(NOW - 60 * MIN, NOW), "1 hr");
check("hours just under a day", sidebarWhen(NOW - 23 * 60 * MIN, NOW), "23 hr");
const threeDays = sidebarWhen(NOW - 3 * 24 * 60 * MIN, NOW);
check("within a week is a weekday", /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(threeDays), true);
const twelveDays = sidebarWhen(NOW - 12 * 24 * 60 * MIN, NOW);
check("older is day and month", /^\d{1,2} [A-Z][a-z]{2}$/.test(twelveDays), true);

check("slug id is humanised", projectTitle({ id: "bakery-website" }), "Bakery website");
check("task text is shown as written", projectTitle({ task: "Wedding RSVP page", id: "wedding-rsvp" }), "Wedding RSVP page");

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall sidebar group checks passed");
