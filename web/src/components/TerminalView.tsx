import { useEffect, useRef } from "react";
import { api } from "../api";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import "@xterm/xterm/css/xterm.css";

interface Props {
  workspaceId: string;
  terminalId: string;
}

// xterm instances persist across tab switches / view remounts so scrollback
// survives. Each mount re-attaches to the cached terminal and re-subscribes.
// The cache is bounded: oldest terminals are disposed when it exceeds the cap.
const termCache = new Map<string, { term: Terminal; fit: FitAddon }>();
const MAX_CACHED_TERMINALS = 32;

/** Dispose + drop cached terminals for a workspace (call on workspace delete). */
export function disposeWorkspaceTerminals(workspaceId: string) {
  for (const [key, { term }] of termCache) {
    if (key.startsWith(`${workspaceId}:`)) {
      term.dispose();
      termCache.delete(key);
    }
  }
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
      background: "#05070b",
      foreground: "#d7e0ee",
      cursor: "#34d399",
      selectionBackground: "rgba(52, 211, 153, 0.3)",
      black: "#05070b",
      brightBlack: "#4a5568",
      red: "#f87171",
      green: "#34d399",
      yellow: "#fbbf24",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#22d3ee",
      white: "#d7e0ee",
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
  termCache.set(key, { term, fit });
  // bound the cache: evict the oldest (Map iterates in insertion order)
  if (termCache.size > MAX_CACHED_TERMINALS) {
    const oldest = termCache.keys().next().value;
    if (oldest !== undefined) {
      const entry = termCache.get(oldest);
      entry?.term.dispose();
      termCache.delete(oldest);
    }
  }
  return { term, fit };
}

export default function TerminalView({ workspaceId, terminalId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

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
    const MAX_RETRY_MS = 10000;

    const teardown = () => {
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = null;
        ws.close();
        wsRef.current = null;
      }
    };

    const connect = () => {
      if (!mountedRef.current) return;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "attach", id: workspaceId, terminalId }));
        sendResize();
      };
      ws.onmessage = (ev) => term.write(ev.data as string);
      ws.onclose = () => {
        if (!mountedRef.current) return;
        term.write("\r\n\x1b[90m[disconnected — retrying]\x1b[0m\r\n");
        wsRef.current = null;
        retryRef.current = setTimeout(connect, Math.min(500 * (attemptRef.current++), MAX_RETRY_MS));
      };
    };

    const attemptRef = { current: 0 };
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
    connect();

    const onResize = () => sendResize();
    const t1 = setTimeout(onResize, 100);
    const t2 = setTimeout(onResize, 500);

    return () => {
      mountedRef.current = false;
      window.removeEventListener("resize", onResize);
      document.removeEventListener("paste", onPaste);
      el.removeEventListener("drop", onDrop);
      el.removeEventListener("dragover", onDragOver);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(retryRef.current);
      teardown();
    };
  }, [workspaceId, terminalId]);

  return <div ref={containerRef} className="terminal-wrap h-full w-full bg-[#05070b] p-2.5" />;
}
