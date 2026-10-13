#!/usr/bin/env bun
/**
 * Sidebar grouping: which group a project lands in, the time a row shows, the
 * newest-first order inside a group, and the compact row time. The sidebar
 * groups are the owner's only view of what needs them, so a wrong bucket here
 * hides a question behind "Earlier".
 *
 * Run:  bun scripts/check-sidebar-groups.mjs
 */
import { sidebarGroup, sidebarTime, bySidebarActivity } from "../web/src/lib/status.ts";
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

check("waiting wins over running", sidebarGroup({ ...base, running: true, started: 5, waiting: true }), "needs");
check("running is working", sidebarGroup({ ...base, running: true, started: 5 }), "working");
check("stopped with changes is ready to check", sidebarGroup({ ...base, started: 5, stopped: 9 }), "review");
check("committed is earlier", sidebarGroup({ ...base, started: 5, stopped: 9, lastCommitAt: 10 }), "earlier");
check("stopped clean is earlier", sidebarGroup({ ...base, started: 5, stopped: 9, stoppedClean: true }), "earlier");
check("discarded is earlier", sidebarGroup({ ...base, started: 5, stopped: 9, discardedAt: 10 }), "earlier");
check("never run is earlier", sidebarGroup({ ...base }), "earlier");

check("needs-you time is started", sidebarTime({ ...base, running: true, started: 5, stopped: 3, waiting: true }), 5);
check("review time is stopped", sidebarTime({ ...base, started: 5, stopped: 9 }), 9);
check("earlier time is stopped", sidebarTime({ ...base, started: 5, stopped: 9, lastCommitAt: 10 }), 9);
check("never-run time falls back to created", sidebarTime({ ...base }), 1);

const older = { ...base, id: "a", started: 2, stopped: 4 };
const newer = { ...base, id: "b", started: 2, stopped: 8 };
check("newest activity first", [older, newer].sort(bySidebarActivity).map((w) => w.id), ["b", "a"]);

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
