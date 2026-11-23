/** A file the AI wrote, shown in the chat: an HTML page in a sandboxed frame, or a picture. Also the path chip in the text that opens one. */
import { useContext, useEffect, useState } from "react";
import { Browser, CaretDown, CaretUp } from "@phosphor-icons/react";
import { api } from "../../api";
import { cn } from "../../lib/utils";
import { openPageInPreview, pageAddress } from "../../lib/previewPages";
import { Button } from "../ui";
import { FileCardsCtx, WorkspaceCtx } from "./contexts";
import { failed } from "./text";
import { pictureType } from "./media";

const PAGE_FILE = /\.html?$/i;
const PICTURE_FILE = /\.(svg|png|jpe?g|gif|webp)$/i;
const PREVIEW_BASE = /^\/p\/[A-Za-z0-9_-]+\/$/;

/** A path relative to the project: no leading slash, no URL scheme, no `..` or dot names, no control characters. Pure. */
export function isSafeRel(path: string): boolean {
  if (path === "" || path.length > 500 || path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  if ([...path].some((ch) => ch.charCodeAt(0) < 32 || ch === "\\" || ch === "\x7f")) return false;
  return path.split("/").every((seg) => seg !== "" && !seg.startsWith("."));
}

/** What a card shows for a path: an HTML page, a picture, or null (not a file the chat shows). Pure. */
export function cardKind(path: string): "page" | "picture" | null {
  if (!isSafeRel(path)) return null;
  if (PAGE_FILE.test(path)) return "page";
  return PICTURE_FILE.test(path) ? "picture" : null;
}

/** A code span the chat draws as a path chip: one relative file name with no spaces. Null for anything else. Pure. */
export const chipPath = (text: string): string | null => (!/\s/.test(text) && cardKind(text) !== null ? text : null);

/** The project's preview address ("/p/<token>/"), kept per project for 50 minutes: the token Preview uses. A failure is not kept. */
const previewBases = new Map<string, { url: Promise<string>; at: number }>();
function previewBase(workspaceId: string): Promise<string> {
  const hit = previewBases.get(workspaceId);
  if (hit && Date.now() - hit.at < 50 * 60 * 1000) return hit.url;
  const url = api
    .preview(workspaceId)
    .then((r) => {
      if (!PREVIEW_BASE.test(r.url)) throw new Error("the preview address is not a page address");
      return r.url;
    })
    .catch((e: unknown) => {
      previewBases.delete(workspaceId);
      throw e;
    });
  previewBases.set(workspaceId, { url, at: Date.now() });
  return url;
}

const GONE = "This file isn't in the project any more.";

/** A line where a card's content would be: one plain sentence, in the card's own width. */
const Line = ({ text }: { text: string }) => <p className="px-3.5 pb-3 text-small text-text-muted">{text}</p>;

/** The page in a sandboxed frame (no same-origin, no top navigation). The box is sized before the frame loads, so nothing moves when it does. */
function PageView({ workspaceId, path, version }: { workspaceId: string; path: string; version: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    setGone(false);
    setErr(null);
    setLoaded(false);
    previewBase(workspaceId)
      .then(async (base) => {
        const url = `${pageAddress(base, path)}?v=${version}`;
        // A page that is no longer in the project answers 404: say so, rather than frame an error page.
        const res = await fetch(url, { method: "HEAD", cache: "no-store", credentials: "omit" });
        if (!alive) return;
        if (res.status === 404) return setGone(true);
        if (!res.ok) throw new Error("the page did not load");
        setSrc(url);
      })
      .catch((e: unknown) => {
        if (alive) setErr(failed("show this page", e));
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, path, version]);

  if (gone) return <Line text={GONE} />;
  if (err !== null) return <Line text={err} />;
  return (
    <div className="relative aspect-[16/10] max-h-[60vh] min-h-70 w-full">
      {src !== null ? (
        <iframe
          title={`Page ${path.split("/").pop() ?? path}`}
          src={src}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          className={cn("absolute inset-0 h-full w-full border-0", !loaded && "invisible")}
        />
      ) : null}
      {!loaded ? <p className="absolute inset-0 grid place-items-center px-3.5 text-small text-text-muted">Loading the page…</p> : null}
    </div>
  );
}

/** A picture from the project, through the authenticated raw route (an img cannot send the key). SVG is only ever an img. */
function PictureView({ workspaceId, path, version, name }: { workspaceId: string; path: string; version: number; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    setUrl(null);
    setGone(false);
    api.rawBlob(workspaceId, path).then(
      (blob) => {
        if (!alive) return;
        made = URL.createObjectURL(new Blob([blob], { type: pictureType(path) ?? "application/octet-stream" }));
        setUrl(made);
      },
      () => {
        if (alive) setGone(true);
      },
    );
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [workspaceId, path, version]);

  if (gone) return <Line text={GONE} />;
  return (
    <div className="relative aspect-[16/10] max-h-[60vh] min-h-70 w-full">
      {url !== null ? (
        <img src={url} alt={name} className="absolute inset-0 h-full w-full object-contain" />
      ) : (
        <p className="absolute inset-0 grid place-items-center px-3.5 text-small text-text-muted">Loading the picture…</p>
      )}
    </div>
  );
}

/**
 * A file the AI wrote, under its tool line. Its header names the file, opens a page in Preview and expands or collapses it.
 * The newest card opens by default; `startOpen` opens one from a path chip. Collapsing unmounts the frame or picture.
 */
export function FileCard({ path, startOpen = false }: { path: string; startOpen?: boolean }) {
  const workspaceId = useContext(WorkspaceCtx);
  const cards = useContext(FileCardsCtx);
  const [userOpen, setUserOpen] = useState<boolean | null>(startOpen ? true : null);
  const kind = cardKind(path);
  if (kind === null) return null;
  const name = path.split("/").pop() ?? path;
  const open = userOpen ?? cards.newest === path;
  const version = cards.edits.get(path) ?? 0;
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-card bg-surface-raised">
      <div className="flex min-w-0 items-center gap-2 py-1.5 pr-1.5 pl-3.5">
        <span className="mono min-w-0 flex-1 truncate text-sm text-text-secondary" title={path}>
          {name}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {kind === "page" ? (
            <Button variant="secondary" size="sm" onClick={() => openPageInPreview(workspaceId, path)}>
              <Browser size={16} aria-hidden="true" />
              Open in Preview
            </Button>
          ) : null}
          <Button variant="quiet" size="sm" aria-expanded={open} className="text-text-secondary" onClick={() => setUserOpen(!open)}>
            {open ? <CaretUp size={16} aria-hidden="true" /> : <CaretDown size={16} aria-hidden="true" />}
            {open ? "Collapse" : "Expand"}
          </Button>
        </div>
      </div>
      {open ? (
        kind === "page" ? (
          <PageView workspaceId={workspaceId} path={path} version={version} />
        ) : (
          <PictureView workspaceId={workspaceId} path={path} version={version} name={name} />
        )
      ) : null}
    </div>
  );
}

/** A path in the text: a quiet chip that shows (or hides) its file card below the paragraph. */
export function PathChip({ path, open, onToggle }: { path: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      title={path}
      className="inline-flex items-center rounded-md bg-surface-sunken px-2 py-0.5 text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary pointer-coarse:min-h-12"
    >
      View {path.split("/").pop() ?? path}
    </button>
  );
}
