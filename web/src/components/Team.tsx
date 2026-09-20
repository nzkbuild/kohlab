import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowsClockwise,
  Copy,
  Key,
  ShieldWarning,
  Trash,
  UserPlus,
  Users,
} from "@phosphor-icons/react";
import { api, type AuditEvent, type TeamUser } from "../api";
import { announce } from "../lib/announce";
import { clockTime } from "../lib/format";
import { cn } from "../lib/utils";
import ConfirmDialog from "./ConfirmDialog";
import { Button, Field, Panel, PanelHead, SkeletonRows } from "./ui";

/** Static dot colour per audit action — Tailwind cannot read an interpolated class. */
const ACTION_DOT: Record<string, string> = {
  start: "bg-status-running",
  stop: "bg-status-stopped",
  delete: "bg-status-danger",
  commit: "bg-status-committed",
  create: "bg-status-committed",
  clone: "bg-status-committed",
  share: "bg-status-committed",
  "agent.install": "bg-status-review",
  "user.add": "bg-status-committed",
  "user.rm": "bg-status-danger",
  "user.remove": "bg-status-danger",
};

const DOT_FALLBACK = "bg-status-stopped";

/**
 * `/api/users` answers 403 unless the caller is an owner; `/api/audit` needs
 * owner or member. A refusal is a permission state, not a network error, so it
 * is reported as one — and never as a red "something broke".
 */
function refusal(message: string): boolean {
  return /forbidden|not your|unauthorized|permission/i.test(message);
}

const ROLES = ["owner", "member", "viewer"];

