import { useRef, useState } from "react";
import { Eye, EyeSlash, TerminalWindow } from "@phosphor-icons/react";
import { api, hasKey, setKey } from "../api";
import { useApp } from "../store";
import { Button, Field } from "./ui";

const KEY_FIELD = "access-key";
/** Password managers key off `name` as much as `id`, so both are set on purpose. */
const KEY_NAME = "kohlab-access-key";

/**
 * Access gate: the only screen before the store is reachable.
 *
 * The register is a session being opened, not an account being created. Nobody
 * signs up here; they present a credential to a machine they already own, which
 * is closer to `ssh` than to a login page. So the card is built like the rest of
 * the console: graphite planes for depth, mono for the machine facts (the host,
 * the key), sans for the operator, and the accent spent on the one thing you
 * have to do.
 *
 * Three obligations a bare form misses:
 *  - says which server this is, because a self-hosted tool is usually reached at
 *    a bare address and people run more than one;
 *  - explains a key this browser already had and the server has since rejected,
 *    instead of showing an unexplained prompt after a rotation;
 *  - points an invited teammate at their invitation link, since landing here
 *    without a key is otherwise a dead end.
 */
export default function AuthGate() {
  const setAuthed = useApp((s) => s.setAuthed);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Read once: a key this browser had, which the bootstrap then failed to
  // authenticate. Usually a rotation.
  const [hadKey] = useState(() => hasKey());

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const candidate = value.trim();
    if (!candidate || busy) return;
    setBusy(true);
    setError(null);
    const ok = await api.testKey(candidate);
    if (!ok) {
      // One message, and one only: testKey reports a bare boolean, so the gate
      // cannot tell a rejected key from an unreachable server, and guessing
      // between them would be a lie. It also never hints at how close a guess
      // was.
      setError("that key was not accepted. check it against the one on the server.");
      setBusy(false);
      // Put the caret back where the correction happens, rather than leaving
      // focus on a button the user now has to tab back from. The value is kept:
      // a mistyped character is cheaper to fix than to retype.
      input.current?.focus();
      return;
    }
    // Key first: the store flipping `authed` unmounts this gate, and every
    // request after it must already carry the key.
    setKey(candidate);
    setAuthed(true);
  };

  return (
    <div className="auth-stage grid h-full place-items-center p-4">
      <div className="auth-card w-full max-w-[26rem] p-7">
        <header className="flex items-center gap-3">
          <span
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-text-on-accent"
            aria-hidden="true"
          >
            <TerminalWindow size={18} weight="bold" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold leading-none tracking-tight">kohlab</h1>
            <p className="mt-1.5 flex items-baseline gap-1.5 text-2xs text-text-muted">
              <span>agent workspaces</span>
              <span aria-hidden="true" className="text-text-faint">
                /
              </span>
              {/* The one machine fact worth showing before anyone is in: which
                  box this is. Title carries it in full when it truncates. */}
              <span className="mono truncate text-text-faint" title={location.host}>
                {location.host}
              </span>
            </p>
          </div>
        </header>

        <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
          <Field label="Access key" htmlFor={KEY_FIELD} error={error ?? undefined}>
            <div className="relative">
              <span className="auth-prompt" aria-hidden="true">
                &gt;
              </span>
              <input
                id={KEY_FIELD}
                name={KEY_NAME}
                ref={input}
                className="field-input auth-key"
                type={reveal ? "text" : "password"}
                // SC 3.3.8 (Accessible Authentication): a 48-character random key
                // must not be a memory or transcription test. `current-password`
                // is what lets a password manager hold it and fill it.
                autoComplete="current-password"
                // A hex key is not a sentence. Mobile keyboards capitalise and
                // autocorrect by default, which silently corrupts a paste.
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                // Field owns the label and the error slot but deliberately does
                // not wire this, so the association is made here. Without it the
                // error is visible but not attached to the field, and a screen
                // reader announces neither it nor the hint.
                aria-describedby={error ? `${KEY_FIELD}-error` : `${KEY_FIELD}-help`}
              />
              {/* Two separate questions a masked field cannot answer, and both
                  are real for a long pasted secret: "did my paste land?" and
                  "did I mistype a character?" */}
              <Button
                variant="quiet"
                size="sm"
                iconOnly
                className="absolute right-1.5 top-1/2 -translate-y-1/2"
                aria-label={reveal ? "hide the key" : "show the key"}
                aria-pressed={reveal}
                onClick={() => {
                  setReveal((v) => !v);
                  input.current?.focus();
                }}
              >
                {reveal ? <EyeSlash size={13} /> : <Eye size={13} />}
              </Button>
            </div>
          </Field>

          {/* The hint yields to the error rather than stacking with it, so there
              is never a moment with two competing messages under one field. */}
          {error ? null : (
            <p id={`${KEY_FIELD}-help`} className="field-help">
              {hadKey ? (
                <>the key saved in this browser was rejected. it may have been rotated.</>
              ) : (
                <>
                  find yours by running <span className="mono text-text-faint">kohlab key</span> on
                  the server.
                </>
              )}
            </p>
          )}

          <Button
            variant="primary"
            type="submit"
            className="mt-1 min-h-11 w-full"
            disabled={busy || value.trim().length === 0}
            aria-busy={busy}
          >
            {busy ? "checking" : "enter"}
          </Button>
        </form>

        <p className="mt-6 border-t border-line-subtle pt-4 text-2xs leading-relaxed text-text-muted">
          invited by someone? open the invitation link they sent you. it signs you in without a key.
        </p>
      </div>
    </div>
  );
}
