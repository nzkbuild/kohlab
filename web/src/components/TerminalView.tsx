import { useEffect, useRef, useState } from "react";
import { api, socketProtocol } from "../api";
import { Button } from "./ui";
import { Copy, Paperclip } from "@phosphor-icons/react";
import { cn } from "../lib/utils";
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
  /** Take keyboard focus once attached, and again whenever this turns true. */
  autoFocus?: boolean;
}

/**
 * Socket state as seen by this pane. Explicit and driven by the socket's own
 * lifecycle: never by `navigator.onLine`, which is not a reachability signal.
 */
type SocketState = "connecting" | "live" | "reconnecting" | "offline";

/** Shown only while the socket is not live: a live terminal has no chrome at all. */
const SOCKET_LABEL: Record<SocketState, string> = {
  connecting: "Connecting…",
  live: "",
  reconnecting: "Reconnecting…",
  offline: "Offline",
};

const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 10000;
/** Past this many consecutive failures the pane reports itself offline. */
const OFFLINE_AFTER_ATTEMPTS = 4;

/** Copy and say so: a silent copy reads as a broken one. */
function copyWithFeedback(text: string, what = "Copied"): Promise<void> {
  if (!text) return Promise.resolve();
  return copyText(text).then(
    () => {
      toast.success(what);
      announce(what);
    },
    () => {
      toast.error("Could not copy. Select the text and use the browser's copy menu.");
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
      // The terminal panel colour: #181818 in both modes.
      background: tokenColor(el, "--surface-terminal"),
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
      writeText: (_selection, text) => copyWithFeedback(text, "Copied from the agent"),
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
  ["Esc", "\x1b", "Escape"],
  ["Tab", "\t", "Tab"],
  ["⇧Tab", "\x1b[Z", "Shift Tab"],
  ["^C", "\x03", "Control C"],
  ["↑", "\x1b[A", "Up arrow"],
  ["↓", "\x1b[B", "Down arrow"],
  ["←", "\x1b[D", "Left arrow"],
  ["→", "\x1b[C", "Right arrow"],
  ["|", "|", "Pipe"],
];

/** Phone keys are 44px: the touch target size, not the desktop control height. */
const PHONE_KEY = "termkey !min-h-11";

export default function TerminalView({ workspaceId, terminalId, onExit, autoFocus }: Props) {
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
  // The phone's sticky Ctrl: armed by its key, it turns the next letter into a control code.
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);

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
          toast.error(`Could not attach ${file.name || "the file"}: ${(e as Error).message}`);
        }
      }
      if (paths.length === 0) return;
      sendInput(bracketedPaste(paths.join(" ")));
      const said = `Attached ${paths.length} file${paths.length === 1 ? "" : "s"}`;
      toast.success(said);
      announce(said);
    };
    attachRef.current = (files) => void sendFiles(files);
    keyRef.current = sendInput;
    // Returning false keeps a key from the pty. Ctrl/Cmd+C copies only when
    // there is a selection, so with nothing selected it still interrupts the
    // agent; Ctrl+Shift+C always copies, as in desktop terminals. keydown only:
    // the handler sees keyup and keypress too.
    term.attachCustomKeyEventHandler((e) => {
      // Ctrl+` opens and closes the terminal panel, so it must reach the window.
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "`" || e.code === "Backquote")) return false;
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
          else toast("Nothing to paste: copy text or a screenshot first, or use Attach");
        });
      }
    };
    // Typed input goes out as a bare string: the same frame shape as paste. The
    // subscription is per-mount and must be released, because the terminal it
    // listens on is cached and outlives this effect: without dispose(), every
    // remount would send a keystroke once more.
    const inputSubscription = term.onData((data) => {
      if (!ctrlRef.current) {
        sendInput(data);
        return;
      }
      ctrlRef.current = false;
      setCtrlArmed(false);
      // Ctrl then a letter sends that letter's control code (Ctrl C is \x03). Anything else goes through as typed.
      sendInput(/^[a-zA-Z]$/.test(data) ? String.fromCharCode(data.toUpperCase().charCodeAt(0) - 64) : data);
    });
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
        const data = ev.data as string;
        // A refused attach comes back as one JSON frame: show its words, not the braces.
        if (data.startsWith('{"type":"error"')) {
          try {
            term.write(`\r\n\x1b[2m${(JSON.parse(data) as { error: string }).error}\x1b[22m\r\n`);
            return;
          } catch {}
        }
        pending += data;
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

  // Declared after the attach effect, so termRef already holds the attached terminal.
  useEffect(() => {
    if (!autoFocus) return;
    // A tick late: a menu or dialog that just closed returns focus to its trigger in a timeout of its own.
    const t = window.setTimeout(() => termRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [autoFocus, workspaceId, terminalId]);

  const descId = `terminal-desc-${workspaceId}-${terminalId}`;
  const termKey = ([label, value, name]: [string, string, string]) => (
    <button
      key={name}
      type="button"
      className={PHONE_KEY}
      aria-label={name}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => keyRef.current(value)}
    >
      {label}
    </button>
  );
  const reconnecting = socket === "reconnecting" || socket === "offline";

  return (
    <div className="dark-pane flex h-full min-h-0 flex-col">
      {/* A live terminal has no chrome. The bar shows only while the socket is down. */}
      {socket === "live" ? null : (
        <div className="flex items-center gap-2 bg-surface-raised px-3 py-1.5 text-xs text-text-muted">
          <span className="min-w-0 flex-1 truncate">{SOCKET_LABEL[socket]}</span>
          {reconnecting ? (
            <Button variant="secondary" size="sm" className="shrink-0 whitespace-nowrap" onClick={() => reconnectRef.current()} aria-describedby={descId}>
              Reconnect now
            </Button>
          ) : null}
        </div>
      )}
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

      {/* Not a live region: a screen reader would read every line the agent
          prints. The bar above carries the state that matters. */}
      <div className="terminal-area relative min-h-0 flex-1">
        <div
          ref={containerRef}
          data-terminal-root=""
          role="group"
          aria-label={`terminal ${terminalId} for ${workspaceId}`}
          aria-describedby={descId}
          className="terminal-wrap"
        />
        <div className="terminal-tools absolute top-2 right-2 z-10 flex gap-1">
          <Button
            variant="quiet"
            size="sm"
            iconOnly
            className="bg-surface-raised"
            aria-label="Attach a file"
            title="Attach a file (or paste / drop it on the terminal)"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={14} aria-hidden="true" />
          </Button>
          <Button
            variant="quiet"
            size="sm"
            iconOnly
            className="bg-surface-raised"
            aria-label="Copy"
            title="Copy the selection, or the whole screen if nothing is selected"
            onClick={() => {
              const term = termRef.current;
              if (!term) return;
              if (term.hasSelection()) void copyWithFeedback(term.getSelection());
              else void copyWithFeedback(screenText(term), "Screen copied");
            }}
          >
            <Copy size={14} aria-hidden="true" />
          </Button>
        </div>
      </div>
      {/* Phones have no Esc, Tab or arrows, and an agent's TUI needs all of them.
          Shown on touch devices only; pressing a key must not take focus from the
          terminal, or the on-screen keyboard closes with every tap. */}
      <div className="termkeys" role="toolbar" aria-label="terminal keys">
        {TERMINAL_KEYS.slice(0, 3).map(termKey)}
        <button
          type="button"
          className={cn(PHONE_KEY, ctrlArmed && "!bg-surface-active")}
          aria-label="Control"
          aria-pressed={ctrlArmed}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            ctrlRef.current = !ctrlRef.current;
            setCtrlArmed(ctrlRef.current);
          }}
        >
          Ctrl
        </button>
        {TERMINAL_KEYS.slice(3).map(termKey)}
      </div>
      <p id={descId} className="sr-only">
        Interactive terminal. Keystrokes are sent to the agent&apos;s process; output is not
        announced here. The Log tab has the same output as readable text.
      </p>
    </div>
  );
}
