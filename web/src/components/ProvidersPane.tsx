import { useEffect, useState } from "react";
import { Copy } from "@phosphor-icons/react";
import { api } from "../api";
import type { ProviderAccount, ProviderCard, ProviderModel } from "../types";
import { agoText, accountLabel, orderCards, stateWord } from "../lib/aiHub";
import { announce } from "../lib/announce";
import { useProviders } from "../lib/useProviders";
import { cn } from "../lib/utils";
import { UsageRow } from "./UsageDialog";
import { Button, Panel, SkeletonRows } from "./ui";

const NO_MODELS = "Models appear after your first chat with it.";
const MODEL_SEARCH_AT = 12;

/** Codex sign-in for the owner: shows the code and link from `codex login --device-auth`, then polls until the browser approval lands. */
function CodexSignIn({ onConnected }: { onConnected: () => void }) {
  const [phase, setPhase] = useState<"idle" | "starting" | "waiting" | "failed">("idle");
  const [login, setLogin] = useState<{ url: string; code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setPhase("starting");
    setError(null);
    api.codexLogin().then(
      (l) => {
        setLogin(l);
        setPhase("waiting");
      },
      (e: Error) => {
        setError(e.message);
        setPhase("failed");
      },
    );
  };

  // Poll every 2 s while waiting; a failed poll is retried, not shown.
  useEffect(() => {
    if (phase !== "waiting") return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      api.codexLoginState().then(
        (s) => {
          if (!alive) return;
          if (s.state === "done") onConnected();
          else if (s.state === "failed") {
            setError(s.error ?? "Sign-in did not finish. Try again.");
            setPhase("failed");
          } else timer = setTimeout(tick, 2000);
        },
        () => {
          if (alive) timer = setTimeout(tick, 2000);
        },
      );
    };
    timer = setTimeout(tick, 2000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [phase, onConnected]);

  const copy = () => {
    if (!login) return;
    void navigator.clipboard?.writeText(login.code);
    announce("Code copied");
  };

  if (phase === "waiting" && login) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-secondary">Open the page, sign in with your ChatGPT account and enter this code.</p>
        <div className="flex flex-wrap items-center gap-3">
          <span className="mono rounded-md bg-surface-sunken px-3 py-2 text-2xl tracking-widest text-text-primary">{login.code}</span>
          <Button variant="secondary" size="sm" onClick={copy}>
            <Copy size={14} aria-hidden="true" />
            Copy
          </Button>
        </div>
        {/^https:\/\//i.test(login.url) ? (
          <a className="text-sm font-medium text-accent underline underline-offset-2" href={login.url} target="_blank" rel="noopener noreferrer">
            Open sign-in page
          </a>
        ) : null}
        <p className="text-xs text-text-muted">Waiting for you to finish in your browser.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {error ? <p className="text-sm text-status-danger">{error}</p> : null}
      <div>
        <Button variant="secondary" size="sm" disabled={phase === "starting"} onClick={start}>
          {phase === "starting" ? "Starting…" : "Sign in to Codex"}
        </Button>
      </div>
    </div>
  );
}

/** "N models" as a native disclosure: a scroll box, a search past 12, grouped by the model's own group. */
function ModelsList({ models }: { models: ProviderModel[] }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? models.filter((m) => `${m.label} ${m.value}`.toLowerCase().includes(q)) : models;
  const groups = new Map<string, ProviderModel[]>();
  for (const m of shown) groups.set(m.group ?? "", [...(groups.get(m.group ?? "") ?? []), m]);
  return (
    <details className="text-sm">
      <summary className="flex min-h-8 cursor-pointer items-center text-text-secondary hover:text-text-primary pointer-coarse:min-h-11">
        {`${models.length} ${models.length === 1 ? "model" : "models"}`}
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
                    <span className="block truncate">{m.label}</span>
                    {m.description ? <span className="block truncate text-text-muted">{m.description}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function AccountBlock({ card, account, owner }: { card: ProviderCard; account: ProviderAccount; owner: boolean }) {
  const label = accountLabel(card, owner) ?? (owner ? account.label : null);
  const plan = owner && account.plan ? account.plan.charAt(0).toUpperCase() + account.plan.slice(1) : null;
  const limited = account.state === "limited";
  // Only Claude and Codex can report plan usage; for the others there is nothing to say.
  const reports = card.id === "claude" || card.id === "codex";
  return (
    <div className="flex flex-col gap-3">
      {label || plan ? <p className="text-sm text-text-primary">{[label, plan].filter(Boolean).join(" · ")}</p> : null}
      {owner && account.usage ? (
        <>
          {account.usage.windows.map((w) => (
            <UsageRow key={w.id} label={w.label} window={w} limited={w.severity === "limit"} />
          ))}
          {account.usage.windows.length === 0 ? <p className="text-xs text-text-muted">Not shown for this plan.</p> : null}
          {account.usage.note ? <p className="text-xs text-text-muted">{account.usage.note}</p> : null}
        </>
      ) : owner && reports ? (
        <p className="text-xs text-text-muted">{limited ? "Limit reached." : "Not shown for this plan."}</p>
      ) : null}
      {account.models.length > 0 ? <ModelsList models={account.models} /> : <p className="text-xs text-text-muted">{NO_MODELS}</p>}
    </div>
  );
}

function ProviderCardView({ card, owner, busy, onRefresh }: { card: ProviderCard; owner: boolean; busy: boolean; onRefresh: () => void }) {
  const usable = card.state === "connected" || card.state === "limited";
  const signIn = card.actions.find((a) => a.kind === "sign_in");
  const hints = card.actions.filter((a) => a.hint && a.kind !== "refresh");
  const codexLogin = owner && card.state === "signed_out" && signIn?.via === "device_code";
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

        {usable && card.accounts.length > 0
          ? card.accounts.map((a) => <AccountBlock key={a.id} card={card} account={a} owner={owner} />)
          : null}

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
            {codexLogin ? <CodexSignIn onConnected={onRefresh} /> : null}
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

/** Settings → AI: every AI on this computer as a card — signed in or not, which account, how much of the plan is used, and its models. Owners can refresh and sign in; others read. */
export default function ProvidersPane({ owner }: { owner: boolean }) {
  const { cards, failed, reload, refresh } = useProviders();
  const [busy, setBusy] = useState<string | "all" | null>(null);
  const [note, setNote] = useState<string | null>(null);

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
      {cards ? orderCards(cards).map((c) => <ProviderCardView key={c.id} card={c} owner={owner} busy={busy === "all" || busy === c.id} onRefresh={() => void check(c.id)} />) : null}
      {note ? <p className="text-sm text-text-secondary">{note}</p> : null}
      {cards ? (
        <div>
          <Button variant="quiet" size="sm" disabled={busy !== null} onClick={() => void check()}>
            {busy === "all" ? "Checking…" : "Check again"}
          </Button>
        </div>
      ) : null}
      <p className="text-xs leading-relaxed text-text-muted">
        {owner
          ? "This shows the AIs signed in on the server. An AI that a member runs under their own computer account may be signed in differently."
          : "This shows which AIs are ready and the models they offer."}
      </p>
    </div>
  );
}
