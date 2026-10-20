/**
 * Claude's replies, parsed into plain data. Nothing here produces HTML: the chat
 * turns these nodes into React elements, so a reply cannot inject markup.
 *
 * Deliberately small: fenced code, headings (# to ######), rules, quotes, bullets and numbers
 * (nested by indent), pipe tables, paragraphs, **bold**, *italic*, _italic_, ~~strikethrough~~,
 * `code`, [text](url), ![alt](picture.png) and bare http(s) URLs.
 * A picture is only a picture when its path is inside the project (no scheme, no "..");
 * anything else stays text, and an http(s) picture becomes a plain link. Anything else stays text.
 */

export type Block =
  | { kind: "p"; lines: string[] }
  /** A heading of level 1 to 3. */
  | { kind: "h"; text: string }
  /** A heading of level 4 to 6: drawn like "h", smaller. */
  | { kind: "subh"; text: string }
  | { kind: "hr" }
  | { kind: "quote"; lines: string[] }
  /** `levels[i]` is how deep item i is nested (0 = top). Left out when every item is top-level. */
  | { kind: "ul" | "ol"; items: string[]; levels?: number[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "code"; lang: string; code: string };

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "del"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; text: string }
  | { kind: "image"; src: string; alt: string };

const OPEN_FENCE = /^\s{0,3}```\s*([^\s`]*)/;
const CLOSE_FENCE = /^\s{0,3}```\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(\S.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s*-{3,}\s*$/;
const BULLET = /^([ \t]*)[-*]\s+(.*)$/;
const NUMBER = /^([ \t]*)\d+\.\s+(.*)$/;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
const DELIMITER_ONE = /^\s*\|\s*:?-+:?\s*\|\s*$/;

/** Table cells of one row. Pipes inside `code` and escaped \| stay in the cell. Alignment colons are ignored. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode && s[k - 1] !== "\\") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.map((c) => c.replace(/\\\|/g, "|"));
}

/** The width of a list item's indent: a space is 1, a tab is 2. Two of them make one level of nesting. */
const indentWidth = (indent: string) => [...indent].reduce((w, c) => w + (c === "\t" ? 2 : 1), 0);

/** Blocks in reading order. An unclosed fence (a reply still streaming) runs to the end of the text. */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let para: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = OPEN_FENCE.exec(line);
    if (open) {
      para = null;
      const code: string[] = [];
      let j = i + 1;
      while (j < lines.length && !CLOSE_FENCE.test(lines[j])) code.push(lines[j++]);
      blocks.push({ kind: "code", lang: open[1], code: code.join("\n") });
      i = j; // on the closing fence; the loop step moves past it
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      para = null;
      // Consecutive "> " lines are one quote; a quote after a blank line starts a new one.
      const last = blocks[blocks.length - 1];
      if (i > 0 && QUOTE.test(lines[i - 1]) && last?.kind === "quote") last.lines.push(quote[1]);
      else blocks.push({ kind: "quote", lines: [quote[1]] });
      continue;
    }
    const next = lines[i + 1];
    if (line.includes("|") && next !== undefined && (DELIMITER.test(next) || DELIMITER_ONE.test(next))) {
      para = null;
      const head = cells(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
        const r = cells(lines[j++]);
        rows.push(Array.from({ length: head.length }, (_, c) => r[c] ?? ""));
      }
      blocks.push({ kind: "table", head, rows });
      i = j - 1; // on the last table row; the loop step moves past it
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      para = null;
      const text = heading[2].trim();
      blocks.push(heading[1].length <= 3 ? { kind: "h", text } : { kind: "subh", text });
      continue;
    }
    if (RULE.test(line)) {
      para = null;
      blocks.push({ kind: "hr" });
      continue;
    }
    const bullet = BULLET.exec(line);
    const number = NUMBER.exec(line);
    if (bullet || number) {
      para = null;
      const kind = bullet ? "ul" : "ol";
      const m = (bullet ?? number) as RegExpExecArray;
      const last = blocks[blocks.length - 1];
      if (last && (last.kind === "ul" || last.kind === "ol") && last.kind === kind) {
        // One level deeper than the item above at most; a list cannot start two levels in.
        const above = last.levels?.[last.items.length - 1] ?? 0;
        last.levels?.push(Math.min(Math.floor(indentWidth(m[1]) / 2), above + 1));
        last.items.push(m[2]);
      } else blocks.push({ kind, items: [m[2]], levels: [0] });
    } else if (line.trim() === "") {
      para = null;
    } else if (para) {
      para.push(line);
    } else {
      para = [line];
      blocks.push({ kind: "p", lines: para });
    }
  }
  // A list with no nesting keeps the plain shape: no "levels" key.
  for (const b of blocks) if ((b.kind === "ul" || b.kind === "ol") && b.levels?.every((l) => l === 0)) delete b.levels;
  return blocks;
}

// One pass, left to right: code wins over everything, so a link inside backticks stays code.
// The picture alternative sits before the link one, so "![a](b.png)" is not read as "!" plus a link.
// "*" and "_" emphasis need a non-space at each end; "_" also needs a non-word character around it, so snake_case stays.
const TOKEN =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*(?=\S)([^*\n]*\S)\*|(?<!\w)_(?=\S)([^_\n]*\S)_(?!\w)|~~(?=\S)([^~\n]*\S)~~|!\[([^\]\n]*)\]\(([^)\s]+)\)|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"`]+)/g;

