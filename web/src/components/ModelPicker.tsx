import { useEffect, useRef, useState, type ReactNode } from "react";
import { pickerGroups, type PickerGroup } from "../lib/aiHub";
import { useProviders } from "../lib/useProviders";
import { useCan } from "../store";
import { agentName } from "../lib/agentName";
import { ComposerChip, Menu, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator } from "./ui";

/** A model as the chat's snapshot lists it. */
export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
  supportedEffortLevels: string[];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The Claude model menu's choices: the newest of each family, with a plain line about it. */
const FAMILY_BLURB: Record<string, string> = { opus: "Best for complex work", sonnet: "Best for everyday work", haiku: "Fastest for quick answers" };

/** Which Claude family a model belongs to, from its value or name ("claude-opus-5-5", "Opus 5.5"); undefined for any other. */
function familyOf(m: ModelInfo): string | undefined {
  return /\b(opus|sonnet|haiku)\b/i.exec(`${m.value} ${m.displayName}`)?.[1].toLowerCase();
}

/** A model's version as numbers, from its value or name ("claude-sonnet-4-5" -> [4, 5]); [0] when it has none. */
function versionOf(m: ModelInfo): number[] {
  // A date suffix (claude-opus-4-20250514) is not a minor version: the minor is one or two digits.
  const v = /(\d+)(?:[.-](\d{1,2})(?!\d))?/.exec(m.value) ?? /(\d+)(?:[.-](\d{1,2})(?!\d))?/.exec(m.displayName);
  return v ? [Number(v[1]), Number(v[2] ?? 0)] : [0];
}

/** Whether version a is newer than version b. */
const newerThan = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
};

/** "claude-opus-5-5" -> "Opus 5.5"; a name it does not know is shown as it is. */
export function modelName(id: string): string {
  const m = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d{8})?$/.exec(id);
  if (m) return `${cap(m[1])} ${m[2]}.${m[3]}`;
  return ["opus", "sonnet", "haiku"].includes(id) ? cap(id) : id;
}

/** Models past this many get a search box at the top of the model menu. */
const MODEL_SEARCH_AT = 12;

/** A model's short name for the chip: the last part of its provider path ("openrouter/anthropic/claude-haiku-4.5" -> "claude-haiku-4.5"). */
export const shortModel = (value: string): string => value.slice(value.lastIndexOf("/") + 1);

