import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, GithubLogo, Robot, X } from "@phosphor-icons/react";
import { api } from "../api";
import { useApp, useCan } from "../store";
import { announce } from "../lib/announce";
import { projectTitle } from "../lib/format";
import { agentName } from "../lib/agentName";
import { workspaceStatus } from "../lib/status";
import { Button, ComposerChip, Dialog, Field, Menu, MenuRadioGroup, MenuRadioItem, Panel } from "./ui";
import { Composer, SaveLaterChip, SavedChip } from "./Composer";
import { addSaved, readDraft, writeDraft, DRAFT_SAVE_MS } from "../lib/drafts";
import { projectNameFromIdea } from "./homeName";
import { isPhone } from "../lib/viewport";

/** A GitHub pick returns either "owner/name" or a full URL; clone needs the URL. */
function asCloneUrl(repo: string): string {
  if (/^https?:\/\//.test(repo)) return repo;
  return `https://github.com/${repo.replace(/^\/+/, "")}`;
}

/** Server messages are developer-shaped; say what happened in plain words. */
function plainError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (/already exists/i.test(message)) return "A project with that name already exists. Try a different name.";
  return `Could not start the project. ${message}`;
}

/* ------------------------------------------------------------ create form -- */

/** The ACP agents a new chat project can use, besides Claude. Each is offered only when the server reports it installed. */
const ACP_CHOICES = ["hermes", "omp", "codex"];

/** The AI a new chat project talks through: Claude, or an installed ACP agent. Default Claude. `codexNeedsSignIn` is set when Codex is offered but not signed in. */
export function useNewAgent() {
  const [agent, setAgent] = useState("claude");
  const [installed, setInstalled] = useState<string[]>([]);
  const [codexSignedIn, setCodexSignedIn] = useState(true);
  useEffect(() => {
    api.agentsStatus().then((s) => {
      setInstalled(ACP_CHOICES.filter((n) => s[n] === true));
      setCodexSignedIn(s.codexSignedIn !== false);
    }, () => {});
  }, []);
  return { agent, setAgent, options: ["claude", ...installed], codexNeedsSignIn: !codexSignedIn };
}

