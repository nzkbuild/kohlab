#!/usr/bin/env bun
/**
 * Run:  bun scripts/check-status.ts
 *
 * The lifecycle status is derived, pure, and load-bearing: it decides the review
 * queue, the review count in the sidebar and the tab title, the badge on the
 * dashboard, and which tab a row lands in. Nothing else checks it, and it is
 * exactly where a plausible-looking change hides a lie.
 *
 * The case that matters most is discard. A discarded workspace has no commit, so
 * a derivation that only knows about `lastCommitAt` reports it as "needs review"
 * forever: it keeps its place in the queue with an empty diff and nothing left to
 * review. Recording the discard as a commit instead would report rejected work as
 * accepted, which is the other way to be wrong.
 */
import { workspaceStatus, STATUS_ORDER, STATUS_LABEL, type WorkspaceStatus } from "../web/src/lib/status.ts";
import type { Workspace } from "../web/src/types.ts";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name} ${detail}`);
  }
}

/** Only the fields the derivation reads. */
function ws(fields: Partial<Workspace>): Workspace {
  return {
    id: "w",
    repo: "/r",
    task: "t",
    agent: "sh",
    created: 0,
    started: null,
    stopped: null,
    running: false,
    path: "/p",
    ...fields,
  };
}

console.log("kohlab lifecycle status\n");

// Shape of the four original states, unchanged.
check("running wins over everything", workspaceStatus(ws({ running: true, stopped: 1, lastCommitAt: 2 })) === "running");
check("never started and never stopped is stopped", workspaceStatus(ws({})) === "stopped");
check("stopped with no commit needs review", workspaceStatus(ws({ stopped: 10 })) === "needs-review");
check(
  "stopped with an earlier commit needs review",
  workspaceStatus(ws({ stopped: 10, lastCommitAt: 5 })) === "needs-review",
);
check(
  "stopped with a later commit is committed",
  workspaceStatus(ws({ stopped: 10, lastCommitAt: 20 })) === "committed",
);

// The discard cases, which is why this file exists.
check(
  "stopped, then discarded, is discarded and not needs-review",
  workspaceStatus(ws({ stopped: 10, discardedAt: 20 })) === "discarded",
);
check(
  "a discard at the same instant as the stop still counts",
  workspaceStatus(ws({ stopped: 10, discardedAt: 10 })) === "discarded",
);
check(
  "discarded then run again and stopped returns to the review queue",
  workspaceStatus(ws({ stopped: 30, discardedAt: 20 })) === "needs-review",
);
check(
  "discarded, then committed later, reports committed",
  workspaceStatus(ws({ stopped: 10, discardedAt: 20, lastCommitAt: 30 })) === "committed",
);
check(
  "committed, then discarded later, reports discarded",
  workspaceStatus(ws({ stopped: 10, lastCommitAt: 20, discardedAt: 30 })) === "discarded",
);
check(
  "discarded, then run again, then committed reports committed",
  workspaceStatus(ws({ stopped: 40, discardedAt: 20, lastCommitAt: 50 })) === "committed",
);

// Every status must be renderable: the maps are what the UI reads, and a key
// missing from one of them is a blank chip rather than a type error at the call
// site.
const ALL: WorkspaceStatus[] = ["running", "needs-review", "committed", "discarded", "stopped"];
check("every status has a label", ALL.every((s) => typeof STATUS_LABEL[s] === "string" && STATUS_LABEL[s].length > 0));
check("every status has a sort weight", ALL.every((s) => Number.isFinite(STATUS_ORDER[s])));
check(
  "review sorts first and discarded last",
  ALL.every((s) => s === "needs-review" || STATUS_ORDER[s] >= STATUS_ORDER["needs-review"]) &&
    ALL.every((s) => s === "discarded" || STATUS_ORDER[s] <= STATUS_ORDER["discarded"]),
);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
