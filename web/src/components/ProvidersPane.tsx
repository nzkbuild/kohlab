import { useEffect, useState } from "react";
import { CheckCircle, CircleHalf, DotsThree, MinusCircle } from "@phosphor-icons/react";
import { api } from "../api";
import type { AiUserStatus, OpenCodeConnection, OpenCodeInstall, ProviderAccount, ProviderCard, ProviderModel, RouterCheck } from "../types";
import { agoText, orderCards, stateWord, untilText } from "../lib/aiHub";
import { announce } from "../lib/announce";
import { copyText } from "../lib/clipboard";
import { capabilityTiles, type CapabilityState, type CapabilityTile } from "../lib/capabilities";
import { useProviders } from "../lib/useProviders";
import { cn } from "../lib/utils";
import { AddAccountDialog, RenameAccountDialog, ReplaceKeyDialog, SignInDialog, checkText, freeName, safeMessage, type SignInTarget } from "./AccountDialogs";
import AiDefaultsPanel from "./AiDefaultsPanel";
import ConfirmDialog from "./ConfirmDialog";
import { OpenCodeSignInDialog } from "./OpenCodeDialogs";
import RulesPanel from "./RulesPanel";
import { UsageRow } from "./UsageDialog";
import { Button, Field, Menu, MenuItem, Panel, SkeletonRows } from "./ui";

const NO_MODELS = "Models appear after your first chat with it.";
const MODEL_SEARCH_AT = 12;
/** OpenCode's main account: the AI user's own OpenCode profile. Its routes use this id. */
const MAIN_OPENCODE = "main:opencode";
const OPENCODE_NO_MODELS = "Models appear once an account is connected.";

/** Why a model id or name can't be saved, in a sentence; null when it can. Mirrors the server's limits (id up to 200 characters with no spaces, name up to 60). */
export function modelProblem(id: string | null, name: string): string | null {
  if (id !== null) {
    if (!id.trim()) return "Enter the model's id.";
    if (/\s/.test(id.trim())) return "The id can't have spaces.";
    if (id.trim().length > 200) return "That id is too long.";
  }
  if (name.trim().length > 60) return "Use 60 characters or fewer for the name.";
  return null;
}