const PICTURE = /\.(png|jpe?g|gif|webp|svg)$/i;

/** A picture path the app may load: inside the project, a picture file. Checked decoded too, so "%2e%2e" is no escape. */
function safePicture(src: string): boolean {
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    return false;
  }
  for (const p of [src, decoded]) {
    if (p.includes(":") || /^[\\/]/.test(p) || p.split(/[\\/]/).includes("..") || !PICTURE.test(p)) return false;
  }
  return true;
}

const count = (s: string, ch: string) => s.split(ch).length - 1;

/** A bare URL keeps its own closing punctuation out of the link: "see https://a.b." links "https://a.b". */
function trimUrl(url: string): string {
  let u = url;
  while (u.length > 0) {
    const last = u.slice(-1);
    const opener = last === ")" ? "(" : last === "]" ? "[" : null;
    const trailing = ".,;:!?".includes(last) || (opener !== null && count(u, last) > count(u, opener));
    if (!trailing) break;
    u = u.slice(0, -1);
  }
  return u;
}

/** Only http and https become links. javascript:, data: and anything else are refused. */
function safeHref(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** The inline pieces of one line or paragraph, in order. */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  const pushText = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += t;
    else out.push({ kind: "text", text: t });
  };
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    const [raw, code, bold, emStar, emUnder, strike, alt, src, label, href, bare] = m;
    pushText(text.slice(at, start));
    at = start + raw.length;
    if (code !== undefined) out.push({ kind: "code", text: code });
    else if (bold !== undefined) out.push({ kind: "strong", children: inline(bold) });
    else if (emStar !== undefined) out.push({ kind: "em", children: inline(emStar) });
    else if (emUnder !== undefined) out.push({ kind: "em", children: inline(emUnder) });
    else if (strike !== undefined) out.push({ kind: "del", children: inline(strike) });
    else if (alt !== undefined) {
      if (safeHref(src)) out.push({ kind: "link", href: src, text: alt || src });
      else if (safePicture(src)) out.push({ kind: "image", src, alt });
      else pushText(raw);
    } else if (label !== undefined) {
      if (safeHref(href)) out.push({ kind: "link", href, text: label });
      else pushText(raw);
    } else if (bare !== undefined) {
      const url = trimUrl(bare);
      if (safeHref(url)) {
        out.push({ kind: "link", href: url, text: url });
        pushText(bare.slice(url.length));
      } else pushText(bare);
    }
  }
  pushText(text.slice(at));
  return out;
}
