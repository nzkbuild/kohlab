import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import type { AiDefaults, ProviderCard } from "../types";
import { EFFORT_LABEL, MODE_LABEL, isUsable } from "../lib/aiHub";
import { agentName } from "../lib/agentName";
import { announce } from "../lib/announce";
import { useProviders } from "../lib/useProviders";
import { AccountChoices, EffortChoices, FullAccessDialog, ModeChoices } from "./AiMenus";
import { ModelChoices, modelName, shortModel, type ModelInfo } from "./ModelPicker";
import { Button, ComposerChip, Menu, MenuRadioGroup, MenuRadioItem, Panel } from "./ui";

type Patch = { [K in keyof AiDefaults]?: AiDefaults[K] | null };

/** One default: its name, its value (a menu for the owner, plain words for everyone else), and "Use built-in" once a value is set. */
function Row({ label, value, menu, canEdit, isSet, onClear }: { label: string; value: string; menu: ReactNode; canEdit: boolean; isSet: boolean; onClear: () => void }) {
  return (
    <div className="flex min-h-8 items-center gap-2 pointer-coarse:min-h-11">
      <span className="w-24 shrink-0 text-sm text-text-secondary">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {canEdit ? (
          <Menu label={`${label}: ${value}`} align="start" trigger={<ComposerChip className="-ml-2.5 max-w-full" label={value} menu />}>
            {menu}
          </Menu>
        ) : (
          <span className="min-w-0 truncate text-sm text-text-primary">{value}</span>
        )}
        {canEdit && isSet ? (
          <Button variant="quiet" size="sm" className="shrink-0 text-xs text-text-secondary" aria-label={`Use the built-in ${label.toLowerCase()}`} onClick={onClear}>
            Use built-in
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Settings → AI, first: what a new project starts with. Each change saves on its own. The owner edits; everyone else reads. Hidden on a server that has no defaults yet. */
export default function AiDefaultsPanel({ owner }: { owner: boolean }) {
  const { cards } = useProviders();
  const [defaults, setDefaults] = useState<AiDefaults | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askFull, setAskFull] = useState(false);

  useEffect(() => {
    let alive = true;
    api.aiDefaults().then(
      (r) => alive && setDefaults(r.defaults ?? {}),
      () => alive && setMissing(true),
    );
    return () => {
      alive = false;
    };
  }, []);

  if (missing || defaults === null) return null;

  const save = async (patch: Patch) => {
    setError(null);
    try {
      const r = await api.setAiDefaults(patch);
      setDefaults(r.defaults ?? {});
      announce("Saved");
    } catch (e) {
      setError(`Couldn't save that. ${e instanceof Error && e.message ? e.message : "Try again."}`);
    }
  };

  const usable: ProviderCard[] = (cards ?? []).filter(isUsable);
  const agent = defaults.agent ?? "claude";
  const card = usable.find((c) => c.id === agent);
  const accounts = (card?.accounts ?? []).filter((a) => a.state !== "signed_out" && a.state !== "error");
  const account = accounts.find((a) => a.id === (defaults.account ?? "default")) ?? accounts[0];
  const isClaude = agent === "claude";
  const offered: ModelInfo[] = [
    { value: "default", displayName: "Default (recommended)", description: "", supportedEffortLevels: [] },
    ...(account?.models ?? []).filter((m) => m.value !== "default").map((m) => ({ value: m.value, displayName: m.label, description: m.custom ? "Custom" : (m.description ?? ""), supportedEffortLevels: m.efforts ?? [] })),
  ];
  const modelValue = defaults.model ?? "default";
  const modelText = modelValue === "default" ? "Default" : (offered.find((m) => m.value === modelValue)?.displayName ?? (isClaude ? modelName(modelValue) : shortModel(modelValue)));
  const accountText = account ? (account.id === "default" ? (owner ? (account.email ?? "Main account") : "Main account") : account.label) : "Main account";
  const mode = defaults.mode ?? "default";
  const autoFresh = defaults.autoFresh !== false;

  return (
    <Panel>
      <div className="flex flex-col gap-3 p-4">
        <h3 className="text-base font-medium text-text-primary">Defaults for new projects</h3>
        <p className="text-xs leading-relaxed text-text-muted">Projects start with these. A project can set its own.</p>

        <div className="flex flex-col">
          <Row
            label="AI"
            value={agentName(agent)}
            canEdit={owner}
            isSet={defaults.agent !== undefined}
            onClear={() => void save({ agent: null, account: null })}
            menu={
              <MenuRadioGroup value={agent} onValueChange={(v) => void save({ agent: v, account: null, model: null })}>
                {usable.map((c) => (
                  <MenuRadioItem key={c.id} value={c.id}>
                    {c.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            }
          />
          {accounts.length > 1 ? (
            <Row
              label="Account"
              value={accountText}
              canEdit={owner}
              isSet={defaults.account !== undefined}
              onClear={() => void save({ account: null })}
              menu={<AccountChoices accounts={accounts} value={account?.id ?? "default"} busy={false} onPick={(id) => void save({ account: id, model: null })} />}
            />
          ) : null}
          <Row
            label="Model"
            value={modelText}
            canEdit={owner}
            isSet={defaults.model !== undefined}
            onClear={() => void save({ model: null })}
            menu={<ModelChoices models={offered} value={modelValue} onPick={(v) => void save({ model: v })} />}
          />
          <Row
            label="Effort"
            value={defaults.effort ? (EFFORT_LABEL[defaults.effort] ?? defaults.effort) : "Default"}
            canEdit={owner}
            isSet={defaults.effort !== undefined}
            onClear={() => void save({ effort: null })}
            menu={<EffortChoices value={defaults.effort ?? null} onPick={(v) => void save({ effort: v as AiDefaults["effort"] })} />}
          />
          <Row
            label="Mode"
            value={MODE_LABEL[mode] ?? MODE_LABEL.default}
            canEdit={owner}
            isSet={defaults.mode !== undefined}
            onClear={() => void save({ mode: null })}
            menu={<ModeChoices value={mode} isClaude={isClaude} onPick={(v) => (v === "full" && mode !== "full" ? setAskFull(true) : void save({ mode: v as AiDefaults["mode"] }))} />}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-h-8 cursor-pointer items-start gap-3 pointer-coarse:min-h-11" htmlFor="default-auto-fresh">
            <input
              id="default-auto-fresh"
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-accent"
              checked={autoFresh}
              disabled={!owner}
              onChange={(e) => void save({ autoFresh: e.target.checked })}
            />
            <span className="text-sm text-text-primary">Continue fresh automatically</span>
          </label>
          {owner && defaults.autoFresh !== undefined ? (
            <Button variant="quiet" size="sm" className="text-xs text-text-secondary" aria-label="Use the built-in choice for continue fresh" onClick={() => void save({ autoFresh: null })}>
              Use built-in
            </Button>
          ) : null}
        </div>

        {error ? <p role="status" className="text-sm text-text-secondary">{error}</p> : null}
        {!owner ? <p className="text-xs text-text-muted">Only the owner can change these.</p> : null}
      </div>
      <FullAccessDialog
        open={askFull}
        onOpenChange={setAskFull}
        onConfirm={() => {
          setAskFull(false);
          void save({ mode: "full" });
        }}
      />
    </Panel>
  );
}
