import { useState, type ReactNode } from "react";
import { api, type TeamAction, type TeamState } from "../../api";
import { EFFORT_CHOICES, EFFORT_LABEL, MODE_LABEL, accountLabel, isUsable } from "../../lib/aiHub";
import { announce } from "../../lib/announce";
import { useProviders } from "../../lib/useProviders";
import type { Mode } from "../../types";
import type { TeamRole } from "../../team-types";
import { AccountChoices, EffortChoices, FullAccessDialog, ModeChoices } from "../AiMenus";
import { ModelChoices, modelName, type ModelInfo } from "../ModelPicker";
import { Button, ComposerChip, Dialog, Field, Menu } from "../ui";

/** The most a person may write for a team's goal. The server holds the same limit. */
export const GOAL_MAX = 2000;

type RolePatch = Omit<Extract<TeamAction, { action: "role" }>, "action" | "role">;

/** One setting: its name, and its value as a menu. The same row as Settings → AI's defaults. */
function Row({ label, value, menu }: { label: string; value: string; menu: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2 pointer-coarse:min-h-11">
      <span className="w-24 shrink-0 text-sm text-text-secondary">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <Menu label={`${label}: ${value}`} align="start" trigger={<ComposerChip className="-ml-2.5 max-w-full" label={value} menu />}>
          {menu}
        </Menu>
      </div>
    </div>
  );
}

/** Change one agent's AI account, model, effort or mode. Each change saves on its own; the server decides what the agent may do. */
export function RoleDialog({
  open,
  onOpenChange,
  workspaceId,
  role,
  owner,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId: string;
  role: TeamRole;
  owner: boolean;
  onChanged: (r: TeamState) => void;
}) {
  const { cards } = useProviders();
  const [error, setError] = useState<string | null>(null);
  const [askFull, setAskFull] = useState(false);

  const claude = (cards ?? []).find((c) => c.id === "claude" && isUsable(c));
  const accounts = (claude?.accounts ?? []).filter((a) => a.state !== "signed_out" && a.state !== "error");
  const account = accounts.find((a) => a.id === (role.account ?? "default")) ?? accounts[0];
  const offered: ModelInfo[] = (account?.models ?? []).map((m) => ({
    value: m.value,
    displayName: m.label,
    description: m.custom ? "Custom" : (m.description ?? ""),
    supportedEffortLevels: m.efforts ?? [],
  }));
  const modelText = role.model ? (offered.find((m) => m.value === role.model)?.displayName ?? modelName(role.model)) : "Default";
  const accountText = claude && account ? (accountLabel(claude, owner, account) ?? "Main account") : "Main account";

  const save = async (patch: RolePatch) => {
    setError(null);
    try {
      onChanged(await api.teamAction(workspaceId, { action: "role", role: role.id, ...patch }));
      announce("Saved");
    } catch (e) {
      setError(`Couldn't save that. ${e instanceof Error && e.message ? e.message : "Try again."}`);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content p-5">
          <Dialog.Title className="text-base font-semibold text-text-primary">{`Change ${role.name}`}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm leading-5 text-text-muted">Each change saves on its own.</Dialog.Description>
          <div className="mt-4 flex flex-col">
            {accounts.length > 1 ? (
              <Row
                label="Account"
                value={accountText}
                menu={<AccountChoices accounts={accounts} value={account?.id ?? "default"} busy={false} onPick={(id) => void save({ account: id })} />}
              />
            ) : null}
            <Row label="Model" value={modelText} menu={<ModelChoices models={offered} value={role.model ?? ""} onPick={(v) => void save({ model: v })} />} />
            <Row
              label="Effort"
              value={role.effort ? (EFFORT_LABEL[role.effort] ?? role.effort) : "Default"}
              menu={<EffortChoices value={role.effort ?? null} levels={EFFORT_CHOICES} onPick={(v) => void save({ effort: v as TeamRole["effort"] })} />}
            />
            <Row
              label="Mode"
              value={MODE_LABEL[role.mode] ?? MODE_LABEL.default}
              menu={<ModeChoices value={role.mode} isClaude onPick={(v) => (v === "full" && role.mode !== "full" ? setAskFull(true) : void save({ mode: v as Mode }))} />}
            />
          </div>
          {error ? (
            <p role="status" className="mt-3 text-sm text-text-secondary">
              {error}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end">
            <Dialog.Close asChild>
              <Button variant="quiet">Done</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      <FullAccessDialog
        open={askFull}
        onOpenChange={setAskFull}
        onConfirm={() => {
          setAskFull(false);
          void save({ mode: "full" });
        }}
      />
    </Dialog.Root>
  );
}

/** Start a team on this project: the goal, how many agents work at once, and what it costs. The one preset is the small team. */
export function StartTeamDialog({
  open,
  onOpenChange,
  workspaceId,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId: string;
  onStarted: (r: TeamState) => void;
}) {
  const [goal, setGoal] = useState("");
  const [maxAgents, setMaxAgents] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    const text = goal.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.teamAction(workspaceId, { action: "start", goal: text, maxAgents, gate: "final", builders: 2, reviewer: true, tester: false });
      onStarted(r);
      setGoal("");
      onOpenChange(false);
      announce("Team started");
    } catch (e) {
      setError(`Couldn't start the team. ${e instanceof Error && e.message ? e.message : "Try again."}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content p-5">
          <Dialog.Title className="text-base font-semibold text-text-primary">Work as a team</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm leading-5 text-text-muted">
            A Lead plans the work, Builders make the changes and a Reviewer checks each one. Nothing reaches your project until you bring it in.
          </Dialog.Description>
          <form
            className="mt-4 flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <Field label="What should the team build?" htmlFor="team-goal">
              <textarea
                id="team-goal"
                className="field-textarea min-h-28 resize-y"
                rows={4}
                maxLength={GOAL_MAX}
                value={goal}
                autoFocus
                onChange={(e) => setGoal(e.target.value)}
              />
            </Field>
            <p className="text-sm text-text-secondary">Small team: a Lead, two Builders and a Reviewer.</p>
            <Field label="Agents at once" htmlFor="team-max" help="At most this many agents work at the same time.">
              <select id="team-max" className="field-select" value={maxAgents} onChange={(e) => setMaxAgents(Number(e.target.value))}>
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <p className="text-xs leading-5 text-text-muted">Teams use more of your plan than one chat.</p>
            {error ? (
              <p role="status" className="text-sm text-text-secondary">
                {error}
              </p>
            ) : null}
            <div className="mt-1 flex items-center justify-end gap-2">
              <Dialog.Close asChild>
                <Button variant="quiet">Cancel</Button>
              </Dialog.Close>
              <Button variant="primary" type="submit" disabled={busy || goal.trim() === ""}>
                Start team
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
