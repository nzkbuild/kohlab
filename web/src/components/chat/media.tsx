/** Chat media: the sandboxed HTML and diagram frame, project images, and the image viewer. */
import { useContext, useEffect, useMemo, useRef, useState, type Ref } from "react";
import { api } from "../../api";
import { cn } from "../../lib/utils";
import { Button, Dialog } from "../ui";
import { WorkspaceCtx, AgentCtx } from "./contexts";
import { useCopied, CodeBlock } from "./copy";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The app follows the system's light or dark (index.css), so a picture asks for the same. */
const systemScheme = (): "light" | "dark" => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

/** A short id from the block's text. The same block always gets the same id, so its page can be reused; two frames never mix, since messages are also checked against their own window. */
const frameId = (text: string) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/** Where each picture page is kept, by workspace and page. The server keeps a page for an hour from its last use, so an entry is refetched after 50 minutes. */
const pictureUrls = new Map<string, { url: Promise<string>; at: number }>();
function pictureUrl(workspaceId: string, doc: string): Promise<string> {
  const key = `${workspaceId}\n${doc}`;
  const hit = pictureUrls.get(key);
  if (hit && Date.now() - hit.at < 50 * 60 * 1000) return hit.url;
  const url = api.picture(workspaceId, doc).then(
    (r) => r.url,
    (e: unknown) => {
      pictureUrls.delete(key);
      throw e;
    },
  );
  if (pictureUrls.size >= 100) pictureUrls.delete(pictureUrls.keys().next().value as string);
  pictureUrls.set(key, { url, at: Date.now() });
  return url;
}

/** Posts the page's height to the chat as it changes: the body's height plus its margins, so a small page can shrink below the frame. */
const reportHeight = (id: string) =>
  `<script>new ResizeObserver(()=>{var b=document.body,s=getComputedStyle(b);parent.postMessage({kohlabFrame:"${id}",h:b.scrollHeight+parseFloat(s.marginTop)+parseFloat(s.marginBottom)},"*")}).observe(document.body)</script>`;

/** A picture's page: the reply's own HTML, with the height reporter around it. No colour scheme: the page's own styles decide. */
function pictureDoc(code: string, id: string): string {
  const head = `<base target="_blank"><style>body{margin:0;font-family:system-ui,sans-serif}</style>`;
  // A doctype has to stay first, or the browser renders the page in quirks mode.
  const at = /^\s*<!doctype[^>]*>/i.exec(code)?.[0].length ?? 0;
  return code.slice(0, at) + head + code.slice(at) + reportHeight(id);
}

/** A diagram's page: mermaid draws the source. If it cannot, the frame tells the chat, which then shows the code. */
function diagramDoc(code: string, id: string, scheme: string): string {
  const theme = scheme === "dark" ? "dark" : "default";
  return (
    `<!doctype html><html><head><meta name="color-scheme" content="light dark"><base target="_blank">` +
    `<style>html{color-scheme:${scheme}}body{margin:0;font-family:system-ui,sans-serif}.mermaid{display:flex;justify-content:center}</style></head><body>` +
    `<pre class="mermaid">${escapeHtml(code)}</pre>` +
    `<script type="module">try{const m=(await import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs")).default;` +
    `m.initialize({startOnLoad:false,securityLevel:"strict",theme:"${theme}"});await m.run();}` +
    `catch(e){parent.postMessage({kohlabFrame:"${id}",failed:true},"*")}</script>` +
    reportHeight(id) +
    `</body></html>`
  );
}

