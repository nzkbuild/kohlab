/**
 * Pictures drawn in chat (html and mermaid blocks). The chat cannot hand a page to
 * its iframe as srcDoc: the app's CSP would block the page's scripts. So the page is
 * kept here for an hour and served from its own route with its own CSP (see server.ts).
 * The random token in the URL is the only credential a picture needs.
 */
import { createHash, randomBytes } from "crypto";

export const PICTURE_MAX_BYTES = 256 * 1024;
const TTL_MS = 60 * 60 * 1000;
// ponytail: at most 200 pages in memory, oldest dropped first. Plenty for one chat; a disk cache is the upgrade if pictures must outlive a restart.
const MAX_ENTRIES = 200;

interface Entry {
  html: string;
  at: number;
  hash: string;
}

/** Insertion order is age order: a reused picture moves to the end, so the front is always the oldest. */
const byToken = new Map<string, Entry>();
const tokenByHash = new Map<string, string>();

function drop(token: string) {
  const e = byToken.get(token);
  if (!e) return;
  byToken.delete(token);
  if (tokenByHash.get(e.hash) === token) tokenByHash.delete(e.hash);
}

function sweep(now: number) {
  for (const [token, e] of byToken) {
    if (now - e.at <= TTL_MS) break;
    drop(token);
  }
  while (byToken.size > MAX_ENTRIES) drop(byToken.keys().next().value as string);
}

/** Keeps a page and returns its token. The same page gets the same token while it is kept. */
export function mintPicture(html: string): string {
  const now = Date.now();
  sweep(now);
  const hash = createHash("sha256").update(html).digest("base64url");
  const have = tokenByHash.get(hash);
  if (have !== undefined && byToken.has(have)) {
    const e = byToken.get(have) as Entry;
    byToken.delete(have);
    byToken.set(have, { ...e, at: now });
    return have;
  }
  const token = randomBytes(18).toString("base64url");
  byToken.set(token, { html, at: now, hash });
  tokenByHash.set(hash, token);
  sweep(now);
  return token;
}

/** The page for a token, or null when there is none or it has expired. */
export function pictureHtml(token: string): string | null {
  const e = byToken.get(token);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) {
    drop(token);
    return null;
  }
  return e.html;
}
