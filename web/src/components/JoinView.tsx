import { useEffect, useState } from "react";
import { TerminalWindow, WarningCircle } from "@phosphor-icons/react";
import { api, setKey } from "../api";
import { announce } from "../lib/announce";
import { useApp } from "../store";
import { Button } from "./ui";

/**
 * Redeeming an invitation.
 *
 * Rendered before the key gate, because whoever opens this link has no key yet —
 * that is what the link is for. The token arrives in the URL fragment, which is
 * never sent to the server, so it cannot appear in an access log.
 *
 * One button, and then they are in: their own space, their own key, stored the
 * same way the gate stores one.
 */
export default function JoinView() {
  const setAuthed = useApp((s) => s.setAuthed);
  const navigate = useApp((s) => s.navigate);
  const [token] = useState(() => location.hash.replace(/^#/, "").trim());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The token is spent by being redeemed, so it must not be left in the address
  // bar or in history for anyone with access to this browser to reuse.
  useEffect(() => {
    if (token) history.replaceState(null, "", "/join");
  }, [token]);

  const accept = async () => {
    setWorking(true);
    setError(null);
    try {
      const { user, key } = await api.join(token);
      setKey(key);
      announce(`joined as ${user.name || user.id}`);
      // Key first: flipping `authed` mounts the app, and every request it makes
      // must already carry the key.
      setAuthed(true);
      navigate({ kind: "workspaces" });
    } catch (e) {
      setError((e as Error).message);
      setWorking(false);
    }
  };

  return (
    <div className="grid h-full place-items-center bg-surface-base p-4">
      <div className="panel w-full max-w-[24rem] p-6">
        <div className="flex items-center gap-2.5">
          <span
            className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-text-on-accent"
            aria-hidden="true"
          >
            <TerminalWindow size={15} weight="bold" />
          </span>
          <span className="text-lg font-semibold tracking-tight">kohlab</span>
        </div>

        {!token ? (
          <>
            <p className="mt-1 text-xs text-text-muted">nothing to accept</p>
            <p className="mt-5 flex items-start gap-1.5 text-2xs text-status-danger">
              <WarningCircle size={13} className="mt-px shrink-0" aria-hidden="true" />
              This link is missing its invitation. It may have been truncated — ask the person who
              invited you to send it again, and open it exactly as it arrives.
            </p>
          </>
        ) : (
          <>
            <p className="mt-1 text-xs text-text-muted">you have been invited</p>
            <p className="mt-5 text-2xs leading-relaxed text-text-secondary">
              Accepting gives you your own key and your own space on this server. The person who
              invited you will not see your work, and you will not see theirs.
            </p>
            {error ? (
              <p className="mt-3 flex items-start gap-1.5 text-2xs text-status-danger">
                <WarningCircle size={13} className="mt-px shrink-0" aria-hidden="true" />
                {error}
              </p>
            ) : null}
            <div className="mt-5">
              <Button variant="primary" disabled={working} onClick={() => void accept()}>
                {working ? "accepting…" : "accept invitation"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
