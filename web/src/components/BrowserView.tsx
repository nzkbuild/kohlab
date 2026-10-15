import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type PointerEvent } from "react";
import { api, socketProtocol } from "../api";
import { toDevicePoint, type Point, type Size } from "../lib/browserCoords";
import { useCan } from "../store";
import { Button } from "./ui";

interface Props {
  workspaceId: string;
  /** Told the page's address on first load and after every navigation. */
  onUrl?: (url: string) => void;
}

type Phase = "starting" | "live" | "reconnecting" | "error";
type MouseButton = "left" | "middle" | "right";
interface Frame {
  seq: number;
  data: string;
}
type Message =
  | { type: "frame"; seq: number; data: string; metadata: { deviceWidth: number; deviceHeight: number } }
  | { type: "url"; url: string };

/** Reconnect waits in ms: 1 s, 2 s, 4 s, then 10 s for every try after that. */
const BACKOFF_MS = [1000, 2000, 4000, 10000];
/** How long a click ripple stays on screen. */
const RIPPLE_MS = 250;
const BUTTONS: Record<number, MouseButton> = { 0: "left", 1: "middle", 2: "right" };

/** Ctrl and Cmd shortcuts the remote page gets: select all, copy, cut, undo, redo. Paste is not here: it arrives as the paste event and types the text. */
const PAGE_SHORTCUTS = new Set(["a", "c", "x", "z", "y"]);

/** Ctrl, Cmd and Alt combinations belong to the app and the browser (Ctrl+` and the like), so they are never sent, except the page shortcuts. */
function sendsKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) {
  if (e.altKey) return false;
  return !(e.ctrlKey || e.metaKey) || PAGE_SHORTCUTS.has(e.key.toLowerCase());
}

/** The CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** The button held while the pointer moves, for a drag (selecting text). */
function heldButton(buttons: number): MouseButton | null {
  if (buttons & 1) return "left";
  if (buttons & 4) return "middle";
  if (buttons & 2) return "right";
  return null;
}

/** The fields every key event carries. The virtual key code is what the page reads for editing keys (Backspace, arrows) and shortcuts. */
function keyFields(e: KeyboardEvent) {
  return {
    key: e.key,
    code: e.code,
    ...(e.keyCode ? { windowsVirtualKeyCode: e.keyCode } : {}),
    modifiers: modifiersOf(e),
  };
}

/**
 * A live view of the project's shared browser. The frames are drawn on a canvas and
 * clicks, typing and scrolling are sent back, so the user and Claude share one browser.
 */
