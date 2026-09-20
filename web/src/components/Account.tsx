import { useEffect, useState } from "react";
import { Key, SignOut, UserCircle } from "@phosphor-icons/react";
import { api, clearKey, setKey } from "../api";
import { announce } from "../lib/announce";
import { Button, Panel, PanelHead } from "./ui";

/**
 * Account: who you are, and the two things you can do about it.
 *
 * Rotation is self-service on purpose. The alternative is asking an owner to mint
 * you a key and hand it over, which is how keys end up in chat windows. The new
 * key is shown once and stored in this browser immediately — the old one stops
 * working the instant the server answers, so doing the store *after* a re-render
 * would sign you out of the tab you are standing in.
 */
export default function Account() {
  const [me, setMe] = useState<{ id: string; role: string; kind: string } | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .account()
      .then((a) => alive && setMe(a))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  const rotate = async () => {
    setBusy(true);
    setError(null);
    try {
      const { key } = await api.rotateMyKey();
      setKey(key); // before anything else: this browser must survive its own rotation
      setFresh(key);
      announce("key rotated — the previous key no longer works");
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      announce(`rotation failed: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    clearKey();
    location.reload();
  };

  const isNamed = me?.kind === "user";

  return (
    <Panel>
      <PanelHead
        icon={<UserCircle size={16} aria-hidden="true" />}
        title="Account"
        meta={me ? `${me.id} · ${me.role}` : "…"}
      />
      <div className="space-y-4 p-4">
        {error ? (
          <p className="text-xs text-danger-strong" role="alert">
            {error}
          </p>
        ) : null}

        {fresh ? (
          <div className="rounded-lg border border-line-subtle bg-surface-sunken p-3">
            <p className="text-xs font-medium text-text-primary">Your new key — shown once</p>
            <code className="mt-2 block break-all font-mono text-xs text-text-primary">{fresh}</code>
            <p className="mt-2 text-2xs leading-relaxed text-text-muted">
              Saved in this browser. Any other device or script using the old key must be updated
              now — it has already stopped working.
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={rotate} disabled={busy || !isNamed} variant="secondary">
            <Key size={14} aria-hidden="true" />
            {busy ? "Rotating…" : "Rotate my key"}
          </Button>
          <Button onClick={signOut} variant="quiet">
            <SignOut size={14} aria-hidden="true" />
            Sign out
          </Button>
        </div>

        <p className="text-2xs leading-relaxed text-text-muted">
          {isNamed
            ? "Rotating replaces your key everywhere at once: the old one is dead the moment this finishes. You stay signed in here."
            : "This server authenticates with a single key set on the box, so there is nothing personal to rotate. Rotate it there with `kohlab key rotate`, then enter the new key. Signing out clears it from this browser."}
        </p>
      </div>
    </Panel>
  );
}
