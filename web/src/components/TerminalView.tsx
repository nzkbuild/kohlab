import { useEffect, useRef, useState } from "react";
import { api, socketProtocol } from "../api";
import { cn } from "../lib/utils";
import { Button } from "./ui";
import { Copy, Monitor, Paperclip } from "@phosphor-icons/react";
import { cacheTerminal, termCache } from "./terminalCache";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import "@xterm/xterm/css/xterm.css";
import { monoFont, tokenColor } from "../lib/tokenColor";
import { copyText } from "../lib/clipboard";
import { announce } from "../lib/announce";
import { toast } from "sonner";

interface Props {
  workspaceId: string;
  terminalId: string;
  /** Called when the session's process ends (the server prints "[process exited]"). */
  onExit?: () => void;
}

/**
 * Socket state as seen by this pane. Explicit and driven by the socket's own
 * lifecycle: never by `navigator.onLine`, which is not a reachability signal.
 */
type SocketState = "connecting" | "live" | "reconnecting" | "offline";

const SOCKET_LABEL: Record<SocketState, string> = {
  connecting: "connecting",
  live: "connected",
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

/** Copy and say so: a silent copy reads as a broken one. */
function copyWithFeedback(text: string, what = "copied"): Promise<void> {
  if (!text) return Promise.resolve();
  const n = text.length;
  return copyText(text).then(
    () => {
      toast.success(`${what}, ${n} character${n === 1 ? "" : "s"}`);
      announce(what);
    },
    () => {
      toast.error("could not copy, select the text and use the browser's copy menu");
    },
  );
}

/** What is on screen now, as plain text: the touch-friendly way out. */
function screenText(term: Terminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) {
    lines.push(buf.getLine(y)?.translateToString(true) ?? "");
  }
  return lines.join("\n").replace(/\s+$/, "");
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
    fontFamily: monoFont(el),
    // A phone fits ~38 columns at the desktop size, too few for an agent's TUI.
    ...(window.matchMedia("(max-width: 40rem)").matches ? { fontSize: 12 } : {}),
    lineHeight: 1.45,
    // Agent TUIs turn on mouse tracking, which swallows a plain drag. Shift+drag
    // still selects everywhere; on macOS the convention is Option+click.
    macOptionClickForcesSelection: true,
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
  // xterm measures the cell from the font that is loaded at open time. Geist
  // Mono is a webfont, so re-measure once it lands or the grid stays sized for
  // the fallback face.
  void document.fonts.load(`13px ${monoFont(el)}`).then(() => {
    term.options.fontFamily = monoFont(el);
    try {
      fit.fit();
    } catch {
      /* not attached yet */
    }
  });
  // Agent TUIs (Claude Code among them) select with the mouse themselves and
  // hand the text to the terminal as an OSC 52 escape. Writes go to the real
  // clipboard; reads are refused, so an agent can never pull what you copied
  // elsewhere.
  term.loadAddon(
    new ClipboardAddon(undefined, {
      readText: () => "",
      writeText: (_selection, text) => copyWithFeedback(text, "copied from the agent"),
    }),
  );
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

/** [label, bytes, accessible name] */
const TERMINAL_KEYS: [string, string, string][] = [
  ["esc", "\x1b", "Escape"],
  ["tab", "\t", "Tab"],
  ["⇧tab", "\x1b[Z", "Shift Tab"],
  ["^C", "\x03", "Control C"],
  ["↑", "\x1b[A", "Up arrow"],
  ["↓", "\x1b[B", "Down arrow"],
  ["←", "\x1b[D", "Left arrow"],
  ["→", "\x1b[C", "Right arrow"],
];

export default function TerminalView({ workspaceId, terminalId, onExit }: Props) {
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
  /** Set inside the effect; the reconnect control calls it. */
  const reconnectRef = useRef<() => void>(() => {});
  const termRef = useRef<Terminal | null>(null);
  const attachRef = useRef<(files: File[]) => void>(() => {});
  const keyRef = useRef<(value: string) => void>(() => {});
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    termRef.current = term;
    // The selection stays after copying so you can see what was taken.
    const copySel = () => void copyWithFeedback(term.getSelection());
    const sendInput = (value: string) => {
      if (value && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) wsRef.current.send(value);
    };
    const bracketedPaste = (value: string) => `\x1b[200~${value}\x1b[201~`;
    // Files reach the agent as paths: upload each, then paste the paths the way
    // a desktop terminal pastes a dropped file. Claude Code and similar agents
    // turn an image path into an attachment.
    const sendFiles = async (files: File[]) => {
      if (files.length === 0) return;
      const paths: string[] = [];
      for (const file of files) {
        try {
          paths.push((await api.uploadImage(workspaceId, file)).path);
        } catch (e) {
          toast.error(`could not attach ${file.name || "the file"}: ${(e as Error).message}`);
        }
      }
      if (paths.length === 0) return;
      sendInput(bracketedPaste(paths.join(" ")));
      toast.success(`attached ${paths.length} file${paths.length === 1 ? "" : "s"}`);
      announce(`attached ${paths.length} file${paths.length === 1 ? "" : "s"}`);
    };
    attachRef.current = (files) => void sendFiles(files);
    keyRef.current = sendInput;
    // Returning false keeps a key from the pty. Ctrl/Cmd+C copies only when
    // there is a selection, so with nothing selected it still interrupts the
    // agent; Ctrl+Shift+C always copies, as in desktop terminals. keydown only:
    // the handler sees keyup and keypress too.
    term.attachCustomKeyEventHandler((e) => {
      // Ctrl/Cmd+V must stay a browser paste. xterm would otherwise send a raw
      // ^V to the pty and cancel the key, so the browser never fires "paste"
      // and a screenshot on the clipboard never reaches the page (the agent
      // then looks at the server's own, empty, clipboard). Returning false
      // without preventDefault lets the native paste run; onPaste takes files
      // and xterm takes text.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "v") return false;
      if (e.type !== "keydown" || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "c") return true;
      if (!e.shiftKey && !term.hasSelection()) return true;
      e.preventDefault();
      copySel();
      return false;
    });
    // Capture phase on the terminal itself: xterm's own paste handler calls
    // stopPropagation, so a document listener never saw a paste made inside the
    // terminal, which is why pasting a screenshot did nothing. Files are taken
    // here; plain text is left to xterm.
    const filesOf = (data: DataTransfer | null) => {
      const fromItems = Array.from(data?.items ?? [])
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((f): f is File => !!f);
      return fromItems.length ? fromItems : Array.from(data?.files ?? []);
    };
    // Some pastes arrive without the image: Ctrl+Shift+V is "paste as plain
    // text" and strips it. When a paste carries neither files nor text, ask the
    // async clipboard for an image (Chrome asks the user once for permission).
    const imagesFromClipboard = async (): Promise<File[]> => {
      if (!navigator.clipboard?.read) return [];
      try {
        const out: File[] = [];
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.find((t) => t.startsWith("image/"));
          if (type) out.push(new File([await item.getType(type)], `pasted.${type.slice(6)}`, { type }));
        }
        return out;
      } catch {
        return [];
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const files = filesOf(e.clipboardData);
      if (files.length > 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void sendFiles(files);
        return;
      }
      if (!e.clipboardData?.getData("text/plain")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void imagesFromClipboard().then((found) => {
          if (found.length) void sendFiles(found);
          else toast("nothing to paste: copy text or a screenshot first, or use attach");
        });
      }
    };
    // Typed input goes out as a bare string: the same frame shape as paste. The
    // subscription is per-mount and must be released, because the terminal it
    // listens on is cached and outlives this effect: without dispose(), every
    // remount would send a keystroke once more.
    const inputSubscription = term.onData(sendInput);
    const onDrop = (e: DragEvent) => {
      const files = filesOf(e.dataTransfer);
      if (files.length === 0) return;
      e.preventDefault();
      void sendFiles(files);
    };
    const onDragOver = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.items ?? []).some((item) => item.kind === "file")) e.preventDefault();
    };
    el.addEventListener("paste", onPaste, true);
    el.addEventListener("drop", onDrop);
    el.addEventListener("dragover", onDragOver);

    // websocket to server, with reconnect + backoff
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}`;

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
      if (chunk.includes("[process exited]")) window.setTimeout(() => onExitRef.current?.(), 800);
    };

    const teardown = () => {
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = null;
        ws.close();
        wsRef.current = null;
      }
    };

    // A pty resize makes a full-screen agent (Claude Code) repaint everything,
    // so it is sent once per real change in the grid, never per pixel: a
    // sidebar toggle used to fire the observer, the window listener and two
    // timers, each a repaint, which read as flicker.
    let lastSent = "";
    let resizeTimer = 0;
    const sendResize = () => {
      try {
        const dims = fit.proposeDimensions();
        if (!dims || !dims.cols || !dims.rows) return;
        if (dims.cols !== term.cols || dims.rows !== term.rows) fit.fit();
        const size = `${dims.cols}x${dims.rows}`;
        if (size !== lastSent && wsRef.current?.readyState === WebSocket.OPEN) {
          lastSent = size;
          wsRef.current.send(JSON.stringify({ type: "resize", id: workspaceId, terminalId, cols: dims.cols, rows: dims.rows }));
        }
      } catch {
        /* not attached yet */
      }
    };
    const scheduleResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(sendResize, 80);
    };

    const connect = () => {
      if (!mountedRef.current) return;
      const ws = new WebSocket(wsUrl, socketProtocol());
      wsRef.current = ws;
      ws.onopen = () => {
        attempts = 0; // reset backoff on a successful connect
        setSocket("live");
        ws.send(JSON.stringify({ type: "attach", id: workspaceId, terminalId }));
        lastSent = ""; // a new socket has never been told the size
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
        if (attempts === 0) term.write("\r\n\x1b[2m[disconnected, retrying]\x1b[22m\r\n");
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

    // The observer covers window and panel changes alike (sidebar, tab switch).
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(el);
    const t1 = setTimeout(scheduleResize, 100);
    const t2 = setTimeout(scheduleResize, 500);

    return () => {
      mountedRef.current = false;
      inputSubscription.dispose();
      window.clearTimeout(resizeTimer);
      observer.disconnect();
      el.removeEventListener("paste", onPaste, true);
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
      {/* Same pane-header geometry as the other panes: a 2rem-min row with 12px
          text, like every pane header. No h2 title: this pane's identity
          is the tab and the instance strip rendered directly above it by
          WorkspaceDetail, and the chip plus this line already carry its state. */}
      <header className="cockpit-head text-2xs text-text-muted">
        <span className={cn("chip", SOCKET_CHIP[socket])}>
          <span className="chip-dot" aria-hidden="true" />
          {SOCKET_LABEL[socket]}
        </span>
        {socket === "live" ? null : (
          <span className="truncate">
            {socket === "connecting" ? "opening socket…" : "pty output paused until the socket returns"}
          </span>
        )}
        <div className="flex-1" />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            attachRef.current(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <Button
          variant="quiet"
          size="sm"
          className="shrink-0"
          title="send a file or screenshot to the agent (or paste / drop it on the terminal)"
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip size={13} aria-hidden="true" />
          attach
        </Button>
        <Button
          variant="quiet"
          size="sm"
          className="shrink-0"
          title="copy the selection (ctrl+shift+c)"
          onClick={() => {
            const term = termRef.current;
            if (!term?.hasSelection()) {
              toast("select text first: shift+drag, or use copy screen");
              return;
            }
            void copyWithFeedback(term.getSelection());
          }}
        >
          <Copy size={13} aria-hidden="true" />
          copy
        </Button>
        <Button
          variant="quiet"
          size="sm"
          className="shrink-0"
          onClick={() => termRef.current && void copyWithFeedback(screenText(termRef.current), "screen copied")}
        >
          <Monitor size={13} aria-hidden="true" />
          copy screen
        </Button>
        {reconnecting ? (
          <Button variant="quiet" size="sm" className="shrink-0 whitespace-nowrap" onClick={() => reconnectRef.current()} aria-describedby={descId}>
            reconnect now
          </Button>
        ) : null}
      </header>

      {/* Not a live region: a screen reader would read every line the agent
          prints. The connection chip above carries the state that matters. */}
      <div className="min-h-0 flex-1">
        <div
          ref={containerRef}
          data-terminal-root=""
          role="group"
          aria-label={`terminal ${terminalId} for ${workspaceId}`}
          aria-describedby={descId}
          className="terminal-wrap"
        />
      </div>
      {/* Phones have no Esc, Tab or arrows, and an agent's TUI needs all of them.
          Shown on touch devices only; pressing a key must not take focus from the
          terminal, or the on-screen keyboard closes with every tap. */}
      <div className="termkeys" role="toolbar" aria-label="terminal keys">
        {TERMINAL_KEYS.map(([label, value, name]) => (
          <button
            key={name}
            type="button"
            className="termkey"
            aria-label={name}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => keyRef.current(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <p id={descId} className="sr-only">
        Interactive terminal. Keystrokes are sent to the agent&apos;s process; output is not
        announced here. The Log tab has the same output as readable text.
      </p>
    </div>
  );
}
