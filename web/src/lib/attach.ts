/** Names for files the person attaches in chat. Pure, so scripts/check-attach.mjs can test it. */

const MAX_NAME = 80;
const MAX_EXT = 16;

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "text/plain": "txt",
};

/** Splits "a.b.png" into "a.b" and ".png". A dot at the start or a very long tail is not an extension. */
function splitExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || name.length - dot > MAX_EXT) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** A file name safe for the project's uploads folder: basename only, [A-Za-z0-9._-] only, no leading dots, at most 80 characters. */
export function safeAttachName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  if (!clean) return "file";
  const { stem, ext } = splitExt(clean);
  return clean.length > MAX_NAME ? stem.slice(0, MAX_NAME - ext.length) + ext : clean;
}

/** "a.png" with n = 2 becomes "a-2.png". The suffix goes before the extension and the name stays within 80 characters. */
export function withSuffix(name: string, n: number): string {
  const { stem, ext } = splitExt(name);
  const tail = `-${n}${ext}`;
  return stem.slice(0, MAX_NAME - tail.length) + tail;
}

/** A name for a pasted image that came without one: "pasted-<timestamp>.png", with the image type's extension. */
export function pastedName(type: string, now: number): string {
  const sub = type.split("/")[1]?.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const ext = EXT_BY_TYPE[type] ?? (sub || "png");
  return `pasted-${now}.${ext}`;
}

/** Splits a sent message into its text and the names of the files on its last "Attached: " line. */
export function splitAttached(text: string): { body: string; files: string[] } {
  const m = /(^|\n)Attached: ([^\n]*)$/.exec(text);
  if (!m) return { body: text, files: [] };
  const files = m[2].split(", ").filter(Boolean).map((p) => p.split("/").pop() ?? p);
  return { body: text.slice(0, m.index).replace(/\n+$/, ""), files };
}
