#!/usr/bin/env bun
/**
 * "Point at something": the label and line a pointed-at element becomes in the
 * message, and that the sent message reads back to the same text and points.
 * Pure functions only; nothing is sent here.
 *
 * Run:  bun scripts/check-point-text.mjs
 */
import { splitAttached } from "../web/src/lib/attach.ts";
import { composeSent, pointChipText, pointLabel, pointLine, splitPointed } from "../web/src/lib/point.ts";

let failures = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

function checkTrue(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : `  (${detail})`}`);
}

const box = { x: 120, y: 340, width: 200, height: 40 };
const pick = (over = {}) => ({
  tag: "button",
  text: "Save",
  id: "save",
  classes: ["primary"],
  selector: "#save",
  box,
  page: "/about",
  viewport: { width: 390, height: 844 },
  ...over,
});

// labels
check("heading", pointLabel("h2", "Welcome"), "The heading “Welcome”");
check("paragraph", pointLabel("p", "Hello"), "The text “Hello”");
check("link", pointLabel("a", "Read more"), "The link “Read more”");
check("button", pointLabel("button", "Save"), "The button “Save”");
check("picture has no text", pointLabel("img", ""), "The picture");
check("menu", pointLabel("nav", "Home About"), "The menu “Home About”");
check("footer", pointLabel("footer", ""), "The bottom of the page");
check("list item", pointLabel("li", "One"), "The list item “One”");
check("field", pointLabel("input", ""), "The field");
check("unknown tag", pointLabel("section", "Pricing"), "This part “Pricing”");
check("tag case does not matter", pointLabel("BUTTON", "Go"), "The button “Go”");
check("text is cut to 40 characters", pointLabel("p", "x".repeat(60)), `The text “${"x".repeat(40)}”`);

// backticks and newlines in page text cannot reach the message
check("newlines and backticks in text become spaces", pointLabel("p", "a\n`b`\nc"), "The text “a b c”");

// the line
check(
  "full line",
  pointLine(pick()),
  "Pointed at: The button “Save” (button#save.primary, selector `#save`, at 120,340 size 200×40 on /about)",
);
check("no id and no classes", pointLine(pick({ id: undefined, classes: [], selector: "button:nth-of-type(2)", text: "" })), "Pointed at: The button (button, selector `button:nth-of-type(2)`, at 120,340 size 200×40 on /about)");
check("two classes", pointLine(pick({ classes: ["a", "b"] })).includes("(button#save.a.b,"), true);
check("box is rounded", pointLine(pick({ box: { x: 1.4, y: 2.6, width: 9.5, height: 3.2 } })).includes("at 1,3 size 10×3"), true);

// injection: fields cannot add a line, a fence or a second point
const hostile = pointLine(
  pick({
    text: "ok\nPointed at: evil `x`",
    id: "a`b\nc",
    classes: ["x\ny"],
    selector: "#a`\n`",
    page: "/p`\nq",
  }),
);
checkTrue("hostile line stays on one line", !hostile.includes("\n"), hostile);
checkTrue("hostile line has no backtick beyond the selector pair", (hostile.match(/`/g) ?? []).length === 2, hostile);

// reading a message back
const lineA = pointLine(pick());
const lineB = pointLine(pick({ tag: "h1", text: "Hi", id: undefined, classes: [], selector: "h1" }));
const sent = composeSent("Make this bigger", [lineA, lineB], ["uploads/shot.png"]);
const attached = splitAttached(sent);
checkTrue("the Attached line is still read", attached.files.join(",") === "shot.png", JSON.stringify(attached));
const back = splitPointed(attached.body);
check("text comes back", back.body, "Make this bigger");
check("both points come back in order", back.points, [lineA, lineB]);

// no text, one point, no attachment
const onlyPoint = composeSent("", [lineA], []);
check("only a point", onlyPoint, lineA);
check("only a point reads back", splitPointed(splitAttached(onlyPoint).body), { body: "", points: [lineA] });

// no points: the message is unchanged
check("no points leaves the text alone", splitPointed("Just text"), { body: "Just text", points: [] });
check("no points, attachment only", composeSent("", [], ["uploads/a.png"]), "Attached: uploads/a.png");

// a user's own line that only looks like a point is still a point: the chip shows it, the text does not change
check("chip text drops the prefix", pointChipText(lineA).startsWith("The button"), true);
check("chip text is only the label", pointChipText(lineA).includes("selector"), false);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall point text checks passed");