/** The AI choice for a new project: a composer chip. On a phone it is the icon alone, so the composer does not crowd. */
export function AgentChip({ agent, options, onChange, disabled = false, title }: { agent: string; options: string[]; onChange: (agent: string) => void; disabled?: boolean; title?: string }) {
  return (
    <Menu
      side="top"
      align="start"
      label={`AI: ${agentName(agent)}`}
      trigger={<ComposerChip className="max-w-48 shrink-0" icon={<Robot size={14} aria-hidden="true" />} label={agentName(agent)} hideLabelOnPhone menu disabled={disabled} title={title} />}
    >
      <MenuRadioGroup value={agent} onValueChange={onChange}>
        {options.map((o) => (
          <MenuRadioItem key={o} value={o}>
            {agentName(o)}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </Menu>
  );
}

/**
 * The one way to make a project by hand. A chat project starts empty: the first
 * message is typed in the chat, not here. Copying from GitHub is the rarer path,
 * so it sits behind "More options".
 */
function NewProjectForm({ onCancel }: { onCancel: () => void }) {
  const refresh = useApp((s) => s.refresh);
  const navigate = useApp((s) => s.navigate);
  const setNewOpen = useApp((s) => s.setNewOpen);

  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [ghRepos, setGhRepos] = useState<string[] | null>(null);
  const [ghQuery, setGhQuery] = useState("");
  const [ghNote, setGhNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newAgent = useNewAgent();

  // The GitHub list loads only when the person opens "More options".
  useEffect(() => {
    if (!moreOpen || ghRepos !== null) return;
    setGhRepos([]);
    api
      .ghRepos()
      .then((res) => {
        setGhRepos(res.repos);
        if (!res.authed) setGhNote("GitHub is not connected here. Paste a link instead.");
      })
      .catch(() => setGhNote("Could not list your GitHub projects. Paste a link instead."));
  }, [moreOpen, ghRepos]);

  const ghMatches = useMemo(() => {
    const q = ghQuery.trim().toLowerCase();
    return (ghRepos ?? []).filter((r) => !q || r.toLowerCase().includes(q)).slice(0, 8);
  }, [ghRepos, ghQuery]);

  const cloning = gitUrl.trim() !== "";
  const missing = !cloning && !name.trim() ? "Name the project first." : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || missing) return;
    setBusy(true);
    setError(null);
    try {
      const created = cloning
        ? await api.clone({ url: gitUrl.trim(), task: "", agent: newAgent.agent, chat: true })
        : await api.create({ task: "", agent: newAgent.agent, newProject: name.trim(), chat: true });
      await refresh();
      announce("Project created");
      setNewOpen(false);
      navigate({ kind: "workspace", id: created.id });
    } catch (e) {
      setError(plainError(e));
      setBusy(false);
    }
  };

  return (
    <form className="launch-form mt-5 flex flex-col gap-5" onSubmit={submit} aria-describedby={error ? "launch-error" : undefined}>
      <Field label="Project name" htmlFor="launch-project" help="You can describe what to build in the chat next.">
        <input
          id="launch-project"
          className="field-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My bakery website"
          autoComplete="off"
          autoFocus
        />
      </Field>

      <div className="flex flex-col gap-1.5">
        <span className="field-label">AI</span>
        <div>
          <AgentChip agent={newAgent.agent} options={newAgent.options} onChange={newAgent.setAgent} disabled={busy} />
        </div>
      </div>

      <details
        className="launch-limits"
        open={moreOpen}
        onToggle={(e) => setMoreOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>More options</summary>
        <div className="mt-3 flex flex-col gap-3">
          <div className="field">
            <label className="field-label" htmlFor="launch-gh">
              Copy from GitHub
            </label>
            {ghRepos && ghRepos.length > 0 ? (
              <>
                <input
                  id="launch-gh"
                  type="search"
                  className="field-input"
                  value={ghQuery}
                  onChange={(e) => setGhQuery(e.target.value)}
                  placeholder="Search your GitHub projects"
                  autoComplete="off"
                />
                <ul className="gh-list" aria-label="GitHub projects">
                  {ghMatches.map((repo) => {
                    const cloneUrl = asCloneUrl(repo);
                    return (
                      <li key={repo}>
                        <button
                          type="button"
                          className="gh-item"
                          aria-pressed={gitUrl === cloneUrl}
                          onClick={() => setGitUrl(cloneUrl)}
                        >
                          <GithubLogo size={14} aria-hidden="true" />
                          <span className="mono truncate">{repo}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
            <input
              id="launch-url"
              aria-label="GitHub link"
              className="field-input mono"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder="https://github.com/owner/name"
              autoComplete="off"
            />
            <p className="field-help">
              {ghNote ?? "Paste the link of a project to copy it. The name above is then not used."}
            </p>
          </div>
        </div>
      </details>

      {error ? (
        <p id="launch-error" role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 md:flex-row md:flex-wrap md:items-center md:justify-end">
        {missing && !busy ? <span className="mr-auto text-xs text-text-muted">{missing}</span> : null}
        <Button variant="secondary" className="max-md:w-full" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" className="max-md:w-full" disabled={busy || !!missing}>
          {busy ? "Creating…" : "Create project"}
        </Button>
      </div>
    </form>
  );
}

/** New project: a centred dialog. Escape and the close button both dismiss it. */
export function LaunchSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-[var(--z-dialog)] max-h-[90vh] w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card bg-surface-raised p-6 text-text-primary shadow-[0_1.5rem_4rem_oklch(0.08_0.002_286/0.55)] max-md:inset-x-0 max-md:top-auto max-md:bottom-0 max-md:w-full max-md:max-h-[90dvh] max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-t-[18px] max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0 max-md:px-4 max-md:pt-0 max-md:pb-[max(1rem,var(--safe-bottom))] max-md:before:mx-auto max-md:before:mt-2.5 max-md:before:mb-4 max-md:before:block max-md:before:h-1 max-md:before:w-9 max-md:before:rounded-full max-md:before:bg-line-strong max-md:before:content-[''] max-md:motion-safe:animate-[kohlab-sheet-up_240ms_ease-out]">
          <header className="flex items-center justify-between gap-4">
            <Dialog.Title className="m-0 text-xl font-semibold tracking-tight">New project</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="quiet" iconOnly aria-label="Close">
                <X size={16} />
              </Button>
            </Dialog.Close>
          </header>
          <NewProjectForm onCancel={onClose} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ------------------------------------------------------------------ home -- */

/** Starter ideas: each one fills the composer. "Something else" just puts the cursor there. */
const STARTERS = ["A page for my shop", "An RSVP form", "A price calculator"];
const CHIP = "inline-flex h-9 items-center rounded-full bg-surface-raised px-3.5 text-[14px] text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none";

/**
 * Home, and the same screen for a first run with no projects: one question, one
 * composer, a few ideas to start from. If a project needs the person, one quiet
 * link says so. The sidebar is the project list, so nothing else lives here.
 */
export function HomeScreen() {
  const workspaces = useApp((s) => s.workspaces);
  const navigate = useApp((s) => s.navigate);
  const refresh = useApp((s) => s.refresh);
  const route = useApp((s) => s.route);
  const setNewOpen = useApp((s) => s.setNewOpen);
  const can = useCan();

  // The unsent idea: restored on load, saved 300 ms after the last key.
  const [idea, setIdea] = useState(() => readDraft("home"));
  const ideaRef = useRef(idea);
  ideaRef.current = idea;
  useEffect(() => {
    const t = window.setTimeout(() => writeDraft("home", idea), DRAFT_SAVE_MS);
    return () => window.clearTimeout(t);
  }, [idea]);
  // Leaving Home keeps what was typed, even inside that 300 ms.
  useEffect(() => () => writeDraft("home", ideaRef.current), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const newAgent = useNewAgent();

  // Claude missing or signed out: one calm notice above the message box. A failed check shows nothing.
  const [claudeNeedsSetup, setClaudeNeedsSetup] = useState(false);
  useEffect(() => {
    api.agentsStatus().then((s) => setClaudeNeedsSetup(!s.claude || s.claudeSignedIn === false), () => {});
  }, []);

  // `/new` (an old bookmark) opens the dialog over this page, then drops the flag.
  const wantsCreate = route.kind === "workspaces" && !!route.create;
  useEffect(() => {
    if (!wantsCreate) return;
    setNewOpen(true);
    navigate({ kind: "workspaces" }, { replace: true });
  }, [wantsCreate, setNewOpen, navigate]);

  // /new?prompt=… fills the box and takes the prompt out of the address bar (any other parameter, such as an access key, stays). It never sends.
  const promptText = route.kind === "workspaces" ? route.prompt : undefined;
  useEffect(() => {
    if (promptText === undefined) return;
    setIdea(promptText);
    setError(null);
    const url = new URL(location.href);
    url.searchParams.delete("prompt");
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
    navigate({ kind: "workspaces" }, { replace: true });
    composer.current?.focus();
  }, [promptText, navigate]);

  const needsYou = useMemo(
    () =>
      workspaces
        .filter((w) => workspaceStatus(w) === "needs-you")
        .sort((a, b) => (a.stopped ?? a.created) - (b.stopped ?? b.created)),
    [workspaces],
  );

  const start = async () => {
    const text = idea.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    const base = projectNameFromIdea(text);
    try {
      // The folder name is taken by an earlier project: try -2 … -9 before giving up.
      let created: { id: string } | null = null;
      for (let n = 1; n <= 9 && !created; n++) {
        try {
          created = await api.create({
            task: "",
            agent: newAgent.agent,
            newProject: n === 1 ? base : `${base}-${n}`,
            chat: true,
          });
        } catch (e) {
          if (!/already exists/i.test((e as Error).message) || n === 9) throw e;
        }
      }
      if (!created) throw new Error("no free name");
      // The project exists from here on, so the chat opens even if the send fails.
      try {
        await api.chatSend(created.id, text);
      } catch (e) {
        announce(`The first message did not send: ${(e as Error).message}`);
      }
      setIdea("");
      await refresh();
      navigate({ kind: "workspace", id: created.id });
    } catch (e) {
      setError(plainError(e));
    }
    setBusy(false);
  };

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void start();
    }
  };

  /** Ctrl/Cmd+S and the Save button: the idea goes to the saved list and the box clears. */
  const saveForLater = () => {
    const text = idea.trim();
    if (text === "") return;
    addSaved(text);
    setIdea("");
    announce("Saved for later");
    composer.current?.focus();
  };

  const fill = (text: string) => {
    setIdea(text);
    setError(null);
    composer.current?.focus();
  };

  const open = (id: string) => navigate({ kind: "workspace", id });

  return (
    <div className="surface">
      <div className="surface-inner">
        <div className="mx-auto flex w-full max-w-[720px] flex-col items-center px-4 pt-[12vh] pb-16">
          <h1 className="text-center text-[28px] leading-[34px] font-medium tracking-tight text-text-primary max-md:text-[24px] max-md:leading-[30px]">
            What should we build?
          </h1>

          {can.mutate ? (
            <>
              {claudeNeedsSetup ? (
                <Panel className="mt-8 w-full">
                  <div className="flex flex-wrap items-center gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-text-primary">Claude isn't connected yet</p>
                      <p className="mt-0.5 text-sm text-text-secondary">
                        Kohlab needs Claude to build things. Open Settings to see how to connect it.
                      </p>
                    </div>
                    <Button variant="secondary" size="sm" onClick={() => navigate({ kind: "settings", section: "agents" })}>
                      Open settings
                    </Button>
                  </div>
                </Panel>
              ) : null}
              {newAgent.agent === "codex" && newAgent.codexNeedsSignIn ? (
                <Panel className="mt-8 w-full">
                  <div className="flex flex-wrap items-center gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-text-primary">Codex needs you to sign in first</p>
                      <p className="mt-0.5 text-sm text-text-secondary">Open Settings to sign in with your ChatGPT account.</p>
                    </div>
                    <Button variant="secondary" size="sm" onClick={() => navigate({ kind: "settings", section: "agents" })}>
                      Open settings
                    </Button>
                  </div>
                </Panel>
              ) : null}
              <Composer
                className="mt-8 w-full"
                id="home-idea"
                ariaLabel="Describe what you want to build"
                textareaRef={composer}
                value={idea}
                onChange={(v) => setIdea(v)}
                readOnly={busy}
                leading={
                  <>
                    <AgentChip agent={newAgent.agent} options={newAgent.options} onChange={newAgent.setAgent} disabled={busy} />
                    {idea.trim() !== "" ? <SaveLaterChip onClick={saveForLater} /> : null}
                    <SavedChip
                      onPick={(text) => {
                        setIdea(text);
                        composer.current?.focus();
                      }}
                    />
                  </>
                }
                onKeyDown={onComposerKeyDown}
                onSaveLater={saveForLater}
                // The keyboard covers the lower half of a phone: bring the composer up into view.
                onFocus={(e) => {
                  if (isPhone()) e.currentTarget.scrollIntoView({ block: "center" });
                }}
                placeholder="Describe it in a sentence or two"
                trailing={
                  <Button
                    variant="primary"
                    iconOnly
                    aria-label="Start building"
                    title="Start building"
                    onClick={() => void start()}
                    disabled={busy || !idea.trim()}
                    className="disabled:opacity-40"
                  >
                    <ArrowUp size={18} aria-hidden="true" />
                  </Button>
                }
              />

              {error ? (
                <p role="alert" className="mt-3 w-full text-sm text-status-danger">
                  {error}
                </p>
              ) : null}

              <ul className="mt-4 flex flex-wrap justify-center gap-2">
                {STARTERS.map((text) => (
                  <li key={text}>
                    <button type="button" onClick={() => fill(text)} className={CHIP}>
                      {text}
                    </button>
                  </li>
                ))}
                <li>
                  <button type="button" onClick={() => composer.current?.focus()} className={CHIP}>
                    Something else
                  </button>
                </li>
              </ul>

              {needsYou[0] ? (
                <Button variant="quiet" size="sm" className="mt-6 text-text-muted" onClick={() => open(needsYou[0].id)}>
                  {`${projectTitle(needsYou[0])} needs you`}
                </Button>
              ) : null}
            </>
          ) : (
            <p className="mt-6 text-center text-sm text-text-muted">
              Your role can look at projects but not create them. The owner starts new ones.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function WorkspacesView() {
  return <HomeScreen />;
}
