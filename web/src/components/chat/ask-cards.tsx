/** Ask cards: questions and plans, and their answered forms. */
import { useContext, useState } from "react";
import { Check, X } from "@phosphor-icons/react";
import { cn } from "../../lib/utils";
import { Button } from "../ui";
import { ChatEvent, AskEvent } from "./types";
import { AgentCtx } from "./contexts";
import { Prose } from "./markdown";
import { Details } from "./tools";

/** Allow and Don't allow: the same width, and tall enough to tap on a touch screen. */
export const ASK_BUTTON = "min-w-[8rem] justify-center [@media(pointer:coarse)]:min-h-11";

/** The question Claude asked, and the answer, once given: one muted line. A plan keeps its text behind "Show plan". */
export function AnsweredAsk({ e, allowed, reply }: { e: AskEvent; allowed: boolean; reply?: string }) {
  const who = useContext(AgentCtx);
  const Icon = allowed ? Check : X;
  if (e.form === "question") {
    const said = allowed ? (reply ? `You answered: ${reply}` : `You answered ${who}'s question`) : `You skipped ${who}'s question`;
    return (
      <div className="text-small text-text-muted">
        <p className="flex items-start gap-2">
          <Icon size={14} className="mt-[5px] shrink-0" aria-hidden="true" />
          <span className="min-w-0">{said}</span>
        </p>
      </div>
    );
  }
  if (e.form === "plan") {
    const said = allowed ? "You approved the plan" : reply ? `You asked for changes: ${reply}` : "You didn't approve the plan";
    return (
      <div className="text-small text-text-muted">
        <p className="flex items-start gap-2">
          <Icon size={14} className="mt-[5px] shrink-0" aria-hidden="true" />
          <span className="min-w-0">{said}</span>
        </p>
        <details className="ml-5 text-sm text-text-muted">
          <summary className="flex min-h-11 cursor-pointer select-none items-center hover:text-text-primary shell:min-h-8">Show plan</summary>
          <div className="mb-2">
            <Prose text={e.plan ?? ""} />
          </div>
        </details>
      </div>
    );
  }
  // "Claude wants to create the file index.html" reads as "You allowed Claude to update your page"; the file name stays behind "Show details".
  const file = /^\S+ wants to (?:create|change) the file (.+)$/.exec(e.text)?.[1];
  const what = file ? "update your page" : e.text.replace(/^\S+ wants to /, "");
  const detail = e.detail ?? file;
  return (
    <div className="text-small text-text-muted">
      <p className="flex items-start gap-2">
        <Icon size={14} className="mt-[5px] shrink-0" aria-hidden="true" />
        <span className="min-w-0">{allowed ? `You allowed ${who} to ${what}` : `You didn't allow ${who} to ${what}`}</span>
      </p>
      {detail || e.why ? (
        <div className="ml-5">
          <Details detail={detail} why={e.why} />
        </div>
      ) : null}
    </div>
  );
}

