import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { Button } from "./ui";
import { cacheTerminal, termCache } from "./terminalCache";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import "@xterm/xterm/css/xterm.css";

interface Props {
  workspaceId: string;
  terminalId: string;
}

/**
 * Socket state as seen by this pane. Explicit and driven by the socket's own
 * lifecycle — never by `navigator.onLine`, which is not a reachability signal.
 */
type SocketState = "connecting" | "live" | "reconnecting" | "offline";

const SOCKET_LABEL: Record<SocketState, string> = {
  connecting: "connecting",
  live: "live",
  reconnecting: "reconnecting",
  offline: "offline",
};

/** Static map: an interpolated class name produces no CSS. */
const SOCKET_CHIP: Record<SocketState, string> = {
  connecting: "chip-stopped",
  live: "chip-running",
  reconnecting: "chip-review",
  offline: "chip-danger",
};

const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 10000;
/** Past this many consecutive failures the pane reports itself offline. */
const OFFLINE_AFTER_ATTEMPTS = 4;

/**
 * Resolve a semantic token to a colour string the terminal can parse.
 *
 * xterm takes JS colour values, and the tokens are OKLCH custom properties — so
 * the browser does the conversion (paint one pixel, read it back) rather than a
 * literal being pasted into this file. Rounded through 8-bit RGB, which is all a
 * terminal palette can express anyway.
 */
function tokenColor(el: HTMLElement, token: string, alpha = 1): string | undefined {
  const raw = getComputedStyle(el).getPropertyValue(token).trim();
  if (!raw) return undefined;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return undefined;
  ctx.fillStyle = raw;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return alpha < 1 ? `rgba(${r}, ${g}, ${b}, ${alpha})` : `rgb(${r}, ${g}, ${b})`;
}

function getTerminal(key: string, el: HTMLElement): { term: Terminal; fit: FitAddon } {
  const cached = termCache.get(key);
  if (cached && cached.term.element) {
    el.appendChild(cached.term.element);
    try {
      cached.fit.fit();
    } catch {
      /* not sized yet */
    }
    return cached;
  }
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
    lineHeight: 1.45,
    rightClickSelectsWord: true,
    scrollback: 10000,
    theme: {
      background: tokenColor(el, "--surface-sunken"),
      foreground: tokenColor(el, "--text-primary"),
      cursor: tokenColor(el, "--accent"),
      selectionBackground: tokenColor(el, "--accent", 0.32),
      // The ANSI palette stays xterm's own: the token set describes product
      // status, not terminal colour codes, and mapping one onto the other would
      // be a lie about what the colours mean.
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new ImageAddon({ sixelSupport: true, iipSupport: true, storageLimit: 64, pixelLimit: 8388608 }));
  term.open(el);
  try {
    fit.fit();
  } catch {
    /* container not sized yet */
  }
  cacheTerminal(key, { term, fit });
  return { term, fit };
}

