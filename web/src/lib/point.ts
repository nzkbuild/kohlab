/**
 * "Point at something": the words a pointed-at element becomes in the message, and
 * how the sent message is taken apart again. Pure, so scripts/check-point-text.mjs
 * can test it. Every field is cleaned here, because page text is not trusted.
 */
import type { Pick } from "../types";

/** The start of every pointed-at line. Also how a sent message is told apart from its text. */
export const POINTED_PREFIX = "Pointed at: ";

/** The most things one message can point at. */
export const MAX_POINTS = 3;

const LABELS: Record<string, string> = {
  h1: "The heading",
  h2: "The heading",
  h3: "The heading",
  h4: "The heading",
  h5: "The heading",
  h6: "The heading",
  p: "The text",
  a: "The link",
  button: "The button",
  img: "The picture",
  nav: "The menu",
  footer: "The bottom of the page",
  li: "The list item",
  input: "The field",
};

/** One line, no backticks: nothing from the page can open a fence or a new line in the message. */
const clean = (s: string) => s.replace(/[\r\n`]+/g, " ").replace(/\s+/g, " ").trim();

/** What the element is, in plain English, with its text (at most 40 characters) in curly quotes. */
export function pointLabel(tag: string, text: string): string {
  const base = LABELS[clean(tag).toLowerCase()] ?? "This part";
  const words = clean(text).slice(0, 40).trim();
  return words ? `${base} “${words}”` : base;
}

/** The line that goes into the message for one pointed-at element. */
export function pointLine(pick: Pick): string {
  const id = pick.id ? `#${clean(pick.id)}` : "";
  const classes = pick.classes.map((c) => `.${clean(c)}`).join("");
  const at = `${Math.round(pick.box.x)},${Math.round(pick.box.y)} size ${Math.round(pick.box.width)}×${Math.round(pick.box.height)}`;
  return `${POINTED_PREFIX}${pointLabel(pick.tag, pick.text)} (${clean(pick.tag)}${id}${classes}, selector \`${clean(pick.selector)}\`, at ${at} on ${clean(pick.page)})`;
}

/** The text a point chip shows: the plain label ("The heading “Bean”"), without the prefix or the technical part for the AI. */
export function pointChipText(line: string): string {
  const rest = line.startsWith(POINTED_PREFIX) ? line.slice(POINTED_PREFIX.length) : line;
  const tech = rest.search(/ \([a-z][a-z0-9-]*[^ ,]*, selector /);
  return tech > 0 ? rest.slice(0, tech) : rest;
}

/** The pointed-at lines at the end of a message's text, and the text before them. */
export function splitPointed(text: string): { body: string; points: string[] } {
  const lines = text.split("\n");
  let i = lines.length;
  while (i > 0 && (lines[i - 1] ?? "").startsWith(POINTED_PREFIX)) i--;
  if (i === lines.length) return { body: text, points: [] };
  return { body: lines.slice(0, i).join("\n").replace(/\n+$/, ""), points: lines.slice(i) };
}

/**
 * The message as it is sent: the person's text, then the pointed-at lines, then the
 * "Attached: " line that splitAttached reads back.
 */
export function composeSent(text: string, points: readonly string[], attached: readonly string[]): string {
  const head = [text, points.join("\n")].filter((part) => part !== "").join("\n\n");
  if (attached.length === 0) return head;
  const line = `Attached: ${attached.join(", ")}`;
  return head ? `${head}\n\n${line}` : line;
}
