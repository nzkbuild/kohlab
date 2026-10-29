import { useEffect, useRef, useState } from "react";
import { Copy } from "@phosphor-icons/react";
import { api } from "../api";
import type { AccountSignIn, RouterCheck } from "../types";
import { announce } from "../lib/announce";
import { refreshProviders, useProviders } from "../lib/useProviders";
import { Button, Dialog, Field } from "./ui";

export const KEY_NOTE = "The key is stored on the server and can't be shown again.";

/** What a router check says, in words. `models` is the count read back from the AI's card (0: not known yet). */
export function checkText(check: RouterCheck | undefined, models = 0): string | null {
  if (check === "ok") return models > 0 ? `Connected. ${models} ${models === 1 ? "model" : "models"} found.` : "Connected.";
  if (check === "key_rejected") return "The router didn't accept that key.";
  if (check === "unreachable") return "Couldn't reach that address.";
  return null;
}

/** The sentence for a failed request, without ever repeating what the person typed (a key could be inside the server's words). */
function safeMessage(e: unknown, secret: string, what: string): string {
  const m = e instanceof Error ? e.message.trim() : "";
  if (!m || (secret && m.includes(secret))) return `${what} Try again.`;
  return `${what} ${/[.!?]$/.test(m) ? m : `${m}.`}`;
}