/** Team management: members + audit tail, with add/revoke for owners. */
export default function Team() {
  const [users, setUsers] = useState<TeamUser[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("member");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [freshLink, setFreshLink] = useState<{ id: string; name: string; url: string; expires: number } | null>(null);
  /** Whether this server can give a new member their own OS account. */
  const [canInvite, setCanInvite] = useState(true);
  const [busyRole, setBusyRole] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const [revoking, setRevoking] = useState<TeamUser | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const [u, a] = await Promise.all([
      api
        .users()
        .then((res) => ({ ok: true as const, users: res.users, canInvite: res.canInvite }))
        .catch((e: unknown) => ({ ok: false as const, message: (e as Error).message })),
      api
        .audit()
        .then((res) => ({ ok: true as const, events: res.events }))
        .catch((e: unknown) => ({ ok: false as const, message: (e as Error).message })),
    ]);
    if (u.ok) {
      setUsers(u.users);
      setCanInvite(u.canInvite);
      setUsersError(null);
    } else {
      setUsers(null);
      setUsersError(u.message);
    }
    if (a.ok) {
      setAudit(a.events);
      setAuditError(null);
    } else {
      setAuditError(a.message);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const canManage = users !== null;

  /**
   * Invite, rather than mint a key and hand it over. The link carries the
   * credential to the person it is for, and is spent when they open it — nobody
   * has to copy a secret into a chat window.
   */
  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    const userId = id.trim();
    const userName = name.trim();
    if (!userId || !userName || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await api.invite({ id: userId, name: userName, role });
      setFreshLink({
        id: userId,
        name: userName,
        url: `${location.origin}${res.path}`,
        expires: res.expires,
      });
      setId("");
      setName("");
      announce(`invitation created for ${userId}`);
      await load();
    } catch (err) {
      setAddError((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const changeRole = async (u: TeamUser, next: string) => {
    if (busyRole || next === u.role) return;
    setBusyRole(u.id);
    setRoleError(null);
    try {
      await api.setRole(u.id, next);
      announce(`${u.id} is now ${next}`);
      await load();
    } catch (e) {
      setRoleError((e as Error).message);
    } finally {
      setBusyRole(null);
    }
  };

  const revoke = async () => {
    const target = revoking;
    if (!target || revokeBusy) return;
    setRevokeBusy(true);
    setRevokeError(null);
    try {
      await api.removeUser(target.id);
      announce(`revoked ${target.id}`);
      setRevoking(null);
      await load();
    } catch (e) {
      setRevokeError((e as Error).message);
    } finally {
      setRevokeBusy(false);
    }
  };

  const copyLink = async () => {
    if (!freshLink) return;
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(freshLink.url);
      setCopied(true);
      announce(`invitation link for ${freshLink.id} copied`);
    } catch (e) {
      setCopyError((e as Error).message);
    }
  };

  return (
    <Panel className="mt-4">
      <PanelHead
        title="Team"
        icon={<Users size={15} aria-hidden="true" />}
        meta={canManage ? "you are an owner" : "owner-managed"}
      />

      <div className="flex flex-col gap-4 p-4">
        {loading && users === null && audit.length === 0 ? (
          <SkeletonRows rows={3} />
        ) : (
          <>
            {/* ---- members: owner-only ---------------------------------- */}
            {canManage ? (
              <div className="flex flex-col gap-3">
                {users.length === 0 ? (
                  <p className="text-xs leading-relaxed text-text-muted">
                    It is just you. Invite someone and they get their own account on this box — you
                    never see their files, and they never see yours.
                  </p>
                ) : (
                  <table className="data-table w-full">
                    <caption className="sr-only">Members of this server</caption>
                    <thead>
                      <tr>
                        <th scope="col">id</th>
                        <th scope="col">name</th>
                        <th scope="col">role</th>
                        <th scope="col">
                          <span className="sr-only">actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u) => (
                        <tr key={u.id}>
                          <td className="mono text-text-primary">
                            {u.id}
                            {u.pending ? (
                              <span className="chip chip-review ms-2 align-middle">
                                <span className="chip-dot" aria-hidden="true" />
                                invited
                              </span>
                            ) : null}
                          </td>
                          <td className="text-text-secondary">{u.name}</td>
                          <td>
                            <label className="sr-only" htmlFor={`role-${u.id}`}>
                              Role for {u.name} ({u.id})
                            </label>
                            <select
                              id={`role-${u.id}`}
                              className="field-select"
                              value={u.role}
                              disabled={busyRole === u.id}
                              onChange={(e) => void changeRole(u, e.target.value)}
                            >
                              {ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {r === "owner" ? "owner" : r}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="text-end">
                            <Button
                              variant="danger"
                              size="sm"
                              iconOnly
                              aria-label={`Revoke ${u.name} (${u.id})`}
                              title={`Revoke ${u.id}`}
                              onClick={() => {
                                setRevokeError(null);
                                setRevoking(u);
                              }}
                            >
                              <Trash size={13} aria-hidden="true" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {!canInvite ? (
                  <p className="text-2xs leading-relaxed text-status-review">
                    This server cannot create member accounts, so an invited member would share the
                    server&apos;s own account instead of getting their own. Run kohlab as root (the
                    installer&apos;s service unit does) and reload to enable invitations.
                  </p>
                ) : null}
                <form className="flex flex-wrap items-end gap-2" onSubmit={invite}>
                  <Field label="User id" htmlFor="team-user-id" help="also the OS account name">
                    <input
                      id="team-user-id"
                      className="field-input"
                      value={id}
                      autoComplete="off"
                      onChange={(e) => setId(e.target.value)}
                    />
                  </Field>
                  <Field label="Display name" htmlFor="team-user-name">
                    <input
                      id="team-user-name"
                      className="field-input"
                      value={name}
                      autoComplete="off"
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Field>
                  <Field label="Role" htmlFor="team-user-role">
                    <select
                      id="team-user-role"
                      className="field-select"
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Button
                    variant="primary"
                    type="submit"
                    disabled={adding || !canInvite || !id.trim() || !name.trim()}
                  >
                    <UserPlus size={15} weight="bold" aria-hidden="true" />
                    {adding ? "creating…" : "create invitation"}
                  </Button>
                </form>

                {addError ? (
                  <p role="alert" className="break-words text-2xs text-status-danger">
                    could not invite: {addError}
                  </p>
                ) : null}
                {roleError ? (
                  <p role="alert" className="break-words text-2xs text-status-danger">
                    could not change the role: {roleError}
                  </p>
                ) : null}
                {revokeError ? (
                  <p role="alert" className="break-words text-2xs text-status-danger">
                    could not revoke: {revokeError}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <ShieldWarning size={15} className="mt-px shrink-0 text-text-muted" aria-hidden="true" />
                <p className="text-xs leading-relaxed text-text-muted">
                  {usersError && refusal(usersError)
                    ? "Member management needs an owner key — your role can read activity below, but not the member list."
                    : `Could not load members: ${usersError ?? "unknown error"}`}
                  {usersError && !refusal(usersError) ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="ml-2"
                      onClick={() => void load()}
                      disabled={loading}
                    >
                      retry
                    </Button>
                  ) : null}
                </p>
              </div>
            )}

            {/* ---- audit tail: owner + member --------------------------- */}
            <div className="border-t border-line-subtle pt-3">
              <div className="flex items-center gap-2">
                <h3 className="eyebrow">Recent activity</h3>
                <div className="flex-1" />
                <Button
                  variant="quiet"
                  size="sm"
                  iconOnly
                  aria-label="Refresh team and activity"
                  disabled={loading}
                  onClick={() => void load()}
                >
                  <ArrowsClockwise size={14} />
                </Button>
              </div>

              {auditError ? (
                <p role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-2xs text-status-danger">
                  {refusal(auditError)
                    ? "Your role cannot read the audit log."
                    : `Could not load activity: ${auditError}`}
                  <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
                    retry
                  </Button>
                </p>
              ) : audit.length === 0 ? (
                <p className="mt-2 text-xs text-text-muted">No activity recorded yet.</p>
              ) : (
                <ul className="mt-1 max-h-72 overflow-y-auto overscroll-contain">
                  {audit.slice(0, 40).map((e, i) => (
                    <li key={`${e.t}-${i}`} className="log-line -mx-4 text-xs">
                      <span
                        className={cn("chip-dot mt-1.5 shrink-0", ACTION_DOT[e.action] ?? DOT_FALLBACK)}
                        aria-hidden="true"
                      />
                      <span className="log-time">{clockTime(e.t)}</span>
                      <span className="shrink-0 text-text-secondary">{e.user}</span>
                      <span className="mono shrink-0 text-text-primary">{e.action}</span>
                      <span className="log-text text-text-muted">
                        {e.id ?? ""}
                        {e.detail ? ` — ${e.detail}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      {/* One-time link: the token is stored as a hash, so this is the only
          moment it exists in plaintext. */}
      <Dialog.Root open={freshLink !== null} onOpenChange={(open) => !open && setFreshLink(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content p-4">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-text-primary">
              <Key size={16} className="text-status-review" aria-hidden="true" />
              Invitation for {freshLink?.name} ({freshLink?.id})
            </Dialog.Title>
            <Dialog.Description className="mt-1.5 flex items-start gap-1.5 text-xs leading-5 text-status-review">
              <ShieldWarning size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              Send this to them. It works once and expires {freshLink ? new Date(freshLink.expires).toLocaleString() : ""} — the server stores only a hash, so it cannot be shown again. If it is
              lost or already used, invite them again to get a new one.
            </Dialog.Description>
            <code className="mono mt-3 block break-all rounded-md border border-line-strong bg-surface-sunken px-2.5 py-2 text-xs text-text-primary">
              {freshLink?.url}
            </code>
            {copyError ? (
              <p role="alert" className="mt-2 text-2xs text-status-danger">
                copy failed: {copyError}
              </p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => void copyLink()}>
                <Copy size={14} aria-hidden="true" />
                {copied ? "copied" : "copy link"}
              </Button>
              <Dialog.Close asChild>
                <Button variant="primary" size="sm">
                  done
                </Button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.id ?? "member"}?`}
        description={`${revoking?.name ?? ""} (${revoking?.id ?? ""}) loses access immediately: their key stops working and their OS account on this server is deprovisioned. This cannot be undone.`}
        confirmLabel="revoke"
        busy={revokeBusy}
        onConfirm={() => void revoke()}
      />
    </Panel>
  );
}