/** Claude's multiple-choice questions: each has options to pick (one, or several) and an "Other" answer, then Send answer or Skip. */
export function QuestionCard({ e, can, busy, onAnswer }: { e: AskEvent; can: boolean; busy: boolean; onAnswer: (allow: boolean, extra?: { answers?: Record<string, string> }) => void }) {
  const who = useContext(AgentCtx);
  const questions = e.questions ?? [];
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});
  // The typed "Other" text wins over the chosen options; typing and choosing replace each other.
  const valueOf = (i: number) => (typed[i] ?? "").trim() || (picked[i] ?? []).join(", ");
  const complete = questions.every((_, i) => valueOf(i) !== "");
  const choose = (i: number, label: string, multi: boolean) => {
    setTyped((t) => ({ ...t, [i]: "" }));
    setPicked((p) => {
      const cur = p[i] ?? [];
      const next = !multi ? [label] : cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
      return { ...p, [i]: next };
    });
  };
  const type = (i: number, text: string) => {
    setTyped((t) => ({ ...t, [i]: text }));
    setPicked((p) => ({ ...p, [i]: [] }));
  };
  return (
    <section aria-label={`${who} is asking`} className="rounded-card bg-surface-raised px-5 py-[18px]">
      {/* One question needs no title above it: the question is the title. */}
      {questions.length === 1 ? null : <p className="text-base font-semibold text-text-primary">{e.text}</p>}
      {can ? (
        <>
          <div className={cn("flex flex-col gap-5", questions.length !== 1 && "mt-4")}>
            {questions.map((q, i) => (
              <div key={i} className="flex flex-col gap-2">
                {q.header ? <p className="text-small text-text-muted">{q.header}</p> : null}
                <p className="text-base font-semibold text-text-primary">{q.question}</p>
                <div role="group" aria-label={q.question} className="flex flex-col gap-1">
                  {q.options.map((o, j) => {
                    const selected = (picked[i] ?? []).includes(o.label);
                    return (
                      <button
                        key={j}
                        type="button"
                        aria-pressed={selected}
                        disabled={busy}
                        onClick={() => choose(i, o.label, q.multiSelect === true)}
                        className={cn("flex w-full flex-col items-start gap-0.5 rounded-row px-3 py-2 text-left", selected ? "bg-surface-active" : "hover:bg-surface-hover")}
                      >
                        <span className="text-base text-text-primary">{o.label}</span>
                        {o.description ? <span className="text-small text-text-muted">{o.description}</span> : null}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="text"
                  className="field-input border-0 bg-surface-base focus:outline-2 focus:outline-offset-2 focus:outline-focus"
                  aria-label={`Other answer to: ${q.question}`}
                  placeholder="Other…"
                  value={typed[i] ?? ""}
                  disabled={busy}
                  onChange={(ev) => type(i, ev.target.value)}
                />
              </div>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              disabled={busy || !complete}
              onClick={() => onAnswer(true, { answers: Object.fromEntries(questions.map((q, i) => [q.question, valueOf(i)])) })}
            >
              Send answer
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => onAnswer(false)}>
              Skip
            </Button>
          </div>
        </>
      ) : (
        <p className="mt-4 text-small text-text-muted">Waiting for an answer.</p>
      )}
    </section>
  );
}

/** The plan Claude made in plan mode: read it, then build it, or ask for changes first. */
export function PlanCard({ e, can, busy, onAnswer }: { e: AskEvent; can: boolean; busy: boolean; onAnswer: (allow: boolean, extra?: { message?: string }) => void }) {
  const who = useContext(AgentCtx);
  const [changing, setChanging] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <section aria-label={`${who} is asking`} className="rounded-card bg-surface-raised px-5 py-[18px]">
      <p className="text-base font-semibold text-text-primary">{`${who}'s plan`}</p>
      <div className="mt-3 max-h-[50vh] overflow-y-auto">
        <Prose text={e.plan ?? ""} />
      </div>
      {can ? (
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled={busy} onClick={() => onAnswer(true)}>
              Build it
            </Button>
            <Button variant="secondary" aria-expanded={changing} disabled={busy} onClick={() => setChanging((c) => !c)}>
              Change the plan
            </Button>
          </div>
          {changing ? (
            <div className="flex flex-col items-start gap-3">
              <label className="flex w-full flex-col gap-2 text-small text-text-muted">
                What should change?
                <textarea className="field-textarea border-0 bg-surface-base focus:outline-2 focus:outline-offset-2 focus:outline-focus" rows={3} value={message} disabled={busy} onChange={(ev) => setMessage(ev.target.value)} />
              </label>
              <Button variant="primary" disabled={busy || !message.trim()} onClick={() => onAnswer(false, { message: message.trim() })}>
                Send changes
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 text-small text-text-muted">Waiting for an answer.</p>
      )}
    </section>
  );
}

/** Several answered asks in a row (and the tool runs between them) as one line: "You allowed 3 changes to your page". */
export function AnsweredGroup({ events, answers }: { events: ChatEvent[]; answers: Map<string, boolean> }) {
  const asks = events.filter((e): e is AskEvent => e.kind === "ask");
  const allowed = asks.filter((a) => answers.get(a.requestId));
  const denied = asks.length - allowed.length;
  let changes = 0;
  let commands = 0;
  let others = 0;
  for (const a of allowed) {
    // The agent's name leads the ask's text ("Codex wants to ..."), so the match does not depend on which agent it is.
    if (/^\S+ wants to (?:create|change) the file /.test(a.text)) changes++;
    else if (/^\S+ wants to run a command$/.test(a.text)) commands++;
    else others++;
  }
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts: string[] = [];
  if (changes) parts.push(n(changes, "change", "changes"));
  if (commands) parts.push(n(commands, "command", "commands"));
  if (others) parts.push(n(others, "other step", "other steps"));
  let text = parts.length === 0 ? "" : `You allowed ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`}`;
  if (changes && !commands && !others) text += " to your page"; // the file names stay in "Show details"
  if (denied) text += `${text ? ", and you" : "You"} didn't allow ${n(denied, "step", "steps")}`;
  return (
    <div className="text-small text-text-muted">
      <p className="flex items-start gap-2">
        <Check size={14} className="mt-[5px] shrink-0" aria-hidden="true" />
        <span className="min-w-0">{text}</span>
      </p>
      <details className="ml-5 text-sm text-text-muted">
        <summary className="flex min-h-11 cursor-pointer select-none items-center hover:text-text-primary shell:min-h-8">Show details</summary>
        <ul className="mb-2 flex flex-col gap-1">
          {events.map((e) =>
            e.kind === "ask" ? (
              <li key={e.n}>
                {answers.get(e.requestId) ? "Allowed: " : "Not allowed: "}
                {e.text.replace(/^\S+ wants to /, "")}
                {e.detail ? <span className="mono block break-all text-text-secondary">{e.detail}</span> : null}
              </li>
            ) : e.kind === "tool" ? (
              <li key={e.n}>{e.text}</li>
            ) : null,
          )}
        </ul>
      </details>
    </div>
  );
}
