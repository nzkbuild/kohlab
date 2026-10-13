/**
 * Claude's replies, parsed into plain data. Nothing here produces HTML: the chat
 * turns these nodes into React elements, so a reply cannot inject markup.
 *
 * Deliberately small: fenced code, headings, rules, bullets, numbers, paragraphs,
 * **bold**, `code`, [text](url) and bare http(s) URLs. Anything else stays text.
 */

export type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; text: string }
  | { kind: "hr" }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "code"; lang: string; code: string };

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; text: string };

const OPEN_FENCE = /^\s{0,3}```\s*([^\s`]*)/;
const CLOSE_FENCE = /^\s{0,3}```\s*$/;
const HEADING = /^\s{0,3}#{1,3}\s+(\S.*)$/;
const RULE = /^\s*-{3,}\s*$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBER = /^\s*\d+\.\s+(.*)$/;

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
    const heading = HEADING.exec(line);
    if (heading) {
      para = null;
      blocks.push({ kind: "h", text: heading[1].trim() });
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
      const item = (bullet ?? number)?.[1] ?? "";
      const last = blocks[blocks.length - 1];
      if (last && (last.kind === "ul" || last.kind === "ol") && last.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
    } else if (line.trim() === "") {
      para = null;
    } else if (para) {
      para.push(line);
    } else {
      para = [line];
      blocks.push({ kind: "p", lines: para });
    }
  }
  return blocks;
}

// One pass, left to right: code wins over everything, so a link inside backticks stays code.
const TOKEN = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"`]+)/g;

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
    const [raw, code, bold, label, href, bare] = m;
    pushText(text.slice(at, start));
    at = start + raw.length;
    if (code !== undefined) out.push({ kind: "code", text: code });
    else if (bold !== undefined) out.push({ kind: "strong", children: inline(bold) });
    else if (label !== undefined) {
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