/** A finished html or mermaid block, drawn live in a sandboxed frame (no same-origin, no top navigation). Its toolbar shows the code, copies it, or opens it full screen. */
export function HtmlFrame({ kind, code }: { kind: "html" | "mermaid"; code: string }) {
  const who = useContext(AgentCtx);
  const workspaceId = useContext(WorkspaceCtx);
  const id = useMemo(() => frameId(kind + code), [kind, code]);
  const [showCode, setShowCode] = useState(false);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(320);
  const [full, setFull] = useState(false);
  const [copied, copy] = useCopied();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const label = kind === "html" ? "Picture" : "Diagram";
  const doc = useMemo(() => {
    const scheme = systemScheme();
    return kind === "html" ? pictureDoc(code, id) : diagramDoc(code, id, scheme);
  }, [kind, code, id]);
  // The page is kept on the server and framed from its own URL: the app's CSP would block its scripts as srcDoc.
  const [src, setSrc] = useState<string | null>(null);
  const [unshown, setUnshown] = useState(false);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    setUnshown(false);
    pictureUrl(workspaceId, doc).then(
      (u) => alive && setSrc(u),
      () => alive && setUnshown(true),
    );
    return () => {
      alive = false;
    };
  }, [workspaceId, doc]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { kohlabFrame?: unknown; h?: unknown; failed?: unknown } | null;
      if (!data || data.kohlabFrame !== id) return;
      if (data.failed === true) setFailed(true);
      else if (typeof data.h === "number") setHeight(Math.min(720, Math.max(120, data.h)));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id]);

  if (failed) {
    return (
      <>
        <p className="text-small text-text-muted">Couldn&apos;t draw this diagram.</p>
        <CodeBlock lang={kind} code={code} />
      </>
    );
  }
  if (unshown) {
    return (
      <>
        <p className="text-small text-text-muted">Couldn&apos;t show this picture.</p>
        <CodeBlock lang={kind} code={code} />
      </>
    );
  }

  // Empty at its height until the page has its URL.
  const frame = (h: number | string, ref?: Ref<HTMLIFrameElement>) =>
    src === null ? (
      <div aria-hidden="true" style={{ height: h }} />
    ) : (
      <iframe
        ref={ref}
        title={kind === "html" ? `Picture from ${who}` : `Diagram from ${who}`}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        src={src}
        referrerPolicy="no-referrer"
        loading="lazy"
        style={{ height: h }}
        className="block w-full border-0"
      />
    );

  return (
    <div className="overflow-hidden rounded-card bg-surface-sunken">
      <div className="flex items-center justify-between gap-3 py-0.5 pr-1 pl-3.5">
        <span className="min-w-0 truncate text-xs text-text-muted">{label}</span>
        <div className="flex shrink-0 items-center">
          <Button variant="quiet" size="sm" className="text-xs text-text-secondary" onClick={() => setShowCode((s) => !s)}>
            {showCode ? "Show picture" : "Show code"}
          </Button>
          <Button variant="quiet" size="sm" className="text-xs text-text-secondary" onClick={() => void copy(code)}>
            {copied ? "Copied" : "Copy"}
          </Button>
          {showCode ? null : (
            <Button variant="quiet" size="sm" className="text-xs text-text-secondary" onClick={() => setFull(true)}>
              Full screen
            </Button>
          )}
        </div>
      </div>
      {showCode ? (
        <pre className="mono overflow-x-auto px-3.5 py-3 text-sm leading-5 text-text-primary">
          <code>{code}</code>
        </pre>
      ) : (
        frame(height, frameRef)
      )}
      <Dialog.Root open={full} onOpenChange={setFull}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content aria-describedby={undefined} className="dialog-content w-[90vw]! max-w-[90vw]! p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <Dialog.Title className="text-sm font-semibold text-text-primary">{label}</Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="quiet" size="sm" className="text-xs text-text-secondary">
                  Close
                </Button>
              </Dialog.Close>
            </div>
            {frame("62vh")}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

const PICTURE_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
]);

/** The picture's MIME type from its extension, or null when it is not a picture file. */
export function pictureType(path: string): string | null {
  const ext = /\.([^./\\]+)$/.exec(path)?.[1].toLowerCase();
  return ext ? (PICTURE_TYPES.get(ext) ?? null) : null;
}

/** The picture fit to the screen, with a Download and a Close. Escape closes it (Radix). */
function ImageViewer({ url, alt, name, open, onOpenChange }: { url: string; alt: string; name: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content aria-describedby={undefined} className="dialog-content flex w-auto! max-w-[92vw]! flex-col items-center gap-3 p-3">
          <Dialog.Title className="sr-only">{alt}</Dialog.Title>
          <img src={url} alt={alt} className="max-h-[60vh] max-w-[92vw] object-contain" />
          <div className="flex w-full items-center justify-end gap-2">
            <a href={url} download={name} className="btn btn-quiet btn-sm text-xs text-text-secondary">
              Download
            </a>
            <Dialog.Close asChild>
              <Button variant="quiet" size="sm" className="text-xs text-text-secondary">
                Close
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A picture from the project, loaded through the API. A thumbnail opens the viewer. */
export function ProjectImage({ path, alt, thumbClass = "max-h-48" }: { path: string; alt: string; thumbClass?: string }) {
  const workspaceId = useContext(WorkspaceCtx);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const name = path.split("/").pop() ?? path;
  const shown = alt || name;

  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    setUrl(null);
    setFailed(false);
    const type = pictureType(path) ?? "application/octet-stream";
    api
      .rawBlob(workspaceId, path)
      .then((blob) => {
        if (cancelled) return;
        made = URL.createObjectURL(new Blob([blob], { type }));
        setUrl(made);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [workspaceId, path]);

  if (failed) return <span className="text-small text-text-muted">Picture not found: {path}</span>;
  if (url === null) return <span aria-hidden="true" className="block h-24 w-40 rounded-card bg-surface-sunken" />;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block max-w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        <img src={url} alt={shown} className={cn("block max-w-full rounded-card object-contain", thumbClass)} />
      </button>
      <ImageViewer url={url} alt={shown} name={name} open={open} onOpenChange={setOpen} />
    </>
  );
}