/** "N models" as a native disclosure: a scroll box, a search past 12, grouped by the model's own group. The owner can add a model, rename any, and remove the ones added by hand. */
function ModelsList({ models, accountId, owner, onChanged }: { models: ProviderModel[]; accountId: string; owner: boolean; onChanged: () => void }) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const shown = q ? models.filter((m) => `${m.label} ${m.value}`.toLowerCase().includes(q)) : models;
  const groups = new Map<string, ProviderModel[]>();
  for (const m of shown) groups.set(m.group ?? "", [...(groups.get(m.group ?? "") ?? []), m]);

  const run = async (job: () => Promise<unknown>, done: () => void) => {
    setProblem(null);
    try {
      await job();
      done();
      onChanged();
    } catch (e) {
      setProblem(`Couldn't save that. ${e instanceof Error && e.message ? e.message : "Try again."}`);
    }
  };
  const add = () => {
    const bad = modelProblem(newId, newName);
    if (bad) return setProblem(bad);
    void run(() => api.addModel(accountId, newId.trim(), newName.trim() || newId.trim()), () => {
      setAdding(false);
      setNewId("");
      setNewName("");
    });
  };
  const rename = (m: ProviderModel) => {
    if (!draft.trim()) return setProblem("Enter a name.");
    const bad = modelProblem(null, draft);
    if (bad) return setProblem(bad);
    void run(() => api.renameModel(accountId, m.value, draft.trim()), () => setEditing(null));
  };

  return (
    <details className="text-sm">
      <summary className="flex min-h-8 cursor-pointer items-center text-text-secondary hover:text-text-primary pointer-coarse:min-h-11">
        {models.length === 0 ? "No models yet" : `${models.length} ${models.length === 1 ? "model" : "models"}`}
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        {models.length > MODEL_SEARCH_AT ? (
          <input
            type="search"
            aria-label="Search models"
            placeholder="Search models"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="field-input"
          />
        ) : null}
        <div className="max-h-64 overflow-y-auto rounded-lg bg-surface-sunken p-3">
          {shown.length === 0 ? <p className="text-xs text-text-muted">{`No model matches "${query}".`}</p> : null}
          {[...groups].map(([group, list]) => (
            <div key={group} className="mb-2 last:mb-0">
              {group ? <h4 className="mb-1 text-xs font-medium text-text-muted">{group}</h4> : null}
              <ul className="flex flex-col gap-1">
                {list.map((m) => (
                  <li key={m.value} className="min-w-0 text-xs text-text-secondary">
                    {editing === m.value ? (
                      <input
                        autoFocus
                        aria-label={`New name for ${m.label}`}
                        className="field-input"
                        value={draft}
                        maxLength={60}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            rename(m);
                          } else if (e.key === "Escape") {
                            e.stopPropagation();
                            setEditing(null);
                            setProblem(null);
                          }
                        }}
                      />
                    ) : (
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{m.label}</span>
                          {m.custom ? <span className="block truncate text-text-muted">Custom</span> : m.description ? <span className="block truncate text-text-muted">{m.description}</span> : null}
                        </span>
                        {owner ? (
                          <>
                            <Button variant="quiet" size="sm" className="shrink-0 text-xs text-text-secondary" aria-label={`Rename ${m.label}`} onClick={() => { setEditing(m.value); setDraft(m.label); setProblem(null); }}>
                              Rename
                            </Button>
                            {m.custom ? (
                              <Button variant="quiet" size="sm" className="shrink-0 text-xs text-text-secondary" aria-label={`Remove ${m.label}`} onClick={() => void run(() => api.removeModel(accountId, m.value), () => undefined)}>
                                Remove
                              </Button>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {owner ? (
          adding ? (
            <div className="flex flex-col gap-2">
              <Field label="Model id" htmlFor={`add-model-id-${accountId}`} help="The id the AI knows it by, with no spaces.">
                <input id={`add-model-id-${accountId}`} className="field-input" value={newId} autoComplete="off" spellCheck={false} onChange={(e) => setNewId(e.target.value)} />
              </Field>
              <Field label="Name (optional)" htmlFor={`add-model-name-${accountId}`}>
                <input id={`add-model-name-${accountId}`} className="field-input" value={newName} maxLength={60} autoComplete="off" onChange={(e) => setNewName(e.target.value)} />
              </Field>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={add}>
                  Add model
                </Button>
                <Button variant="quiet" size="sm" onClick={() => { setAdding(false); setProblem(null); }}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button variant="quiet" size="sm" className="text-text-secondary" onClick={() => setAdding(true)}>
                Add a model
              </Button>
            </div>
          )
        ) : null}
        {problem ? <p role="status" className="text-xs text-text-secondary">{problem}</p> : null}
      </div>
    </details>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One account of an AI as a row: its name (the main login is "Main account"), its state in words, one action when it is
 * signed out, and a ⋯ menu for the owner: Sign in again, Sign out, Rename and Remove (Remove only for extra accounts).
 */
function AccountBlock({ card, account, owner, onChanged }: { card: ProviderCard; account: ProviderAccount; owner: boolean; onChanged: () => void }) {
  const provider = card.id as SignInTarget["provider"];
  const isAi = card.id === "claude" || card.id === "codex";
  const main = account.id === "default";
  const router = account.kind === "router";
  const signedOut = account.state === "signed_out";
  const limitedUntil = owner && typeof account.limitedUntil === "number" ? account.limitedUntil : null;
  // Only Claude and Codex can report plan usage; for the others there is nothing to say.
  const reports = card.id === "claude" || card.id === "codex";
  const title = main && isAi ? "Main account" : owner ? account.label : null;
  const plan = owner && account.plan ? cap(account.plan) : null;
  const how = !owner ? null : router ? (account.baseUrlHost ? `Router at ${account.baseUrlHost}` : "API key") : account.auth === "api_key" ? "API key" : !signedOut && isAi ? `Signed in with ${card.name}` : null;
  const sub = [owner ? account.email : null, plan, how].filter(Boolean).join(" · ");
  const stateText = signedOut
    ? "Not signed in"
    : account.state === "limited"
      ? limitedUntil !== null
        ? `Limit reached until ${untilText(limitedUntil)}`
        : "Limit reached"
      : account.state === "error"
        ? "Problem"
        : router
          ? "Connected"
          : "Signed in";
  const [testing, setTesting] = useState(false);
  const [check, setCheck] = useState<RouterCheck | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const target: SignInTarget = main ? { provider } : { provider, id: account.id };
  const canSignIn = owner && isAi && !router;
  const canSignOut = canSignIn && !signedOut && (!main || card.actions.some((a) => a.kind === "sign_out"));
  const name = title ?? account.label;
  // The menu only when it has something in it: Sign in again, Sign out, and Rename and Remove for another login.
  const menu = (canSignIn && !signedOut) || canSignOut || !main;

  const test = async () => {
    setTesting(true);
    setCheck(null);
    setProblem(null);
    try {
      setCheck((await api.testAccount(account.id)).check);
    } catch {
      setProblem("Couldn't test it just now. Try again in a moment.");
    } finally {
      setTesting(false);
    }
  };
  const remove = async () => {
    setRemoving(true);
    try {
      await api.removeAccount(account.id);
      announce("Account removed");
      setConfirmRemove(false);
      onChanged();
    } catch (e) {
      setConfirmRemove(false);
      setProblem(`Couldn't remove it. ${e instanceof Error && e.message ? e.message : "Try again."}`);
    } finally {
      setRemoving(false);
    }
  };
  const signOut = async () => {
    setSigningOut(true);
    setProblem(null);
    try {
      if (main) await api.providerSignOut(provider);
      else await api.accountSignOut(account.id);
      announce("Signed out");
      setConfirmOut(false);
      onChanged();
    } catch (e) {
      setConfirmOut(false);
      setProblem(`Couldn't sign out. ${e instanceof Error && e.message ? e.message : "Try again."}`);
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {title ? <p className="text-sm font-medium text-text-primary">{title}</p> : null}
          <p className="text-sm text-text-secondary">{stateText}</p>
          {sub ? <p className="text-xs text-text-muted">{sub}</p> : null}
        </div>
        {owner ? (
          <div className="flex shrink-0 items-center gap-1">
            {canSignIn && signedOut ? (
              <Button variant="secondary" size="sm" onClick={() => setSigningIn(true)}>
                {main ? `Sign in to ${card.name}` : "Sign in"}
              </Button>
            ) : null}
            {menu ? (
              <Menu
                label={`More actions for ${name}`}
                trigger={
                  <Button variant="quiet" size="sm" iconOnly aria-label={`More actions for ${name}`}>
                    <DotsThree size={16} aria-hidden="true" />
                  </Button>
                }
              >
                {canSignIn && !signedOut ? <MenuItem onSelect={() => setSigningIn(true)}>Sign in again</MenuItem> : null}
                {canSignOut ? <MenuItem onSelect={() => setConfirmOut(true)}>Sign out</MenuItem> : null}
                {!main ? <MenuItem onSelect={() => setRenaming(true)}>Rename</MenuItem> : null}
                {!main ? <MenuItem tone="danger" onSelect={() => setConfirmRemove(true)}>Remove</MenuItem> : null}
              </Menu>
            ) : null}
          </div>
        ) : null}
      </div>

      {owner && account.usage ? (
        <>
          {account.usage.windows.map((w) => (
            <UsageRow key={w.id} label={w.label} window={w} limited={w.severity === "limit"} />
          ))}
          {account.usage.windows.length === 0 ? <p className="text-xs text-text-muted">Not shown for this plan.</p> : null}
          {account.usage.note ? <p className="text-xs text-text-muted">{account.usage.note}</p> : null}
        </>
      ) : owner && router ? (
        <p className="text-xs text-text-muted">Usage is on the router's own dashboard.</p>
      ) : owner && reports ? (
        <p className="text-xs text-text-muted">{account.state === "limited" ? "Limit reached." : "Not shown for this plan."}</p>
      ) : null}
      {account.models.length > 0 || owner ? <ModelsList models={account.models} accountId={account.id} owner={owner} onChanged={onChanged} /> : <p className="text-xs text-text-muted">{NO_MODELS}</p>}

      {owner && router ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Button variant="quiet" size="sm" className="text-text-secondary" disabled={testing} onClick={() => void test()}>
            {testing ? "Testing…" : "Test"}
          </Button>
          <Button variant="quiet" size="sm" className="text-text-secondary" onClick={() => setReplacing(true)}>
            Replace key
          </Button>
        </div>
      ) : null}
      {check ? <p role="status" className="text-xs text-text-secondary">{checkText(check)}</p> : null}
      {problem ? <p role="status" className="text-xs text-text-secondary">{problem}</p> : null}
      {owner ? (
        <>
          <ConfirmDialog
            open={confirmRemove}
            onOpenChange={setConfirmRemove}
            title="Remove this account?"
            description={`Kohlab forgets ${account.label}${router ? " and its key" : ""}. Projects that use it go back to the main account.`}
            confirmLabel="Remove"
            busy={removing}
            onConfirm={() => void remove()}
          />
          <ConfirmDialog
            open={confirmOut}
            onOpenChange={setConfirmOut}
            title={`Sign out of ${main ? card.name : account.label}?`}
            description="Chats using it stop until you sign in again."
            confirmLabel="Sign out"
            tone="commit"
            busy={signingOut}
            onConfirm={() => void signOut()}
          />
          {renaming ? <RenameAccountDialog id={account.id} label={account.label} open onOpenChange={(v) => !v && setRenaming(false)} onDone={onChanged} /> : null}
          {signingIn ? <SignInDialog target={target} title={`Sign in to ${main ? card.name : account.label}`} open onOpenChange={(v) => { if (!v) { setSigningIn(false); onChanged(); } }} /> : null}
          {replacing ? <ReplaceKeyDialog id={account.id} label={account.label} open onOpenChange={(v) => !v && setReplacing(false)} /> : null}
        </>
      ) : null}
    </div>
  );
}

/** OpenCode's install: one button, the words while it runs (polled every 2 s), a plain failure with Try again. */
function OpenCodeInstallRow({ onDone }: { onDone: () => void }) {
  const [s, setS] = useState<OpenCodeInstall | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const installing = s?.state === "installing";
  const failed = s?.state === "failed" || problem !== null;
  const start = () => {
    setProblem(null);
    api.opencodeInstall().then(setS, (e) => setProblem(safeMessage(e, "", "Couldn't install OpenCode.")));
  };
  useEffect(() => {
    api.opencodeInstallState().then(setS, () => undefined);
  }, []);
  useEffect(() => {
    if (!installing) return;
    let alive = true;
    const t = window.setTimeout(() => {
      api.opencodeInstallState().then((r) => alive && setS(r), () => undefined);
    }, 2000);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [installing, s]);
  useEffect(() => {
    if (s?.state !== "done") return;
    announce("OpenCode is installed");
    onDone();
  }, [s?.state]);

  return (
    <div className="flex flex-col items-start gap-2">
      {installing ? <p role="status" className="text-sm text-text-primary">Installing… this takes a minute.</p> : null}
      {failed ? <p role="status" className="text-sm text-text-secondary">{`Couldn't install OpenCode.${s?.error ? ` ${s.error}` : ""}`}</p> : null}
      {!installing ? (
        <Button variant={failed ? "secondary" : "primary"} size="sm" onClick={start}>
          {failed ? "Try again" : "Install OpenCode"}
        </Button>
      ) : null}
    </div>
  );
}

/** Another OpenCode account: an empty profile named "Account N". Signing it in is the row's own Sign in. */
function OpenCodeAddAccount({ card, onRefresh }: { card: ProviderCard; onRefresh: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const add = async () => {
    setProblem(null);
    try {
      await api.addAccount({ provider: "opencode", kind: "login", label: freeName(card.accounts.map((a) => a.label)) });
      announce("Account added");
      onRefresh();
    } catch (e) {
      setProblem(safeMessage(e, "", "Couldn't add that account."));
    }
  };
  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="quiet" size="sm" className="text-text-secondary" onClick={() => void add()}>
        Add another OpenCode account
      </Button>
      {problem ? <p role="status" className="text-xs text-text-secondary">{problem}</p> : null}
    </div>
  );
}

/**
 * One OpenCode account (owner): its name, Signed in or Not signed in, its connections as rows (each with Use this one and
 * Sign out), and a ⋯ menu for Add a connection, Rename and Remove (Remove and Rename only for extra accounts).
 */
function OpenCodeAccountBlock({ account, onChanged }: { account: ProviderAccount; onChanged: () => void }) {
  const main = account.id === "default" || account.id === MAIN_OPENCODE;
  const routeId = main ? MAIN_OPENCODE : account.id;
  const connections = account.connections ?? [];
  const signedOut = account.state === "signed_out";
  const title = main ? "Main account" : account.label;
  // The dialog keeps the title it opened with: the state changes under it when a sign-in finishes.
  const [signing, setSigning] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmOut, setConfirmOut] = useState<OpenCodeConnection | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fail = (what: string, e: unknown) => setProblem(safeMessage(e, "", what));
  const openSignIn = () => setSigning(`${signedOut ? "Sign in to" : "Add a connection to"} ${main ? "OpenCode" : account.label}`);

  const switchTo = async (c: OpenCodeConnection) => {
    setProblem(null);
    try {
      await api.opencodeSwitch(routeId, c.integration, c.label);
      announce("Switched");
      onChanged();
    } catch (e) {
      fail("Couldn't switch to that one.", e);
    }
  };
  const logout = async () => {
    if (!confirmOut) return;
    setSigningOut(true);
    try {
      await api.opencodeLogout(routeId, confirmOut.integration, confirmOut.label);
      announce("Signed out");
      setConfirmOut(null);
      onChanged();
    } catch (e) {
      setConfirmOut(null);
      fail("Couldn't sign out.", e);
    } finally {
      setSigningOut(false);
    }
  };
  const remove = async () => {
    setRemoving(true);
    try {
      await api.removeAccount(account.id);
      announce("Account removed");
      setConfirmRemove(false);
      onChanged();
    } catch (e) {
      setConfirmRemove(false);
      fail("Couldn't remove it.", e);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">{title}</p>
          <p className="text-sm text-text-secondary">{signedOut ? "Not signed in" : "Signed in"}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {signedOut ? (
            <Button variant="secondary" size="sm" onClick={openSignIn}>
              Sign in
            </Button>
          ) : null}
          {!signedOut || !main ? (
            <Menu
              label={`More actions for ${title}`}
              trigger={
                <Button variant="quiet" size="sm" iconOnly aria-label={`More actions for ${title}`}>
                  <DotsThree size={16} aria-hidden="true" />
                </Button>
              }
            >
              {!signedOut ? <MenuItem onSelect={openSignIn}>Add a connection</MenuItem> : null}
              {!main ? <MenuItem onSelect={() => setRenaming(true)}>Rename</MenuItem> : null}
              {!main ? <MenuItem tone="danger" onSelect={() => setConfirmRemove(true)}>Remove</MenuItem> : null}
            </Menu>
          ) : null}
        </div>
      </div>

      {connections.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {connections.map((c) => (
            <li key={`${c.integration}:${c.label}`} className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 text-sm text-text-secondary">{`${c.name} — ${c.label}${c.active ? " — Active" : ""}`}</p>
              <Menu
                label={`More actions for ${c.name} ${c.label}`}
                trigger={
                  <Button variant="quiet" size="sm" iconOnly aria-label={`More actions for ${c.name} ${c.label}`}>
                    <DotsThree size={16} aria-hidden="true" />
                  </Button>
                }
              >
                {!c.active ? <MenuItem onSelect={() => void switchTo(c)}>Use this one</MenuItem> : null}
                <MenuItem onSelect={() => setConfirmOut(c)}>Sign out</MenuItem>
              </Menu>
            </li>
          ))}
        </ul>
      ) : null}

      {account.models.length > 0 ? <ModelsList models={account.models} accountId={routeId} owner={false} onChanged={onChanged} /> : <p className="text-xs text-text-muted">{OPENCODE_NO_MODELS}</p>}
      {problem ? <p role="status" className="text-xs text-text-secondary">{problem}</p> : null}

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove this account?"
        description={`Kohlab forgets ${account.label}. Projects that use it go back to the main account.`}
        confirmLabel="Remove"
        busy={removing}
        onConfirm={() => void remove()}
      />
      <ConfirmDialog
        open={confirmOut !== null}
        onOpenChange={(v) => !v && setConfirmOut(null)}
        title={`Sign out of ${confirmOut?.name ?? ""}?`}
        description="Chats using it stop until you sign in again."
        confirmLabel="Sign out"
        tone="commit"
        busy={signingOut}
        onConfirm={() => void logout()}
      />
      {renaming ? <RenameAccountDialog id={account.id} label={account.label} open onOpenChange={(v) => !v && setRenaming(false)} onDone={onChanged} /> : null}
      {signing !== null ? <OpenCodeSignInDialog accountId={routeId} title={signing} open onOpenChange={(v) => !v && setSigning(null)} onDone={onChanged} /> : null}
    </div>
  );
}

/** A status tile's word for an AI. Words, not colour alone (SC 1.4.1). */
function tileWord(card: ProviderCard): string {
  if (card.state === "not_installed") return "Not installed";
  if (card.state === "limited") return "Limit reached";
  if (card.state === "connected") return "Signed in";
  if (card.state === "checking") return "Checking";
  if (card.state === "error") return "Problem";
  return "Not signed in";
}

/** One button per AI at the top of Settings → AI. The chosen one is shown below; the accent marks the choice. */
function StatusTiles({ cards, selected, onSelect }: { cards: ProviderCard[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div role="group" aria-label="Your AIs" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((c) => {
        const on = c.id === selected;
        const n = c.accounts.length;
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={on}
            onClick={() => onSelect(c.id)}
            className={cn(
              "flex min-h-11 min-w-0 flex-col items-start gap-0.5 rounded-card p-3 text-left",
              on ? "bg-accent-soft text-on-accent-soft" : "bg-surface-raised text-text-primary hover:bg-surface-active",
            )}
          >
            <span className="w-full truncate text-sm font-medium">{c.name}</span>
            <span className="text-xs">{tileWord(c)}</span>
            {n > 0 ? <span className="text-xs">{n === 1 ? "1 account" : `${n} accounts`}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

const STATE_WORD_TILE: Record<CapabilityState, string> = { yes: "Yes", depends: "Depends", summary: "Summary only", no: "No" };
const STATE_ICON_TILE: Record<CapabilityState, typeof CheckCircle> = { yes: CheckCircle, depends: CircleHalf, summary: CircleHalf, no: MinusCircle };

/** The "What it can do" tiles: each one a state word with its icon, and the code's own plain sentence. */
function CapabilityGrid({ tiles }: { tiles: CapabilityTile[] }) {
  if (tiles.length === 0) return null;
  return (
    <section aria-label="What it can do" className="flex flex-col gap-2">
      <h4 className="text-xs font-medium text-text-muted">What it can do</h4>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {tiles.map((t) => {
          const Icon = STATE_ICON_TILE[t.state];
          const on = t.state === "yes";
          return (
            <li key={t.id} className="flex min-w-0 flex-col gap-1 rounded-card bg-surface-base p-3">
              <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <Icon size={16} aria-hidden="true" className={cn("shrink-0", on ? "text-accent" : "text-text-muted")} />
                {t.title}
              </span>
              <span className="text-xs font-medium text-text-secondary">{STATE_WORD_TILE[t.state]}</span>
              <span className="text-xs leading-relaxed text-text-muted">{t.detail}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ProviderCardView({ card, owner, busy, onRefresh }: { card: ProviderCard; owner: boolean; busy: boolean; onRefresh: () => void }) {
  const usable = card.state === "connected" || card.state === "limited";
  const isAi = card.id === "claude" || card.id === "codex";
  const isOpenCode = card.id === "opencode";
  const hints = card.actions.filter((a) => a.hint && a.kind !== "refresh");
  // Signed out: the rows still show every login, the main one included, so each can be signed in or removed.
  const rows = usable || (owner && card.state === "signed_out") ? card.accounts : [];
  const [adding, setAdding] = useState(false);
  const accountRow = (a: ProviderAccount) =>
    isOpenCode && owner ? (
      <OpenCodeAccountBlock key={a.id} account={a} onChanged={onRefresh} />
    ) : (
      <AccountBlock key={a.id} card={card} account={a} owner={owner} onChanged={onRefresh} />
    );
  const canAdd = owner && card.installed && (isAi || isOpenCode) && card.state !== "not_installed" && card.state !== "checking";
  return (
    <Panel>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-medium text-text-primary">
            {card.name}
            {owner && card.version ? <span className="ml-2 text-xs font-normal text-text-muted">{card.version}</span> : null}
          </h3>
          <span className={cn("chip", card.state === "connected" ? "chip-running" : "chip-stopped")}>
            {card.state === "connected" ? <span className="chip-dot" aria-hidden="true" /> : null}
            {stateWord(card.state)}
          </span>
        </div>

        <CapabilityGrid tiles={capabilityTiles(card, card.accounts.flatMap((a) => a.models))} />

        {rows.slice(0, 1).map(accountRow)}
        {rows.length > 3 ? (
          <details className="flex flex-col gap-4">
            <summary className="cursor-pointer [@media(pointer:coarse)]:min-h-11 text-sm text-text-secondary [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center">{rows.length - 1} more accounts</summary>
            <div className="flex flex-col gap-4">{rows.slice(1).map(accountRow)}</div>
          </details>
        ) : (
          rows.slice(1).map(accountRow)
        )}

        {card.state === "error" && owner ? (
          <p className="text-sm text-text-secondary">{card.error?.message ?? "Kohlab could not check this AI just now."}</p>
        ) : null}
        {card.state === "checking" ? <p className="text-sm text-text-secondary">Checking this AI.</p> : null}
        {!owner && card.state === "signed_out" ? <p className="text-sm text-text-secondary">Ask the owner to sign in to {card.name}.</p> : null}
        {!owner && card.state === "not_installed" ? <p className="text-sm text-text-secondary">{card.name} is not set up on this computer.</p> : null}

        {owner ? (
          <>
            {hints.map((a) => (
              <p key={`${a.kind}-${a.label}`} className="text-sm text-text-secondary">
                {a.hint}
              </p>
            ))}
            {isOpenCode && card.state === "not_installed" ? <OpenCodeInstallRow onDone={onRefresh} /> : null}
            {canAdd && isOpenCode ? <OpenCodeAddAccount card={card} onRefresh={onRefresh} /> : null}
            {canAdd && !isOpenCode ? (
              <div>
                <Button variant="quiet" size="sm" className="text-text-secondary" onClick={() => setAdding(true)}>
                  {card.id === "codex" ? "Add another Codex login" : "Add another Claude account"}
                </Button>
              </div>
            ) : null}
            {adding ? (
              <AddAccountDialog
                provider={card.id as "claude" | "codex"}
                name={card.name}
                open
                onOpenChange={(v) => {
                  if (!v) {
                    setAdding(false);
                    onRefresh();
                  }
                }}
              />
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button variant="secondary" size="sm" disabled={busy} onClick={onRefresh}>
                {busy ? "Checking…" : card.state === "error" ? "Try again" : "Refresh"}
              </Button>
              <span className="text-xs text-text-muted">
                {card.checkedAt > 0 ? `Last checked ${agoText(card.checkedAt)}.` : ""}
                {card.stale ? " Showing the last result." : ""}
              </span>
            </div>
          </>
        ) : null}
      </div>
    </Panel>
  );
}

/** Owner only: says plainly when the AI runs as the server's own account (root), or its account is missing. */
function AiUserNotice({ owner }: { owner: boolean }) {
  const [aiUser, setAiUser] = useState<AiUserStatus | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!owner) return;
    let alive = true;
    api
      .agentsStatus()
      .then((s) => {
        if (alive) setAiUser(s.aiUser ?? null);
      })
      .catch(() => {
        /* no notice when the status cannot be read */
      });
    return () => {
      alive = false;
    };
  }, [owner]);
  if (!owner || !aiUser || (aiUser.mode !== "root" && aiUser.mode !== "missing")) return null;
  const command = "kohlab ai-user setup";
  const text =
    aiUser.mode === "missing"
      ? `The AI user '${aiUser.name}' is missing.`
      : "Your AI runs as the server's own account (root), so it can change anything on this computer.";
  const copy = () => {
    copyText(command).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <Panel>
      <div className="flex flex-col items-start gap-3 p-4" role="status">
        <p className="text-sm text-text-secondary">{text}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-text-secondary">Fix it:</span>
          <Button size="sm" variant="secondary" onClick={copy} aria-label={`Copy the command ${command}`}>
            <code>{command}</code>
            {copied ? " (copied)" : " Copy"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/** Settings → AI: every AI on this computer as a card — signed in or not, which account, how much of the plan is used, and its models. Owners can refresh and sign in; others read. */
export default function ProvidersPane({ owner }: { owner: boolean }) {
  const { cards, failed, reload, refresh } = useProviders();
  const [busy, setBusy] = useState<string | "all" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const shown = cards ? orderCards(cards) : null;
  // The AI shown below: the one picked, else the first (orderCards puts the usable ones first).
  const current = shown?.find((c) => c.id === picked) ?? shown?.[0] ?? null;

  // Read again every minute while this pane is open. Nothing runs once it closes.
  useEffect(() => {
    const t = window.setInterval(() => void reload(), 60_000);
    return () => window.clearInterval(t);
  }, [reload]);

  const check = async (id?: string) => {
    setBusy(id ?? "all");
    setNote(null);
    const ok = owner ? await refresh(id) : (await reload(), true);
    if (!ok) setNote("Could not check right now. Try again in a moment.");
    setBusy(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <AiUserNotice owner={owner} />
      <AiDefaultsPanel owner={owner} />
      {cards === null && !failed ? (
        <Panel>
          <SkeletonRows rows={3} />
        </Panel>
      ) : null}
      {cards === null && failed ? (
        <Panel>
          <div className="flex flex-col items-start gap-3 p-4">
            <p className="text-sm text-text-secondary">Could not check the AIs right now. Try again in a moment.</p>
            <Button variant="secondary" size="sm" onClick={() => void reload()}>
              Try again
            </Button>
          </div>
        </Panel>
      ) : null}
      {shown ? <StatusTiles cards={shown} selected={current?.id ?? null} onSelect={setPicked} /> : null}
      {current ? <ProviderCardView key={current.id} card={current} owner={owner} busy={busy === "all" || busy === current.id} onRefresh={() => void check(current.id)} /> : null}
      {cards ? <RulesPanel /> : null}
      {note ? <p className="text-sm text-text-secondary">{note}</p> : null}
      {cards ? (
        <div>
          <Button variant="quiet" size="sm" disabled={busy !== null} onClick={() => void check()}>
            {busy === "all" ? "Checking…" : "Check again"}
          </Button>
        </div>
      ) : null}
      <p className="text-xs leading-relaxed text-text-muted">At a limit, Kohlab can switch to another account or a cheaper model. Set the order in a project's Run panel.</p>
      <p className="text-xs leading-relaxed text-text-muted">
        {owner
          ? "Shows the AIs signed in on the server. A member's own computer account may differ."
          : "Which AIs are ready, and their models."}
      </p>
    </div>
  );
}
