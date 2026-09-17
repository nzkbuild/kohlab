import { useEffect } from "react";
import { useApp } from "../store";
import { announce } from "./announce";
import { parseRoute } from "./route";

const POLL_MS = 6000;
/** After this many consecutive failed upgrades the chip reads "offline". */
const OFFLINE_AFTER_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 20000;

interface DoneMessage {
  type?: string;
  id?: string;
  task?: string;
}

/**
 * The single place the client talks to the server in the background:
 * the push socket, the visibility-gated poll, and Back/Forward.
 *
 * Polling is gated on document.visibilityState — browsers throttle timers in
 * hidden tabs but exempt WebSockets, so the socket stays up while a hidden tab
 * stops polling entirely. The socket uses exponential backoff with jitter so a
 * server restart cannot turn every open tab into a retry storm.
 */
export function useSync(): void {
  const authed = useApp((s) => s.authed);
  const refresh = useApp((s) => s.refresh);
  const setConnection = useApp((s) => s.setConnection);
  const adoptRoute = useApp((s) => s.adoptRoute);

  // First load once authenticated.
  useEffect(() => {
    if (authed) void refresh();
  }, [authed, refresh]);

  // Back/Forward: the URL already changed, so adopt it without pushing again.
  useEffect(() => {
    const onPopState = () => adoptRoute(parseRoute(location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [adoptRoute]);

  // Push channel: done-pings plus the connection chip.
  useEffect(() => {
    if (!authed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    // The socket must carry the key: the server authenticates the upgrade, and
    // without it an access-key deployment silently never connects.
    const key = new URLSearchParams(location.search).get("key") ?? localStorage.getItem("kohlab_key") ?? "";
    const url = `${proto}//${location.host}${key ? `?key=${encodeURIComponent(key)}` : ""}`;

    const seen = new Set<string>();
    let socket: WebSocket | null = null;
    let attempt = 0;
    let timer: number | undefined;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setConnection(attempt === 0 ? "connecting" : "reconnecting");
      socket = new WebSocket(url);

      socket.onopen = () => {
        attempt = 0;
        setConnection("live");
        void refresh();
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let message: DoneMessage;
        try {
          message = JSON.parse(event.data) as DoneMessage;
        } catch {
          return; // terminal bytes on a shared socket
        }
        if (message.type !== "workspace.done" || !message.id) return;
        if (seen.has(message.id)) return;
        seen.add(message.id);

        void refresh();
        announce(`${message.id} finished — ready for review`);

        // An OS notification only when the tab is hidden, always tagged so a
        // repeat replaces rather than stacks, and never requesting permission
        // here — that belongs to a user gesture in Settings.
        if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("kohlab — ready for review", {
            body: message.task || `${message.id} finished`,
            tag: `kohlab-${message.id}`,
          });
        }
      };

      socket.onclose = () => {
        if (disposed) return;
        attempt += 1;
        setConnection(attempt >= OFFLINE_AFTER_ATTEMPTS ? "offline" : "reconnecting");
        const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
        const jitter = backoff * (0.75 + Math.random() * 0.5);
        timer = window.setTimeout(connect, jitter);
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [authed, refresh, setConnection]);

  // Visibility-gated poll.
  useEffect(() => {
    if (!authed) return;
    const pollIfVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const id = window.setInterval(pollIfVisible, POLL_MS);
    // Returning to the tab refreshes immediately rather than waiting a tick out.
    document.addEventListener("visibilitychange", pollIfVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", pollIfVisible);
    };
  }, [authed, refresh]);
}
