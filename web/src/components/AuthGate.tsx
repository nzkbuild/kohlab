import { useRef, useState } from "react";
import { Eye, EyeSlash, TerminalWindow } from "@phosphor-icons/react";
import { api, hasKey, setKey } from "../api";
import { useApp } from "../store";
import { Button, Field } from "./ui";

const KEY_FIELD = "access-key";
/** Password managers key off `name` as much as `id`; both are set deliberately. */
const KEY_NAME = "kohlab-access-key";

/**
 * Access-key gate — the only screen before the store is reachable.
 *
 * The job is narrow: admit someone holding a key, and get out of the way. Three
 * things it deliberately does that a bare form does not:
 *
 *  - says *which server* this is, because a self-hosted tool is often reached at
 *    a bare IP and people run more than one;
 *  - explains a key that this browser already had and the server has since
 *    rejected, instead of showing an unexplained prompt;
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
  // authenticate. Usually a rotation. Saying so beats an unexplained prompt.
  const [hadKey] = useState(() => hasKey());

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const candidate = value.trim();
    if (!candidate || busy) return;
    setBusy(true);
    setError(null);
    const ok = await api.testKey(candidate);
    if (!ok) {
      // One generic message. Never hint at how close a guess was, and never say
      // whether the key exists at all.
      setError("that key was not accepted — check it against the one on the server.");
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
    <div className="grid h-full place-items-center bg-surface-base p-4">
      <div className="panel w-full max-w-[23rem] p-6">
        <div className="flex items-center gap-2.5">
          <span
            className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-text-on-accent"
            aria-hidden="true"
          >
            <TerminalWindow size={15} weight="bold" />
          </span>
          <span className="text-lg font-semibold tracking-tight">kohlab</span>
        </div>
        <p className="mt-1 text-xs text-text-muted">
          agent workspaces · <span className="mono">{location.host}</span>
        </p>

        <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
          <Field label="Access key" htmlFor={KEY_FIELD} error={error ?? undefined}>
            <div className="relative">
              <input
                id={KEY_FIELD}
                name={KEY_NAME}
                ref={input}
                className="field-input pr-11"
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
              />
              {/* Two separate problems, both real for a long pasted secret:
                  "did my paste land?" and "did I mistype a character?" */}
              <Button
                variant="quiet"
                size="sm"
                iconOnly
                className="absolute right-1 top-1/2 -translate-y-1/2"
                aria-label={reveal ? "Hide the key" : "Show the key"}
                aria-pressed={reveal}
                onClick={() => {
                  setReveal((v) => !v);
                  input.current?.focus();
                }}
              >
                {reveal ? <EyeSlash size={14} /> : <Eye size={14} />}
              </Button>
            </div>
          </Field>

          {/* Field owns the label and the error slot; the hint sits under both,
              and yields to the error when there is one. */}
          {error ? null : (
            <p className="field-help">
              {hadKey ? (
                <>the key saved in this browser was rejected — it may have been rotated.</>
              ) : (
                <>
                  find yours by running <span className="mono">kohlab key</span> on the server.
                </>
              )}
            </p>
          )}

          <Button variant="primary" type="submit" disabled={busy || value.trim().length === 0} aria-busy={busy}>
            {busy ? "checking…" : "enter"}
          </Button>
        </form>

        <p className="mt-5 border-t border-line-subtle pt-4 text-2xs leading-relaxed text-text-muted">
          invited by someone? open the invitation link they sent you — it signs you in without a key.
        </p>
      </div>
    </div>
  );
}
