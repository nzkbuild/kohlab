import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  ArrowRight,
  ArrowUp,
  CalendarCheck,
  CheckCircle,
  CircleNotch,
  GithubLogo,
  BellRinging,
  Storefront,
  Wrench,
  X,
  type Icon,
} from "@phosphor-icons/react";
import { api } from "../api";
import { useApp, useCan } from "../store";
import { announce } from "../lib/announce";
import { projectTitle } from "../lib/format";
import { workspaceStatus } from "../lib/status";
import { Button, Dialog, Field } from "./ui";
import { projectNameFromIdea } from "./homeName";

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
        ? await api.clone({ url: gitUrl.trim(), task: "", agent: "claude", chat: true })
        : await api.create({ task: "", agent: "claude", newProject: name.trim(), chat: true });
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

      <div className="flex flex-wrap items-center justify-end gap-2">
        {missing && !busy ? <span className="mr-auto text-xs text-text-muted">{missing}</span> : null}
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !!missing}>
          {busy ? <CircleNotch size={14} className="motion-safe:animate-spin" aria-hidden="true" /> : null}
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
        <Dialog.Content className="fixed top-1/2 left-1/2 z-[var(--z-dialog)] max-h-[90vh] w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[18px] border border-line-strong bg-surface-raised p-6 text-text-primary shadow-[0_1.5rem_4rem_oklch(0.08_0.002_286/0.55)]">
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

const STARTERS: { text: string; icon: Icon }[] = [
  { text: "A website for my small business", icon: Storefront },
  { text: "A page that collects RSVPs for an event", icon: CalendarCheck },
  { text: "A small tool that does a boring job for me", icon: Wrench },
];

/**
 * Home, and the same screen for a first run with no projects: one question, one
 * composer, a few ideas to start from, and a line for each project that needs
 * the person. The sidebar is the project list, so nothing else lives here.
 */
export function HomeScreen() {
  const workspaces = useApp((s) => s.workspaces);
  const navigate = useApp((s) => s.navigate);
  const refresh = useApp((s) => s.refresh);
  const route = useApp((s) => s.route);
  const setNewOpen = useApp((s) => s.setNewOpen);
  const can = useCan();

  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  // `/new` (an old bookmark) opens the dialog over this page, then drops the flag.
  const wantsCreate = route.kind === "workspaces" && !!route.create;
  useEffect(() => {
    if (!wantsCreate) return;
    setNewOpen(true);
    navigate({ kind: "workspaces" }, { replace: true });
  }, [wantsCreate, setNewOpen, navigate]);

  const needsYou = useMemo(
    () =>
      workspaces
        .filter((w) => workspaceStatus(w) === "needs-you")
        .sort((a, b) => (a.stopped ?? a.created) - (b.stopped ?? b.created)),
    [workspaces],
  );
  const ready = useMemo(
    () =>
      workspaces
        .filter((w) => workspaceStatus(w) === "needs-review")
        .sort((a, b) => (a.stopped ?? a.created) - (b.stopped ?? b.created))
        .slice(0, 3),
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
            agent: "claude",
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

  const fill = (text: string) => {
    setIdea(text);
    setError(null);
    composer.current?.focus();
  };

  const open = (id: string) => navigate({ kind: "workspace", id });

  return (
    <div className="surface">
      <div className="surface-inner">
        <div className="mx-auto w-full max-w-[696px] px-4 pt-6 pb-16 sm:pt-[12vh]">
          {needsYou.length > 0 || ready.length > 0 ? (
            <div className="mb-10 flex flex-col gap-2">
              {needsYou.map((w) => (
                <div
                  key={w.id}
                  className="flex items-center gap-3 rounded-[14px] bg-surface-raised px-4 py-3 text-[15px] text-text-primary"
                >
                  <BellRinging size={18} weight="fill" className="shrink-0 text-accent" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <strong className="font-semibold">{projectTitle(w)}</strong> needs you. Claude is waiting for your
                    answer.
                  </span>
                  <Button variant="secondary" size="sm" className="!min-h-11 sm:!min-h-0" aria-label={`Open ${projectTitle(w)}`} onClick={() => open(w.id)}>
                    Open
                  </Button>
                </div>
              ))}
              {ready.map((w) => (
                <div key={w.id} className="flex items-center gap-3 px-1 text-sm text-text-muted">
                  <CheckCircle size={16} className="shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{projectTitle(w)} is ready to check</span>
                  <Button variant="quiet" size="sm" className="!min-h-11 sm:!min-h-0" aria-label={`Open ${projectTitle(w)}`} onClick={() => open(w.id)}>
                    Open
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          <h1 className="text-balance text-center text-[28px] leading-[34px] font-[620] tracking-[-0.022em] text-text-primary">
            What do you want to build?
          </h1>

          {can.mutate ? (
            <>
              <div className="relative mt-8 rounded-[18px] border border-line-strong bg-surface-raised focus-within:border-line-accent">
                <label htmlFor="home-idea" className="sr-only">
                  Describe what you want to build
                </label>
                <textarea
                  id="home-idea"
                  ref={composer}
                  rows={3}
                  value={idea}
                  readOnly={busy}
                  onChange={(e) => setIdea(e.target.value)}
                  onKeyDown={onComposerKeyDown}
                  placeholder="Describe your idea in your own words…"
                  aria-describedby="home-hint"
                  className="block min-h-[84px] w-full resize-none rounded-[18px] bg-transparent px-5 pt-4 pb-16 text-base leading-6 text-text-primary outline-none placeholder:text-text-muted"
                />
                <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 px-4 pb-3">
                  <p id="home-hint" className="text-[13px] leading-5 text-text-muted">
                    Claude works in its own folder. Every change can be undone.
                  </p>
                  <Button
                    variant="primary"
                    aria-label="Start building"
                    onClick={() => void start()}
                    disabled={busy || !idea.trim()}
                    className="size-11 shrink-0 rounded-full p-0"
                  >
                    {busy ? (
                      <CircleNotch size={18} className="motion-safe:animate-spin" aria-hidden="true" />
                    ) : (
                      <ArrowUp size={18} weight="bold" aria-hidden="true" />
                    )}
                  </Button>
                </div>
              </div>

              {error ? (
                <p role="alert" className="mt-3 text-sm text-status-danger">
                  {error}
                </p>
              ) : null}

              <section aria-labelledby="home-ideas" className="mt-10">
                <h2 id="home-ideas" className="text-sm font-normal text-text-muted">
                  Not sure where to start?
                </h2>
                <ul className="mt-3 flex flex-col gap-2">
                  {STARTERS.map(({ text, icon: Icon }) => (
                    <li key={text}>
                      <button
                        type="button"
                        onClick={() => fill(text)}
                        className="flex min-h-11 w-full items-center gap-3 rounded-[14px] border border-line-subtle px-4 py-3 text-left text-[15px] text-text-primary transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
                      >
                        <Icon size={18} className="shrink-0 text-text-secondary" aria-hidden="true" />
                        <span className="min-w-0 flex-1">{text}</span>
                        <ArrowRight size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

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
