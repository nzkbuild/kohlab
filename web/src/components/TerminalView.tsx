import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import "@xterm/xterm/css/xterm.css";


interface Props {
  workspaceId: string;
  terminalId: string;
}

export default function TerminalView({ workspaceId, terminalId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
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
    term.open(containerRef.current);
    try {
      fit.fit();
    } catch {
      /* container not sized yet */
    }
    termRef.current = term;

    // copy/paste
    const copySel = () => {
      const sel = term.getSelection();
      if (!sel) return false;
      navigator.clipboard.writeText(sel).catch(() => {});
      term.clearSelection();
      return true;
    };
    const paste = () => {
      navigator.clipboard.readText().then((txt) => {
        if (txt && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) wsRef.current.send(txt);
      }).catch(() => {});
    };
    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "c") return copySel();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "v") { paste(); return false; }
      return true;
    });
    const onPaste = (e: ClipboardEvent) => {
      const txt = e.clipboardData?.getData("text");
      if (txt && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(txt);
        e.preventDefault();
      }
    };
    document.addEventListener("paste", onPaste);

    // websocket to server
    const proto = location.protocol === "https:" ? "wss:" : "ws:";

    const urlKey = new URLSearchParams(location.search).get("key") || localStorage.getItem("kohlab_key") || "";
    const ws = new WebSocket(`${proto}//${location.host}${urlKey ? `?key=${encodeURIComponent(urlKey)}` : ""}`);
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "attach", id: workspaceId, terminalId }));
      try {
        const dims = fit.proposeDimensions();
        if (dims) ws.send(JSON.stringify({ type: "resize", id: workspaceId, terminalId, cols: dims.cols, rows: dims.rows }));
      } catch {
        /* ignore */
      }
    };
    ws.onmessage = (ev) => term.write(ev.data as string);
    ws.onclose = () => term.write("\r\n\x1b[90m[disconnected]\x1b[0m\r\n");
    term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(d);
    });

    const onResize = () => {
      try {
        fit.fit();
        const dims = fit.proposeDimensions();
        if (dims && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", id: workspaceId, terminalId, cols: dims.cols, rows: dims.rows }));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", onResize);
    setTimeout(onResize, 100);
    setTimeout(onResize, 500);

    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("paste", onPaste);
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
  }, [workspaceId, terminalId]);

  return <div ref={containerRef} className="terminal-wrap h-full w-full bg-[#05070b] p-2.5" />;
}
