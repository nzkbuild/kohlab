import { useEffect, useRef, useState } from "react";
import { Copy } from "@phosphor-icons/react";
import { api } from "../api";
import type { OpenCodeMethod, OpenCodeService, OpenCodeSignIn } from "../types";
import { announce } from "../lib/announce";
import { KEY_NOTE, safeMessage } from "./AccountDialogs";
import { Button, Dialog, Field } from "./ui";

/** A service id as OpenCode names it: lower case letters, digits, dots, dashes and underscores, up to 64 characters. */
export const SERVICE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SERVICE_ID_HELP = "Use lower-case letters, numbers, dots, dashes or underscores.";

type Phase = "pick" | "method" | "browser" | "key" | "done";

/**
 * Connecting one service to an OpenCode account, in steps: what to connect, how (only when more than one way is open),
 * then the browser code or an API key. Same layout and words as the other sign-in dialogs. Never mentions a terminal.
 */
export function OpenCodeSignInDialog({ accountId, title, open, onOpenChange, onDone }: { accountId: string; title: string; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>("pick");
  const [services, setServices] = useState<OpenCodeService[] | null>(null);
  const [service, setService] = useState<OpenCodeService | null>(null);
  const [method, setMethod] = useState<OpenCodeMethod | null>(null);
  const [methods, setMethods] = useState<OpenCodeMethod[]>([]);
  const [other, setOther] = useState(false);
  const [otherId, setOtherId] = useState("");
  const [s, setS] = useState<OpenCodeSignIn | null>(null);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [useNow, setUseNow] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.opencodeServices().then(
      (r) => setServices(r.popular),
      () => setNote("Couldn't load the list. Try again."),
    );
  }, []);

  const take = (r: OpenCodeSignIn) => {
    setS(r);
    setNote(r.state === "failed" ? (r.error ?? "The sign-in did not finish. Start again.") : r.state === "expired" ? "The code ran out. Start again." : null);
  };
  const start = (svc: OpenCodeService, m: OpenCodeMethod) => {
    setS(null);
    setNote(null);
    api.opencodeSignIn(accountId, svc.id, m.id).then(take, (e) => setNote(safeMessage(e, "", "Couldn't start the sign-in.")));
  };
  const chooseMethod = (svc: OpenCodeService, m: OpenCodeMethod) => {
    setService(svc);
    setMethod(m);
    setNote(null);
    if (m.id === "key") return setPhase("key");
    setPhase("browser");
    start(svc, m);
  };
  const pickService = async (svc: OpenCodeService) => {
    setBusy(true);
    setNote(null);
    try {
      const all = (await api.opencodeMethods(svc.id)).methods;
      if (all.length === 0) return setNote("Not available here yet.");
      setService(svc);
      if (all.length === 1) return chooseMethod(svc, all[0]);
      setMethods(all);
      setPhase("method");
    } catch (e) {
      setNote(safeMessage(e, "", "Couldn't check how to connect that."));
    } finally {
      setBusy(false);
    }
  };

  // The waiting sign-in is read again every 2 s. Done closes the steps; the parent reloads the cards.
  useEffect(() => {
    if (phase !== "browser" || s?.state !== "waiting") return;
    let alive = true;
    const t = window.setTimeout(() => {
      setChecking(true);
      api
        .opencodeSignInState(accountId)
        .then((r) => alive && take(r), () => undefined)
        .finally(() => setChecking(false));
    }, 2000);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [phase, s, accountId]);
  useEffect(() => {
    if (s?.state !== "done") return;
    setPhase("done");
    announce("Connected");
    onDone();
  }, [s?.state]);

  const connect = async () => {
    const key = keyRef.current?.value.trim() ?? "";
    if (!key || !service) return;
    setBusy(true);
    setNote(null);
    try {
      await api.opencodeKey(accountId, { integration: service.id, key, label: label.trim() || undefined, useNow });
      setPhase("done");
      announce("Connected");
      onDone();
    } catch (e) {
      setNote(safeMessage(e, key, "Couldn't connect that key."));
    } finally {
      if (keyRef.current) keyRef.current.value = "";
      setBusy(false);
    }
  };
  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text);
    announce(what);
  };

  const url = s?.url && /^https:\/\//i.test(s.url) ? s.url : null;
  const waiting = s?.state === "waiting";
  const failed = s?.state === "failed" || s?.state === "expired";
  const otherOk = SERVICE_ID.test(otherId.trim());
  const status = checking
    ? "Checking…"
    : waiting
      ? "Waiting for you to finish in the browser…"
      : s?.state === "done"
        ? "Connected."
        : null;

  const body = (() => {
    if (phase === "pick") {
      return (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-text-primary">What do you want to connect?</p>
          {services === null && !note ? <p className="text-sm text-text-secondary">Loading the list.</p> : null}
          <div className="flex flex-col gap-2">
            {(services ?? []).map((svc) => (
              <Button key={svc.id} variant="secondary" className="justify-start" disabled={busy} onClick={() => void pickService(svc)}>
                {svc.name}
              </Button>
            ))}
            {other ? null : (
              <Button variant="quiet" className="justify-start text-text-secondary" onClick={() => setOther(true)}>
                Another service…
              </Button>
            )}
          </div>
          {other ? (
            <div className="flex flex-col gap-3">
              <Field label="Service id" htmlFor="opencode-service" help="The id from OpenCode's list, like openrouter." error={otherId && !otherOk ? SERVICE_ID_HELP : undefined}>
                <input id="opencode-service" className="field-input" value={otherId} maxLength={64} autoComplete="off" spellCheck={false} autoCapitalize="off" onChange={(e) => setOtherId(e.target.value)} />
              </Field>
              <div>
                <Button variant="primary" size="sm" disabled={busy || !otherOk} onClick={() => void pickService({ id: otherId.trim(), name: otherId.trim() })}>
                  Continue
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      );
    }
    if (phase === "method" && service) {
      return (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-text-primary">{`How do you want to connect ${service.name}?`}</p>
          <div className="flex flex-col gap-2">
            {methods.map((m) => (
              <Button key={m.id} variant="secondary" className="justify-start" onClick={() => chooseMethod(service, m)}>
                {m.name}
              </Button>
            ))}
          </div>
          <div>
            <Button variant="quiet" size="sm" onClick={() => setPhase("pick")}>
              Back
            </Button>
          </div>
        </div>
      );
    }
    if (phase === "browser" && service && method) {
      return (
        <div className="flex flex-col gap-4">
          {(!s || s.state === "idle") && !note ? <p className="text-sm text-text-secondary">Starting the sign-in.</p> : null}
          {waiting ? (
            <ol className="flex flex-col gap-4 pl-5 text-sm text-text-secondary [list-style:decimal]">
              <li className="flex flex-col items-start gap-2">
                {url ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="primary" size="sm" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
                      Open the sign-in page
                    </Button>
                    <Button variant="quiet" size="sm" onClick={() => copy(url, "Link copied")}>
                      Copy link
                    </Button>
                  </div>
                ) : null}
              </li>
              {s?.code ? (
                <li className="flex flex-col gap-2">
                  <span className="font-medium text-text-primary">Enter this code on that page</span>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="mono rounded-md bg-surface-sunken px-3 py-2 text-2xl tracking-widest text-text-primary">{s.code}</span>
                    <Button variant="secondary" size="sm" onClick={() => copy(s.code!, "Code copied")}>
                      <Copy size={14} aria-hidden="true" />
                      Copy
                    </Button>
                  </div>
                </li>
              ) : null}
            </ol>
          ) : null}
          {status ? (
            <p role="status" className="text-sm text-text-primary">
              {status}
            </p>
          ) : null}
          {failed || (!s && note) ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => start(service, method)}>
                Start again
              </Button>
              <Button variant="quiet" size="sm" onClick={() => { setS(null); setNote(null); setPhase("pick"); }}>
                Back
              </Button>
            </div>
          ) : null}
        </div>
      );
    }
    if (phase === "key" && service) {
      return (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-text-primary">{`Paste the API key for ${service.name}`}</p>
          <Field label="Key" htmlFor="opencode-key" help={KEY_NOTE}>
            <input id="opencode-key" ref={keyRef} type="password" className="field-input" autoComplete="off" spellCheck={false} autoCapitalize="off" />
          </Field>
          <Field label="Name (optional)" htmlFor="opencode-label" help="Something you will recognise, like Work.">
            <input id="opencode-label" className="field-input" value={label} maxLength={60} autoComplete="off" onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <label className="flex items-start gap-2 text-sm text-text-secondary">
            <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-accent" checked={useNow} onChange={(e) => setUseNow(e.target.checked)} />
            Use this one now
          </label>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="text-sm text-text-primary">{service ? `${service.name} is connected.` : "Connected."}</p>
      </div>
    );
  })();

  const close = () => {
    if (keyRef.current) keyRef.current.value = "";
    onOpenChange(false);
  };
  const footer =
    phase === "done" ? (
      <Button variant="secondary" size="sm" onClick={close}>
        Done
      </Button>
    ) : phase === "key" ? (
      <>
        <Button variant="quiet" size="sm" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void connect()}>
          {busy ? "Connecting…" : "Connect"}
        </Button>
      </>
    ) : (
      <Button variant="quiet" size="sm" onClick={close}>
        Cancel
      </Button>
    );

  return (
    <Dialog.Root open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content aria-describedby={undefined} className="dialog-content flex max-h-[85vh] w-[90vw] max-w-[480px] flex-col gap-3 overflow-y-auto p-4">
          <Dialog.Title className="text-base font-semibold text-text-primary">{title}</Dialog.Title>
          {body}
          {note ? (
            <p role="status" className="text-sm text-text-secondary">
              {note}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">{footer}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
