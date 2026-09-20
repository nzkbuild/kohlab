import { useState } from "react";
import { TerminalWindow } from "@phosphor-icons/react";
import { api, setKey } from "../api";
import { useApp } from "../store";
import { Button, Field } from "./ui";

const KEY_FIELD = "access-key";

/** Access-key gate: the only screen shown before the store is reachable. */
export default function AuthGate() {
  const setAuthed = useApp((s) => s.setAuthed);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const candidate = value.trim();
    if (!candidate) return;
    setBusy(true);
    setError(null);
    const ok = await api.testKey(candidate);
    if (!ok) {
      setError("wrong key — try again");
      setBusy(false);
      return;
    }
    // Key first: the store flipping `authed` unmounts this gate, and every
    // request after it must already carry the key.
    setKey(candidate);
    setAuthed(true);
  };

  return (
    <div className="grid h-full place-items-center bg-surface-base p-4">
      <div className="panel w-full max-w-[22rem] p-6">
        <div className="flex items-center gap-2.5">
          <span
            className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-text-on-accent"
            aria-hidden="true"
          >
            <TerminalWindow size={15} weight="bold" />
          </span>
          <span className="text-lg font-semibold tracking-tight">kohlab</span>
        </div>
        <p className="mt-1 text-xs text-text-muted">agent workspaces</p>

        <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
          <Field label="Access key" htmlFor={KEY_FIELD} error={error ?? undefined}>
            <input
              id={KEY_FIELD}
              className="field-input"
              type="password"
              // SC 3.3.8 (Accessible Authentication): a long random key must not
              // have to be remembered or retyped. current-password is what lets a
              // password manager hold it; without it the field is a transcription
              // task, which is the thing the criterion exists to prevent.
              autoComplete="current-password"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-describedby={error ? `${KEY_FIELD}-error` : undefined}
            />
          </Field>
          <Button variant="primary" type="submit" disabled={busy || value.trim().length === 0}>
            {busy ? "checking…" : "enter"}
          </Button>
        </form>
      </div>
    </div>
  );
}