export default function BrowserView({ workspaceId, onUrl }: Props) {
  const can = useCan();
  const [phase, setPhase] = useState<Phase>("starting");
  const [errorText, setErrorText] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sockRef = useRef<WebSocket | null>(null);
  /** The remote page's size in device pixels, once a frame has been drawn. */
  const deviceRef = useRef<Size | null>(null);
  const canInputRef = useRef(can.mutate);
  const onUrlRef = useRef(onUrl);
  const pressedRef = useRef(false);
  const lastMoveRef = useRef<{ x: number; y: number; buttons: number } | null>(null);
  const moveFrameRef = useRef(0);
  const rippleSeq = useRef(0);

  useEffect(() => {
    canInputRef.current = can.mutate;
    onUrlRef.current = onUrl;
  }, [can.mutate, onUrl]);

  /** Sends one message if the socket is open. */
  const send = (m: object) => {
    const ws = sockRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  /** The device pixel under a client point, or null in the letterbox margin. */
  const toPoint = (clientX: number, clientY: number, clamp = false): Point | null => {
    const canvas = canvasRef.current;
    const device = deviceRef.current;
    if (!canvas || !device) return null;
    return toDevicePoint(clientX, clientY, canvas.getBoundingClientRect(), device, clamp);
  };
  /** The click ripple: shown at once, before the page has answered. */
  const ripple = (clientX: number, clientY: number) => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const id = ++rippleSeq.current;
    setRipples((list) => [...list, { id, x: clientX - r.left, y: clientY - r.top }]);
    window.setTimeout(() => setRipples((list) => list.filter((p) => p.id !== id)), RIPPLE_MS);
  };

  // The socket: GET starts the browser if needed, then the WebSocket carries frames and input.
  // Authenticated like the terminal socket, through its subprotocol.
  useEffect(() => {
    let alive = true;
    let timer = 0;
    let attempts = 0;
    let pending: Frame | null = null;
    let decoding = false;

    const ack = (seq: number) => send({ type: "ack", seq });

    /** Draws only the newest frame: one that arrives while another decodes replaces the waiting one. */
    const pump = async () => {
      decoding = true;
      while (pending && alive) {
        const f: Frame = pending;
        pending = null;
        let bmp: ImageBitmap | null = null;
        try {
          const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
          bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        } catch {
          /* a frame that will not decode is skipped; the next one still comes */
        }
        const canvas = canvasRef.current;
        if (bmp && canvas) {
          // The picture's own size is the page's size in CSS pixels. The metadata can disagree (headless Chrome reports its window, not the page), which would stretch the picture and put clicks off target.
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
          }
          canvas.getContext("2d")?.drawImage(bmp, 0, 0);
          deviceRef.current = { width: bmp.width, height: bmp.height };
        }
        bmp?.close();
        ack(f.seq);
      }
      decoding = false;
    };

    const onMessage = (raw: string) => {
      let m: Message;
      try {
        m = JSON.parse(raw) as Message;
      } catch {
        return;
      }
      if (m.type === "frame") {
        // A newer frame arrived before the waiting one was drawn: ack the older one so the server keeps sending.
        if (pending) ack(pending.seq);
        pending = { seq: m.seq, data: m.data };
        if (!decoding) void pump();
      } else if (m.type === "url") {
        onUrlRef.current?.(m.url);
      }
    };

    const connect = () => {
      if (!alive) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/browser/${encodeURIComponent(workspaceId)}`, socketProtocol());
      sockRef.current = ws;
      ws.onopen = () => {
        attempts = 0;
        setPhase("live");
        ws.send(JSON.stringify({ type: "config", pacing: "ack" }));
      };
      ws.onmessage = (ev) => onMessage(ev.data as string);
      ws.onclose = () => {
        if (!alive) return;
        sockRef.current = null;
        setPhase("reconnecting");
        const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
        attempts++;
        timer = window.setTimeout(() => void start(), wait);
      };
    };

    const start = async () => {
      try {
        const { url } = await api.browser(workspaceId);
        if (!alive) return;
        if (url) onUrlRef.current?.(url);
      } catch (e) {
        if (!alive) return;
        setErrorText((e as Error).message || "Could not start the browser.");
        setPhase("error");
        return;
      }
      connect();
    };
    void start();

    return () => {
      alive = false;
      window.clearTimeout(timer);
      const ws = sockRef.current;
      sockRef.current = null;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.close();
      }
    };
  }, [workspaceId, attempt]);

  // The page is laid out at the pane's size, so it is shown 1:1 instead of shrunk into the frame.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || phase !== "live" || !canInputRef.current) return;
    let timer = 0;
    const sendSize = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 50 || r.height < 50) return;
      api.browserAct(workspaceId, "viewport", undefined, { width: Math.round(r.width), height: Math.round(r.height) }).catch(() => {});
    };
    // Dragging the pane fires many resizes: wait for a pause. The first call is made once the browser is live.
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(sendSize, 250);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    schedule();
    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
    };
  }, [phase, workspaceId]);

  // Wheel and touch need passive: false so preventDefault stops the panel scrolling, which React's listeners cannot do.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!canInputRef.current) return;
      const p = toPoint(e.clientX, e.clientY);
      if (!p) return;
      const k = e.deltaMode === 1 ? 16 : 1;
      send({ type: "input_mouse", eventType: "mouseWheel", x: p.x, y: p.y, deltaX: e.deltaX * k, deltaY: e.deltaY * k });
    };
    const touchPoints = (list: TouchList, clamp: boolean) =>
      Array.from(list, (t) => toPoint(t.clientX, t.clientY, clamp)).filter((p): p is Point => p !== null);
    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      if (!canInputRef.current) return;
      const pts = touchPoints(e.touches, false);
      if (!pts.length) return;
      ripple(e.touches[0].clientX, e.touches[0].clientY);
      send({ type: "input_touch", eventType: "touchStart", touchPoints: pts });
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (canInputRef.current) send({ type: "input_touch", eventType: "touchMove", touchPoints: touchPoints(e.touches, true) });
    };
    const onTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      if (canInputRef.current) send({ type: "input_touch", eventType: "touchEnd", touchPoints: touchPoints(e.touches, true) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      cancelAnimationFrame(moveFrameRef.current);
    };
  }, []);

  // Mouse pointers. Touch has its own events above, so a tap is not sent twice.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    e.currentTarget.focus({ preventScroll: true });
    const button = BUTTONS[e.button];
    if (!button) return;
    const p = toPoint(e.clientX, e.clientY);
    if (!p) return;
    // Capture, so a drag that ends outside the panel still gets its release.
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!canInputRef.current) return;
    pressedRef.current = true;
    ripple(e.clientX, e.clientY);
    send({ type: "input_mouse", eventType: "mousePressed", x: p.x, y: p.y, button, clickCount: 1 });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch" || !canInputRef.current) return;
    lastMoveRef.current = { x: e.clientX, y: e.clientY, buttons: e.buttons };
    if (moveFrameRef.current) return;
    moveFrameRef.current = requestAnimationFrame(() => {
      moveFrameRef.current = 0;
      const last = lastMoveRef.current;
      const p = last ? toPoint(last.x, last.y) : null;
      const held = last ? heldButton(last.buttons) : null;
      if (p) send({ type: "input_mouse", eventType: "mouseMoved", x: p.x, y: p.y, ...(held ? { button: held } : {}) });
    });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch" || !pressedRef.current) return;
    pressedRef.current = false;
    const button = BUTTONS[e.button];
    // Clamped, so a release outside the page still lands on its edge.
    const p = toPoint(e.clientX, e.clientY, true);
    if (button && p) send({ type: "input_mouse", eventType: "mouseReleased", x: p.x, y: p.y, button, clickCount: 1 });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!canInputRef.current || !sendsKey(e)) return;
    e.preventDefault();
    // What the key types: Enter a carriage return, a printable key its character. A shortcut types nothing.
    const text = e.key === "Enter" ? "\r" : e.key.length === 1 && !(e.ctrlKey || e.metaKey) ? e.key : "";
    send({ type: "input_keyboard", eventType: "keyDown", ...keyFields(e), ...(text ? { text } : {}) });
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!canInputRef.current || !sendsKey(e)) return;
    e.preventDefault();
    send({ type: "input_keyboard", eventType: "keyUp", ...keyFields(e) });
  };
  /** Pasted text goes in one character at a time. Fine for short text. */
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!canInputRef.current) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    for (const ch of text) {
      const newline = ch === "\n" || ch === "\r";
      send({
        type: "input_keyboard",
        eventType: "keyDown",
        key: newline ? "Enter" : ch,
        code: newline ? "Enter" : "",
        text: newline ? "\r" : ch,
      });
    }
  };

  return (
    <div
      ref={wrapperRef}
      role="region"
      aria-label="Shared browser"
      tabIndex={0}
      className="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-surface-sunken cursor-default"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPaste={onPaste}
    >
      <canvas ref={canvasRef} className="absolute inset-0 block size-full cursor-default object-contain" />
      {ripples.map((r) => (
        <span key={r.id} aria-hidden="true" className="browser-ripple" style={{ left: r.x, top: r.y }} />
      ))}
      {phase === "starting" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-sunken p-6 text-center">
          <p role="status" className="text-[15px] text-text-muted">
            Starting the browser…
          </p>
        </div>
      ) : null}
      {phase === "error" ? (
        <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-sunken p-6 text-center">
          <p className="max-w-sm text-[15px] text-text-secondary">{errorText}</p>
          <Button
            variant="secondary"
            onClick={() => {
              setPhase("starting");
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {phase === "reconnecting" ? (
        <p role="status" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-surface-raised px-3 py-1.5 text-sm text-text-muted">
          Reconnecting…
        </p>
      ) : null}
    </div>
  );
}
