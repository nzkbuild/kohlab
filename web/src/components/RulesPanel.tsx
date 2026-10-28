import { useEffect, useState } from "react";
import { api } from "../api";
import type { PermissionRule } from "../types";
import { ruleSource } from "../lib/aiHub";
import { announce } from "../lib/announce";
import { useCan } from "../store";
import { Button, Panel } from "./ui";

type Project = { id: string; name: string; rules: PermissionRule[] };

/** Settings → AI: what each project may do without asking, grouped by project. Remove takes effect after the current reply. Hidden on a server that doesn't list them. */
export default function RulesPanel() {
  const can = useCan().mutate;
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = () =>
    api.aiRules().then(
      (r) => setProjects(r.projects ?? []),
      () => setMissing(true),
    );
  useEffect(() => {
    void load();
  }, []);

  if (missing || projects === null) return null;

  const remove = async (projectId: string, rule: string) => {
    setRemoving(`${projectId}|${rule}`);
    setNote(null);
    try {
      await api.chatControl(projectId, "rule_remove", rule);
      const text = "Removed. If the AI is working, it takes effect after the current reply.";
      setNote(text);
      announce(text);
      await load();
    } catch (e) {
      setNote(`Couldn't remove that. ${e instanceof Error && e.message ? e.message : "Try again."}`);
    } finally {
      setRemoving(null);
    }
  };

  const shown = projects.filter((p) => p.rules.length > 0);
  return (
    <Panel>
      <div className="flex flex-col gap-3 p-4">
        <h3 className="text-base font-medium text-text-primary">Always-allowed actions</h3>
        <p className="text-xs leading-relaxed text-text-muted">Things you chose to allow without being asked each time.</p>
        {shown.length === 0 ? <p className="text-sm text-text-muted">Nothing is allowed without asking yet.</p> : null}
        {shown.map((p) => (
          <div key={p.id} className="flex flex-col gap-1">
            <h4 className="text-xs font-medium text-text-muted">{p.name}</h4>
            <ul aria-label={`Allowed in ${p.name}`} className="flex flex-col gap-1">
              {p.rules.map((r) => (
                <li key={`${r.source}-${r.rule}`} className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm text-text-primary">{r.label}</span>
                    <span className="block text-xs text-text-muted">{ruleSource(r.source)}</span>
                  </span>
                  {r.removable && can ? (
                    <Button variant="quiet" size="sm" className="shrink-0 text-xs text-text-secondary" aria-label={`Remove: ${r.label} in ${p.name}`} disabled={removing !== null} onClick={() => void remove(p.id, r.rule)}>
                      Remove
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {note ? <p role="status" className="text-xs text-text-muted">{note}</p> : null}
      </div>
    </Panel>
  );
}