/** The model menu's choices. Past MODEL_SEARCH_AT models, a search box leads: it filters by name or value. ArrowDown or Tab moves into the list; Enter picks the first match. */
export function ModelChoices({ models, value, onPick, autoFocus = true }: { models: ModelInfo[]; value: string; onPick: (v: string) => void; autoFocus?: boolean }) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const search = models.length > MODEL_SEARCH_AT;
  const q = query.trim().toLowerCase();
  const shown = search && q ? models.filter((m) => `${m.displayName} ${m.value}`.toLowerCase().includes(q)) : models;
  // The menu takes focus when it opens; the search box takes it a frame later.
  useEffect(() => {
    if (!search || !autoFocus) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [search, autoFocus]);
  // The first item of this menu, for the keys that move into the list.
  const firstItem = (el: HTMLElement) => el.closest<HTMLElement>('[role="menu"]')?.querySelector<HTMLElement>('[role="menuitemradio"]');
  return (
    <>
      {search ? (
        <input
          ref={searchRef}
          type="search"
          aria-label="Search models"
          placeholder="Search models"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // The menu's own keys (typeahead, arrows, Tab) would take these: the search box keeps them.
            e.stopPropagation();
            if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
              e.preventDefault();
              firstItem(e.currentTarget)?.focus();
            } else if (e.key === "Enter") {
              e.preventDefault();
              firstItem(e.currentTarget)?.click();
            }
          }}
          className="field-input mx-1 mb-1 block w-[calc(100%-0.5rem)] border-0 bg-surface-base"
        />
      ) : null}
      <div className="max-h-80 overflow-y-auto">
        <MenuRadioGroup value={value} onValueChange={onPick}>
          {shown.map((m) => (
            <MenuRadioItem key={m.value} value={m.value}>
              <span className="block">{m.displayName}</span>
              {m.description ? <span className="block text-xs text-text-muted">{m.description}</span> : null}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </div>
      {search && shown.length === 0 ? <p className="px-2.5 py-1.5 text-small text-text-muted">No model matches "{query}".</p> : null}
    </>
  );
}

/** Claude's model menu: Default, then the newest Opus, Sonnet and Haiku. The other models sit behind "Show older models". */
export function ClaudeModelChoices({ models, value, onPick }: { models: ModelInfo[]; value: string; onPick: (v: string) => void }) {
  const [olderOpen, setOlderOpen] = useState(false);
  const newest = new Map<string, ModelInfo>();
  for (const m of models) {
    const fam = familyOf(m);
    if (!fam) continue;
    const have = newest.get(fam);
    if (!have || newerThan(versionOf(m), versionOf(have))) newest.set(fam, m);
  }
  const choices: { value: string; label: string }[] = [{ value: "default", label: "Default (recommended)" }];
  for (const fam of ["opus", "sonnet", "haiku"]) {
    const m = newest.get(fam);
    if (!m) continue;
    const [major, minor] = versionOf(m);
    const name = major > 0 ? `${cap(fam)} ${major}${minor ? `.${minor}` : ""}` : cap(fam);
    choices.push({ value: m.value, label: `${name} — ${FAMILY_BLURB[fam]}` });
  }
  const chosen = new Set(choices.map((c) => c.value));
  const older = models.filter((m) => !chosen.has(m.value));
  const inMain = choices.some((c) => c.value === value);
  return (
    <>
      <MenuRadioGroup value={inMain ? value : ""} onValueChange={onPick}>
        {choices.map((c) => (
          <MenuRadioItem key={c.value} value={c.value}>
            <span className="block">{c.label}</span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      {older.length > 0 ? (
        <>
          {/* Stays open: the older models list opens inside this menu. */}
          <MenuItem aria-expanded={olderOpen} onSelect={(e) => { e.preventDefault(); setOlderOpen((o) => !o); }} className="text-text-secondary">
            {olderOpen ? "Hide older models" : "Show older models"}
          </MenuItem>
          {olderOpen ? (
            <MenuRadioGroup value={inMain ? "" : value} onValueChange={onPick}>
              {older.map((m) => (
                <MenuRadioItem key={m.value} value={m.value}>
                  <span className="block">{m.displayName}</span>
                  {m.description ? <span className="block text-xs text-text-muted">{m.description}</span> : null}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** The sentence for an AI that has listed no models yet. */
export const NO_MODELS_YET = "Models appear after your first chat with it.";

/** One provider's models as the menu's ModelInfo shape. */
const asModelInfo = (g: PickerGroup): ModelInfo[] =>
  g.models.map((m) => ({ value: m.value, displayName: m.label, description: m.description ?? "", supportedEffortLevels: m.efforts ?? [] }));

interface PickerProps {
  /** The AI this chat talks to, and its name. */
  agent: string;
  /** The chip's text after the AI's name: "Sonnet 5.5". */
  modelText: string;
  /** Today's menu body for the current AI (curated Claude list, effort, search). Built by the chat. */
  currentMenu: ReactNode;
  /** The chat can switch AI (a chat project, not a terminal one). */
  canSwitch: boolean;
  /** The AI is mid-reply: switching waits. */
  busy: boolean;
  /** The menu has nothing to pick from yet (the current AI has not listed its models). */
  noModels: boolean;
  /** Another AI's model was picked: switch to that AI, then choose the model. */
  onPickOther: (agent: string, model: string | null) => void;
}

/** The composer's one picker: "Claude · Sonnet 5.5". Its menu has a heading per connected AI ("Claude · you@example.com"), with that AI's models under it. Desktop and phone differ only in the chip. */
export default function ModelPicker({ agent, modelText, currentMenu, canSwitch, busy, noModels, onPickOther }: PickerProps) {
  const { cards } = useProviders();
  const own = useCan().own;
  const who = agentName(agent);
  const groups = canSwitch && cards ? pickerGroups(cards, own) : [];
  const current = pickerGroups(cards ?? [], own).find((g) => g.id === agent);
  const wait = "Wait until the reply finishes";

  const body = (
    <>
      <MenuLabel>{current?.label ?? who}</MenuLabel>
      {currentMenu}
      {groups
        .filter((g) => g.id !== agent)
        .map((g) => (
          <div key={g.id}>
            <MenuSeparator />
            <MenuLabel>{g.label}</MenuLabel>
            {g.models.length === 0 ? (
              <MenuItem disabled={busy} onSelect={() => onPickOther(g.id, null)}>
                <span className="block">{`Use ${g.name}`}</span>
                <span className="block text-xs text-text-muted">{NO_MODELS_YET}</span>
              </MenuItem>
            ) : (
              <ModelChoices autoFocus={false} models={asModelInfo(g)} value="" onPick={(v) => !busy && onPickOther(g.id, v)} />
            )}
            {busy ? <p className="px-2.5 pb-1.5 text-xs text-text-muted">{wait}</p> : null}
          </div>
        ))}
    </>
  );

  return (
    <>
      <Menu
        side="top"
        align="start"
        label={`AI and model: ${who}, ${modelText}`}
        trigger={
          <ComposerChip
            className="max-w-64 shrink-0 max-md:hidden"
            label={`${who} · ${modelText}`}
            menu
            disabled={noModels && groups.length <= 1}
            title={busy && canSwitch ? "Wait until the reply finishes to switch AI" : undefined}
          />
        }
      >
        {body}
      </Menu>
      {/* Phones: the same menu behind a shorter chip. */}
      <Menu
        side="top"
        align="start"
        label={`AI and model: ${who}, ${modelText}`}
        trigger={
          <ComposerChip
            className="md:hidden min-w-0 max-w-[55%] shrink"
            label={agent === "claude" ? modelText : `${who} · ${modelText}`}
            menu
            disabled={noModels && groups.length <= 1}
            title={busy && canSwitch ? "Wait until the reply finishes to switch AI" : undefined}
          />
        }
      >
        {body}
      </Menu>
    </>
  );
}
