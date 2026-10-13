import { useEffect, useState } from "react";
import { DeviceMobile } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../api";
import { announce } from "../lib/announce";
import { Button } from "./ui";

const supported = "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone =
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** The push service wants the VAPID key as bytes, not base64url. */
function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Notifications on this device: a finished agent reaches the phone even with the browser closed. */
export default function PushToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) return;
    void currentSubscription().then((s) => setOn(!!s), () => setOn(false));
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      // From the click: browsers only honour a permission request made by a gesture.
      if ((await Notification.requestPermission()) !== "granted") {
        toast.error("Notifications are blocked for this site. Allow them in the browser settings, then try again.");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const { key } = await api.pushKey();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      await api.pushSubscribe(sub.toJSON());
      setOn(true);
      announce("Notifications are on for this device");
    } catch (e) {
      toast.error(`Could not turn notifications on: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const sub = await currentSubscription();
      if (sub) {
        await api.pushUnsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
      setOn(false);
      announce("Notifications are off for this device");
    } catch (e) {
      toast.error(`Could not turn notifications off: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    try {
      const sub = await currentSubscription();
      if (!sub) throw new Error("This device is not set up for notifications");
      await api.pushTest(sub.endpoint);
      toast.success("Sent. It should arrive in a few seconds.");
    } catch (e) {
      toast.error(`The test did not work: ${(e as Error).message}`);
    }
  };

  let note: string;
  if (!supported) {
    note =
      isIos && !standalone
        ? "On iPhone, notifications only work from the Home Screen: tap Share, then Add to Home Screen, open Kohlab from that icon, and come back here."
        : "This browser cannot show notifications.";
  } else {
    note = "Get a notification on this device when Claude finishes or needs you, even when the browser is closed.";
  }

  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0 text-text-muted" aria-hidden="true">
        <DeviceMobile size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text-primary">Notifications on this device</p>
        <p className="mt-1 text-sm leading-relaxed text-text-muted">{note}</p>
        {supported ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {on ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => void test()}>
                  Send a test
                </Button>
                <Button variant="quiet" size="sm" disabled={busy} onClick={() => void disable()}>
                  Turn off
                </Button>
              </>
            ) : (
              <Button variant="secondary" size="sm" disabled={busy || on === null} onClick={() => void enable()}>
                {busy ? "Turning on…" : "Turn on notifications"}
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
