#!/usr/bin/env bun
// S2 (agent-browser 0.39.1): `--json eval -b <base64>` answers data.result with the snippet's value (a JSON string here), in the active tab's main frame; elementFromPoint takes the same CSS pixels as getBoundingClientRect after `set viewport`.
// S2: a throwing snippet answers success:false with "Evaluation error: ..."; the server reads only data.result and refuses the pick when it is not a string.
/**
 * Point: the page's answer is re-checked before the chat sees it (lengths, types,
 * newlines, a path that is not a path, __proto__), and a pick is refused when no
 * browser runs on the workspace's own page.
 *
 * Run: bun scripts/check-pick.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "kohlab-pick-"));
process.env.WORKS_DIR = tmp;
process.env.PTY_SOCKET = join(tmp, "pty.sock");
process.env.KOHLAB_KEY = "pick-check-key";
const { checkPick, pickElement } = await import("../browser.ts");

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`);
}

const ws = { id: "pick-ws", repo: "", task: "t", agent: "sh", created: 0, started: null, stopped: null, dir: tmp };
const good = {
  tag: "button",
  text: "Go\nnow",
  id: "buy",
  classes: ["a", "b", 7, "c".repeat(60)],
  selector: "#buy",
  box: { x: 8.4, y: 80.9, width: 33, height: 21 },
  page: "/shop/",
  viewport: { width: 800, height: 600 },
};
const parse = (o) => checkPick(ws, typeof o === "string" ? o : JSON.stringify(o));

const ok = parse(good);
check("a good pick comes back", ok !== null && ok.tag === "button" && ok.selector === "#buy");
check("newlines in text collapse to one line", ok?.text === "Go now", JSON.stringify(ok?.text));
check("classes: non-strings dropped, each at most 40", ok?.classes.length === 3 && ok.classes.every((c) => c.length <= 40), JSON.stringify(ok?.classes));
check("box rounded to whole pixels", ok?.box.x === 8 && ok.box.y === 81, JSON.stringify(ok?.box));
check("not JSON is refused", parse("{nope") === null);
check("a null answer is refused", parse("null") === null);
check("wrong tag type is refused", parse({ ...good, tag: 5 }) === null);
check("tag with odd characters is refused", parse({ ...good, tag: "a b" }) === null);
check("page that is a full URL is refused", parse({ ...good, page: "https://evil.example/x" }) === null);
check("missing box is refused", parse({ ...good, box: undefined }) === null);
check("non-number box value is refused", parse({ ...good, box: { x: "1", y: 1, width: 1, height: 1 } }) === null);
check("oversize text is cut to 80", parse({ ...good, text: "x".repeat(500) })?.text.length === 80);
check("oversize selector is cut to 300", parse({ ...good, selector: "y".repeat(900) })?.selector.length === 300);
check("oversize page is cut to 200", parse({ ...good, page: "/" + "p".repeat(900) })?.page.length === 200);
check("a huge box is clamped", parse({ ...good, box: { x: 1e9, y: -5, width: 1, height: 1 } })?.box.x === 10000);
const proto = parse('{"__proto__":{"polluted":true},"tag":"p","text":"","selector":"p","box":{"x":0,"y":0,"width":1,"height":1},"page":"/","viewport":{"width":1,"height":1}}');
check("__proto__ in the answer does not reach the object", proto !== null && proto.polluted === undefined && ({}).polluted === undefined);
const shared = checkPick({ ...ws, shareLink: { token: "sharetok-x", expires: null } }, JSON.stringify({ ...good, page: "/p/sharetok-x/" }));
check("a share token in the page path is hidden", shared !== null && !shared.page.includes("sharetok-x"), JSON.stringify(shared?.page));
check("the preview token is dropped from the page path", parse({ ...good, page: "/p/AbCdEfGhIjKlMnOpQrStUvWxYz012345/docs/a.html" })?.page === "/docs/a.html");

// Refused without a running browser, before anything is started: the same answer for any coordinates.
for (const [x, y] of [[10, 20], [-5, 99999]]) {
  try {
    await pickElement(ws, x, y);
    check("pick with no browser is refused", false);
  } catch (e) {
    check("pick with no browser is refused (400)", e.status === 400 && /own page/.test(e.message), `${e.status} ${e.message}`);
  }
}

rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall pick checks passed");