export default function TerminalView({ workspaceId, terminalId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
  /** Set inside the effect; the reconnect control calls it. */
  const reconnectRef = useRef<() => void>(() => {});
  const [socket, setSocket] = useState<SocketState>("connecting");

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // The effect is re-entered when the workspace/terminal changes while this
    // component instance survives, so the flag is re-armed here rather than once.
    mountedRef.current = true;

    const key = `${workspaceId}:${terminalId}`;
    const { term, fit } = getTerminal(key, el);

    // copy/paste
    const copySel = () => {
      const sel = term.getSelection();
      if (!sel) return false;
      navigator.clipboard.writeText(sel).catch(() => {});
      term.clearSelection();
      return true;
    };
    const sendInput = (value: string) => {
      if (value && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) wsRef.current.send(value);
    };
    const bracketedPaste = (value: string) => `\x1b[200~${value}\x1b[201~`;
    const sendImage = async (image: Blob) => {
      try {
        const uploaded = await api.uploadImage(workspaceId, image);
        sendInput(bracketedPaste(uploaded.path));
      } catch (e) {
        console.error("image upload failed", e);
      }
    };
    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "c") return copySel();
      return true;
    });
    const onPaste = (e: ClipboardEvent) => {
      const imageItem = Array.from(e.clipboardData?.items ?? []).find((item) => item.type.startsWith("image/"));
      const imageFile = imageItem?.getAsFile() ?? Array.from(e.clipboardData?.files ?? []).find((file) => file.type.startsWith("image/"));
      if (imageFile) {
        void sendImage(imageFile);
        e.preventDefault();
        return;
      }
      const txt = e.clipboardData?.getData("text");
      if (txt) {
        sendInput(txt);
        e.preventDefault();
      }
    };
    // Typed input goes out as a bare string — the same frame shape as paste. The
    // subscription is per-mount and must be released, because the terminal it
    // listens on is cached and outlives this effect: without dispose(), every
    // remount would send a keystroke once more.
    const inputSubscription = term.onData(sendInput);
    const onDrop = (e: DragEvent) => {
      const image = Array.from(e.dataTransfer?.files ?? []).find((file) => file.type.startsWith("image/"));
      if (!image) return;
      void sendImage(image);
      e.preventDefault();
    };
    const onDragOver = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.items ?? []).some((item) => item.type.startsWith("image/"))) e.preventDefault();
    };
    document.addEventListener("paste", onPaste);
    el.addEventListener("drop", onDrop);
    el.addEventListener("dragover", onDragOver);

    // websocket to server, with reconnect + backoff
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const urlKey = new URLSearchParams(location.search).get("key") || localStorage.getItem("kohlab_key") || "";
    const wsUrl = `${proto}//${location.host}${urlKey ? `?key=${encodeURIComponent(urlKey)}` : ""}`;

    let attempts = 0;
    /** Inbound bytes land here, never in React state. */
    let pending = "";
    let frame = 0;

    const flush = () => {
      frame = 0;
      if (!pending) return;
      const chunk = pending;
      pending = "";
      term.write(chunk);
    };

    const teardown = () => {
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = null;
        ws.close();
        wsRef.current = null;
      }
    };

    const sendResize = () => {
      try {
        fit.fit();
        const dims = fit.proposeDimensions();
        if (dims && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "resize", id: workspaceId, terminalId, cols: dims.cols, rows: dims.rows }));
        }
      } catch {
        /* ignore */
      }
    };

    const connect = () => {
      if (!mountedRef.current) return;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen = () => {
        attempts = 0; // reset backoff on a successful connect
        setSocket("live");
        ws.send(JSON.stringify({ type: "attach", id: workspaceId, terminalId }));
        sendResize();
      };
      // Coalesced onto rAF: a chatty agent would otherwise write per message and
      // drag the frame budget down with it.
      ws.onmessage = (ev) => {
        pending += ev.data as string;
        if (!frame) frame = requestAnimationFrame(flush);
      };
      ws.onclose = () => {
        if (!mountedRef.current) return;
        // only announce on the first drop; later retries stay silent. Dim, not a
        // colour: the buffer must not carry a palette the tokens do not own.
        if (attempts === 0) term.write("\r\n\x1b[2m[disconnected — retrying]\x1b[22m\r\n");
        wsRef.current = null;
        attempts += 1;
        setSocket(attempts >= OFFLINE_AFTER_ATTEMPTS ? "offline" : "reconnecting");
        const ceiling = Math.min(BASE_RETRY_MS * Math.pow(2, attempts - 1), MAX_RETRY_MS);
        // Half fixed, half random: retries stay prompt, but a server restart
        // does not get every open terminal stampeding back at the same instant.
        const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
        retryRef.current = setTimeout(connect, delay);
      };
    };

    reconnectRef.current = () => {
      window.clearTimeout(retryRef.current);
      attempts = 0;
      teardown();
      setSocket("connecting");
      connect();
    };

    connect();

    window.addEventListener("resize", sendResize);
    // Window resize misses panel-level changes (sidebar collapse, tab switch).
    const observer = new ResizeObserver(sendResize);
    observer.observe(el);
    const t1 = setTimeout(sendResize, 100);
    const t2 = setTimeout(sendResize, 500);

    return () => {
      mountedRef.current = false;
      inputSubscription.dispose();
      window.removeEventListener("resize", sendResize);
      observer.disconnect();
      document.removeEventListener("paste", onPaste);
      el.removeEventListener("drop", onDrop);
      el.removeEventListener("dragover", onDragOver);
      clearTimeout(t1);
      clearTimeout(t2);
      window.clearTimeout(retryRef.current);
      if (frame) cancelAnimationFrame(frame);
      teardown();
    };
  }, [workspaceId, terminalId]);

  const descId = `terminal-desc-${workspaceId}-${terminalId}`;
  const reconnecting = socket === "reconnecting" || socket === "offline";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-8 items-center gap-2 border-b border-line-subtle px-3 text-2xs text-text-muted">
        <span className={cn("chip", SOCKET_CHIP[socket])}>
          <span className="chip-dot" aria-hidden="true" />
          {SOCKET_LABEL[socket]}
        </span>
        <span className="truncate">
          {socket === "live" ? "attached to the agent's pty" : socket === "connecting" ? "opening socket…" : "pty output paused until the socket returns"}
        </span>
        <div className="flex-1" />
        {reconnecting ? (
          <Button variant="quiet" size="sm" onClick={() => reconnectRef.current()} aria-describedby={descId}>
            reconnect now
          </Button>
        ) : null}
      </div>

      {/* Not a live region: a screen reader would read every line the agent
          prints. The connection chip above carries the state that matters. */}
      <div className="min-h-0 flex-1">
        <div
          ref={containerRef}
          data-terminal-root=""
          role="group"
          aria-label={`Terminal ${terminalId} for ${workspaceId}`}
          aria-describedby={descId}
          className="terminal-wrap"
        />
      </div>
      <p id={descId} className="sr-only">
        Interactive terminal. Keystrokes are sent to the agent&apos;s process; output is not announced.
      </p>
    </div>
  );
}