/** Finishing another login: the page to open, a code to paste back if the AI asks for one, or a command to run on the server. Polls every 2 s while waiting. */
function SignInView({ id, onDone }: { id: string; onDone: () => void }) {
  const [s, setS] = useState<AccountSignIn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  const take = (r: AccountSignIn) => {
    setS(r);
    setError(r.state === "failed" ? (r.error ?? "Sign-in did not finish. Try again.") : null);
  };
  const start = () => {
    setS(null);
    setError(null);
    api.accountSignIn(id).then(take, (e: Error) => setError(`Couldn't start the sign-in. ${e.message}`));
  };
  useEffect(start, [id]);

  useEffect(() => {
    if (s?.state === "done") onDone();
  }, [s?.state, onDone]);
  useEffect(() => {
    if (s?.state !== "waiting") return;
    let alive = true;
    const t = window.setTimeout(() => {
      api.accountSignInState(id).then(
        (r) => alive && take(r),
        () => undefined,
      );
    }, 2000);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [s, id]);

  const sendCode = async () => {
    const code = codeRef.current?.value.trim() ?? "";
    if (!code) return;
    setSending(true);
    try {
      take(await api.accountSignInCode(id, code));
    } catch (e) {
      setError(safeMessage(e, code, "Couldn't use that code."));
    } finally {
      if (codeRef.current) codeRef.current.value = "";
      setSending(false);
    }
  };
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    announce("Copied");
  };

  if (s === null && !error) return <p className="text-sm text-text-secondary">Starting the sign-in.</p>;
  return (
    <div className="flex flex-col gap-3">
      {s?.state === "waiting" ? (
        <>
          <p className="text-sm text-text-secondary">Open the page, sign in there, then come back here.</p>
          {s.code ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="mono rounded-md bg-surface-sunken px-3 py-2 text-2xl tracking-widest text-text-primary">{s.code}</span>
              <Button variant="secondary" size="sm" onClick={() => copy(s.code!)}>
                <Copy size={14} aria-hidden="true" />
                Copy
              </Button>
            </div>
          ) : null}
          {s.url && /^https:\/\//i.test(s.url) ? (
            <a className="text-sm font-medium text-accent underline underline-offset-2" href={s.url} target="_blank" rel="noopener noreferrer">
              Open sign-in page
            </a>
          ) : null}
          {s.needsCode ? (
            <div className="flex flex-col gap-2">
              <Field label="Code from that page" htmlFor="signin-code">
                <input id="signin-code" ref={codeRef} className="field-input" autoComplete="off" spellCheck={false} />
              </Field>
              <div>
                <Button variant="secondary" size="sm" disabled={sending} onClick={() => void sendCode()}>
                  Send the code
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-text-muted">Waiting for you to finish in your browser.</p>
          )}
        </>
      ) : null}
      {s?.state === "idle" ? (
        <>
          <p className="text-sm text-text-secondary">Sign-in has not started.</p>
          <div>
            <Button variant="secondary" size="sm" onClick={start}>
              Start sign-in
            </Button>
          </div>
        </>
      ) : null}
      {s?.state === "manual" ? (
        <>
          <p className="text-sm text-text-secondary">Run this on the server, finish signing in, then check again.</p>
          <pre className="mono overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-surface-sunken px-3 py-2 text-sm text-text-primary">{s.command ?? ""}</pre>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => copy(s.command ?? "")}>
              <Copy size={14} aria-hidden="true" />
              Copy
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void api.accountSignInState(id).then(take, () => setError("Couldn't check just now. Try again."))}>
              Check again
            </Button>
          </div>
        </>
      ) : null}
      {error ? (
        <div className="flex flex-col items-start gap-2">
          <p role="status" className="text-sm text-text-secondary">{error}</p>
          <Button variant="secondary" size="sm" onClick={start}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

type View = "choose" | "login" | "signin" | "router" | "result";

/**
 * "Add another Claude account" (or Codex login): sign in with another login, or (Claude only) use a router or API address.
 * The key is read from the field once, sent, and the field is emptied; it is never held in React state, a URL, storage or a message.
 */
export function AddAccountDialog({ provider, name, open, onOpenChange }: { provider: "claude" | "codex"; name: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [view, setView] = useState<View>(provider === "claude" ? "choose" : "login");
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: string; check?: RouterCheck } | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const { cards } = useProviders();
  const close = () => {
    if (keyRef.current) keyRef.current.value = "";
    onOpenChange(false);
  };

  const addLogin = async () => {
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.addAccount({ provider, kind: "login", label: label.trim() });
      setMade({ id: r.account.id });
      setView("signin");
    } catch (e) {
      setError(safeMessage(e, "", `Couldn't add that ${name} account.`));
    } finally {
      setBusy(false);
    }
  };

  const addRouter = async () => {
    const key = keyRef.current?.value ?? "";
    if (!label.trim() || !address.trim() || !key) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.addAccount({ provider: "claude", kind: "router", label: label.trim(), baseUrl: address.trim(), key });
      setMade({ id: r.account.id, check: r.check });
      setView("result");
      void refreshProviders("claude");
    } catch (e) {
      setError(safeMessage(e, key, "Couldn't add that address."));
    } finally {
      if (keyRef.current) keyRef.current.value = "";
      setBusy(false);
    }
  };

  const connected = made ? (cards?.find((c) => c.id === provider)?.accounts.find((a) => a.id === made.id)?.models.length ?? 0) : 0;
  const title = view === "router" || view === "result" ? "Use Claude through a router or API address" : view === "choose" ? `Add another ${name} account` : `Sign in with another ${name} login`;

  return (
    <Dialog.Root open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content aria-describedby={undefined} className="dialog-content flex max-h-[85vh] w-[90vw] max-w-[480px] flex-col gap-3 overflow-y-auto p-4">
          <Dialog.Title className="text-base font-semibold text-text-primary">{title}</Dialog.Title>

          {view === "choose" ? (
            <div className="flex flex-col gap-2">
              <Button variant="secondary" className="justify-start" onClick={() => setView("login")}>
                Sign in with another Claude login
              </Button>
              <Button variant="secondary" className="justify-start" onClick={() => setView("router")}>
                Use Claude through a router or API address
              </Button>
            </div>
          ) : null}

          {view === "login" ? (
            <div className="flex flex-col gap-3">
              <Field label="Name" htmlFor="account-name" help="Something you will recognise, like Work.">
                <input id="account-name" className="field-input" value={label} maxLength={60} autoComplete="off" onChange={(e) => setLabel(e.target.value)} />
              </Field>
              {error ? <p role="status" className="text-sm text-text-secondary">{error}</p> : null}
              <div className="flex justify-end gap-2">
                <Button variant="quiet" size="sm" onClick={close}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" disabled={busy || !label.trim()} onClick={() => void addLogin()}>
                  Continue
                </Button>
              </div>
            </div>
          ) : null}

          {view === "signin" && made ? (
            <>
              <SignInView
                id={made.id}
                onDone={() => {
                  void refreshProviders(provider);
                  announce("Signed in");
                  close();
                }}
              />
              <div className="flex justify-end">
                <Button variant="quiet" size="sm" onClick={close}>
                  Done
                </Button>
              </div>
            </>
          ) : null}

          {view === "router" ? (
            <div className="flex flex-col gap-3">
              <Field label="Name" htmlFor="router-name">
                <input id="router-name" className="field-input" value={label} maxLength={60} autoComplete="off" onChange={(e) => setLabel(e.target.value)} />
              </Field>
              <Field label="Address" htmlFor="router-address">
                <input id="router-address" className="field-input" placeholder="http://127.0.0.1:20128" inputMode="url" autoComplete="off" spellCheck={false} autoCapitalize="off" value={address} onChange={(e) => setAddress(e.target.value)} />
              </Field>
              <Field label="Key" htmlFor="router-key" help={KEY_NOTE}>
                <input id="router-key" ref={keyRef} type="password" className="field-input" autoComplete="off" spellCheck={false} autoCapitalize="off" />
              </Field>
              {error ? <p role="status" className="text-sm text-text-secondary">{error}</p> : null}
              <div className="flex justify-end gap-2">
                <Button variant="quiet" size="sm" onClick={close}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" disabled={busy || !label.trim() || !address.trim()} onClick={() => void addRouter()}>
                  {busy ? "Checking…" : "Add"}
                </Button>
              </div>
            </div>
          ) : null}

          {view === "result" ? (
            <div className="flex flex-col gap-3">
              <p role="status" className="text-sm text-text-primary">
                {checkText(made?.check, connected) ?? "Added."}
              </p>
              {made?.check && made.check !== "ok" ? <p className="text-xs text-text-muted">The account is saved. You can replace the key or test it again from Settings.</p> : null}
              <p className="text-xs text-text-muted">{KEY_NOTE}</p>
              <div className="flex justify-end">
                <Button variant="secondary" size="sm" onClick={close}>
                  Done
                </Button>
              </div>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Sign a login account in again, for one that is not signed in yet: reopens the same sign-in as when it was added. */
export function SignInAccountDialog({ id, label, open, onOpenChange, onDone }: { id: string; label: string; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const close = () => onOpenChange(false);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content aria-describedby={undefined} className="dialog-content flex max-h-[85vh] w-[90vw] max-w-[480px] flex-col gap-3 overflow-y-auto p-4">
          <Dialog.Title className="text-base font-semibold text-text-primary">{`Sign in to ${label}`}</Dialog.Title>
          <SignInView
            id={id}
            onDone={() => {
              announce("Signed in");
              onDone();
              close();
            }}
          />
          <div className="flex justify-end">
            <Button variant="quiet" size="sm" onClick={close}>
              Done
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Replace a router's key: the new key goes to the server and is never shown again; the field is emptied at once. */
export function ReplaceKeyDialog({ id, label, open, onOpenChange }: { id: string; label: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const keyRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const close = () => {
    if (keyRef.current) keyRef.current.value = "";
    setMessage(null);
    onOpenChange(false);
  };
  const submit = async () => {
    const key = keyRef.current?.value ?? "";
    if (!key) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.setAccountKey(id, key);
      if (keyRef.current) keyRef.current.value = "";
      const r = await api.testAccount(id).catch(() => null);
      setMessage(`Key replaced. ${checkText(r?.check) ?? ""}`.trim());
      void refreshProviders("claude");
    } catch (e) {
      setMessage(safeMessage(e, key, "Couldn't replace the key."));
    } finally {
      if (keyRef.current) keyRef.current.value = "";
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content aria-describedby={undefined} className="dialog-content flex w-[90vw] max-w-[420px] flex-col gap-3 p-4">
          <Dialog.Title className="text-base font-semibold text-text-primary">{`Replace the key for ${label}`}</Dialog.Title>
          <Field label="New key" htmlFor="replace-key" help={KEY_NOTE}>
            <input id="replace-key" ref={keyRef} type="password" className="field-input" autoComplete="off" spellCheck={false} autoCapitalize="off" />
          </Field>
          {message ? <p role="status" className="text-sm text-text-secondary">{message}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="quiet" size="sm" onClick={close}>
              Done
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void submit()}>
              Replace key
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A new name for another account. Same limits as the server: 1 to 60 characters. */
export function RenameAccountDialog({ id, label, open, onOpenChange, onDone }: { id: string; label: string; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [name, setName] = useState(label);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const submit = async () => {
    const next = name.trim();
    if (!next || next.length > 60) return setMessage("Give the account a name of up to 60 characters.");
    setBusy(true);
    setMessage(null);
    try {
      await api.renameAccount(id, next);
      announce("Account renamed");
      onDone();
      onOpenChange(false);
    } catch (e) {
      setMessage(safeMessage(e, "", "Couldn't rename it."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content aria-describedby={undefined} className="dialog-content flex w-[90vw] max-w-[420px] flex-col gap-3 p-4">
          <Dialog.Title className="text-base font-semibold text-text-primary">Rename this account</Dialog.Title>
          <Field label="Name" htmlFor="rename-account">
            <input id="rename-account" className="field-input" value={name} maxLength={60} autoComplete="off" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void submit()} />
          </Field>
          {message ? <p role="status" className="text-sm text-text-secondary">{message}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="quiet" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void submit()}>
              Rename
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
