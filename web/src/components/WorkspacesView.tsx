import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ArrowRight,
  ArrowBendDownRight,
  ArrowSquareOut,
  CaretDown,
  DotsThree,
  GithubLogo,
  HardDrives,
  LinkSimple,
  MagnifyingGlass,
  Play,
  Plus,
  Robot,
  Rocket,
  Sparkle,
  Stop,
  TerminalWindow,
  Trash,
  X,
} from "@phosphor-icons/react";
import { api } from "../api";
import { useApp, useCan } from "../store";
import { announce } from "../lib/announce";
import { toastAction, withToast } from "../lib/actions";
import { relativeTime } from "../lib/format";
import { STATUS_LABEL, byReviewFirst, workspaceStatus, type WorkspaceStatus } from "../lib/status";
import { AGENT_CATALOG } from "../types";
import type { Workspace } from "../types";
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Menu,
  MenuItem,
  MenuSub,
  PageHeader,
  Panel,
  StatusChip,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from "./ui";
import ConfirmDialog from "./ConfirmDialog";
import { copyText } from "../lib/clipboard";

/* --------------------------------------------------------------- constants -- */

type Filter = WorkspaceStatus | "all";

const FILTERS: Filter[] = ["all", "needs-review", "running", "committed", "stopped"];

const FILTER_LABEL: Record<Filter, string> = { all: "all", ...STATUS_LABEL };

/** A GitHub pick returns either "owner/name" or a full URL; clone needs the URL. */
function asCloneUrl(repo: string): string {
  if (/^https?:\/\//.test(repo)) return repo;
  return `https://github.com/${repo.replace(/^\/+/, "")}`;
}

function matches(w: Workspace, query: string): boolean {
  if (!query) return true;
  return (
    w.id.toLowerCase().includes(query) ||
    w.task.toLowerCase().includes(query) ||
    w.agent.toLowerCase().includes(query)
  );
}

/**
 * Agent options come from the server, never a hand-kept list. The catalog is
 * only a fallback for a server that reports nothing (fresh install, or the
 * status call failed): it must never be the primary source.
 */
function useAgentOptions(): { names: string[]; reported: boolean } {
  const [installed, setInstalled] = useState<string[]>([]);
  useEffect(() => {
    api
      .agentsStatus()
      .then((status) => setInstalled(Object.keys(status).filter((name) => status[name])))
      .catch(() => setInstalled([]));
  }, []);
  if (installed.length > 0) return { names: installed, reported: true };
  return { names: AGENT_CATALOG.map((a) => a.name), reported: false };
}

/* ------------------------------------------------------------ create form -- */

/**
 * The one create form in the product. Onboarding renders it as its second step
 * rather than keeping a second copy that drifts.
 */
type Source = "server" | "clone" | "new" | "continue";

const SOURCES: { id: Source; title: string; hint: string; icon: typeof Rocket }[] = [
  { id: "server", title: "This server", hint: "a repository already here", icon: HardDrives },
  { id: "clone", title: "Clone", hint: "GitHub or any git URL", icon: GithubLogo },
  { id: "new", title: "New project", hint: "an empty repository", icon: Sparkle },
  { id: "continue", title: "Continue", hint: "a workspace you already have", icon: ArrowBendDownRight },
];

export function NewWorkspaceForm({ onCancel }: { onCancel?: () => void }) {
  const refresh = useApp((s) => s.refresh);
  const navigate = useApp((s) => s.navigate);
  const workspaces = useApp((s) => s.workspaces);
  const can = useCan();
  const { names: agentNames, reported } = useAgentOptions();

  // Members work only from URLs (their agent runs in their own home), so host
  // paths and new projects are owner choices.
  const sources = SOURCES.filter((src) => (src.id === "server" || src.id === "new" ? can.own : src.id === "continue" ? workspaces.length > 0 : true));
  const [source, setSource] = useState<Source>(sources[0]?.id ?? "clone");

  const [task, setTask] = useState("");
  const [repo, setRepo] = useState("");
  const [url, setUrl] = useState("");
  const [projectName, setProjectName] = useState("");
  const [location, setLocation] = useState("");
  const [projectsHome, setProjectsHome] = useState<string | null>(null);
  useEffect(() => {
    if (can.own) api.paths().then((p) => setProjectsHome(p.projects), () => {});
  }, [can.own]);
  const [agent, setAgent] = useState("");
  const [target, setTarget] = useState("");
  const [branch, setBranch] = useState("");
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branchNote, setBranchNote] = useState<string | null>(null);
  const [payload, setPayload] = useState("");
  const [timeoutMin, setTimeoutMin] = useState("");
  const [memoryMb, setMemoryMb] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ghRepos, setGhRepos] = useState<string[] | null>(null);
  const [ghQuery, setGhQuery] = useState("");
  const [ghNote, setGhNote] = useState<string | null>(null);

  const chosenAgent = agent || agentNames[0] || "";
  // Recognition over recall: every repo this server already works in, newest first.
  const recentRepos = useMemo(() => {
    const seen = new Set<string>();
    for (const w of [...workspaces].sort((a, b) => b.created - a.created)) if (w.repo) seen.add(w.repo);
    return [...seen];
  }, [workspaces]);
  const continuable = useMemo(
    () => [...workspaces].sort((a, b) => (b.stopped ?? b.started ?? b.created) - (a.stopped ?? a.started ?? a.created)),
    [workspaces],
  );
  const chosenTarget = target || continuable[0]?.id || "";
  const chosenRepo = repo || recentRepos[0] || "";

  // GitHub list loads when Clone is first opened; it is a pick list, not a step.
  useEffect(() => {
    if (source !== "clone" || ghRepos !== null) return;
    setGhRepos([]);
    api
      .ghRepos()
      .then((res) => {
        setGhRepos(res.repos);
        if (!res.authed) setGhNote("GitHub is not signed in on this server (run gh auth login there). Paste a URL instead.");
      })
      .catch(() => setGhNote("Could not list GitHub repositories. Paste a URL instead."));
  }, [source, ghRepos]);
  const ghMatches = useMemo(() => {
    const q = ghQuery.trim().toLowerCase();
    return (ghRepos ?? []).filter((r) => !q || r.toLowerCase().includes(q)).slice(0, 8);
  }, [ghRepos, ghQuery]);

  // Branches for whatever the workspace will start from; empty means "default".
  const branchSource = source === "server" ? chosenRepo : source === "clone" ? url.trim() : "";
  const loadBranches = async () => {
    if (!branchSource) return;
    setBranchNote("loading branches…");
    try {
      const res = await api.branches(branchSource);
      setBranches(res.branches);
      setBranchNote(res.branches.length ? null : "No branches found.");
    } catch (e) {
      setBranchNote((e as Error).message);
    }
  };
  useEffect(() => {
    setBranches(null);
    setBranch("");
    setBranchNote(null);
  }, [branchSource]);

  const missing = !task.trim()
    ? "Describe the task first."
    : source === "clone" && !url.trim()
      ? "Pick a repository or paste a URL."
      : source === "new" && !projectName.trim()
        ? "Name the project."
        : source === "continue" && !chosenTarget
          ? "There is no workspace to continue."
          : source !== "continue" && !chosenAgent
            ? "No agent available."
            : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || missing) return;
    setBusy(true);
    setError(null);
    try {
      if (source === "continue") {
        await api.continue(chosenTarget, task.trim());
        await refresh();
        announce(`${chosenTarget} continues with the new task`);
        navigate({ kind: "workspace", id: chosenTarget, tab: "terminal" });
      } else {
        const limits =
          timeoutMin || memoryMb
            ? {
                timeoutSec: timeoutMin ? Math.round(Number(timeoutMin) * 60) : undefined,
                maxMemoryMb: memoryMb ? Number(memoryMb) : undefined,
              }
            : undefined;
        const common = { task: task.trim(), agent: chosenAgent, limits, payload: payload.trim() || undefined, branch: branch || undefined };
        const created =
          source === "clone"
            ? await api.clone({ url: url.trim(), ...common })
            : source === "new"
              ? await api.create({ ...common, branch: undefined, newProject: projectName.trim(), location: location.trim() || undefined })
              : await api.create({ ...common, repo: chosenRepo || undefined });
        await refresh();
        announce(`${created.id} created, the agent is starting`);
        navigate({ kind: "workspace", id: created.id });
      }
    } catch (e) {
      // Kept next to the button, not in a toast that vanishes before it is read.
      setError((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <form className="launch-form" onSubmit={submit} aria-describedby={error ? "launch-error" : undefined}>
      <fieldset className="source-grid">
        <legend className="field-label mb-2">Start from</legend>
        {sources.map(({ id, title, hint, icon: Icon }) => (
          <label key={id} className="source-card">
            <input type="radio" name="launch-source" value={id} checked={source === id} onChange={() => setSource(id)} />
            <span className="source-card-body">
              <Icon size={18} aria-hidden="true" />
              <span className="text-sm font-semibold text-text-primary">{title}</span>
              <span className="text-xs text-text-muted">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {source === "server" ? (
        <Field label="Repository" htmlFor="launch-repo" help="A path on this server. Repositories kohlab already uses are suggested.">
          <input
            id="launch-repo"
            className="field-input mono"
            list="launch-repo-options"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder={recentRepos[0] ?? "/srv/repos/app"}
            autoComplete="off"
          />
          <datalist id="launch-repo-options">
            {recentRepos.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </Field>
      ) : null}

      {source === "clone" ? (
        <div className="field">
          <label className="field-label" htmlFor="launch-gh">
            Repository
          </label>
          {ghRepos && ghRepos.length > 0 ? (
            <>
              <input
                id="launch-gh"
                type="search"
                className="field-input"
                value={ghQuery}
                onChange={(e) => setGhQuery(e.target.value)}
                placeholder="search your GitHub repositories"
                autoComplete="off"
              />
              <ul className="gh-list" aria-label="GitHub repositories">
                {ghMatches.map((name) => {
                  const cloneUrl = asCloneUrl(name);
                  return (
                    <li key={name}>
                      <button
                        type="button"
                        className="gh-item"
                        aria-pressed={url === cloneUrl}
                        onClick={() => setUrl(cloneUrl)}
                      >
                        <GithubLogo size={14} aria-hidden="true" />
                        <span className="mono truncate">{name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
          <input
            aria-label="git URL"
            className="field-input mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/name or git@host:owner/name.git"
            autoComplete="off"
          />
          <p className="field-help">
            {ghNote ?? (ghRepos === null || (ghRepos.length === 0 && !ghNote) ? "Loading your GitHub repositories… or paste any git URL." : "Pick one, or paste any git URL. A repository cloned before is reused, not downloaded again.")}
          </p>
        </div>
      ) : null}

      {source === "new" ? (
        <>
          <Field label="Project name" htmlFor="launch-project" help="A new folder with an empty git repository, then the agent starts in it.">
            <input
              id="launch-project"
              className="field-input"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="invoice-parser"
              autoComplete="off"
            />
          </Field>
          <Field
            label="Create in"
            htmlFor="launch-location"
            help={`Any folder on this server. Leave empty for ${projectsHome ?? "kohlab's projects folder"}.${projectName.trim() ? ` The project will be ${(location.trim() || projectsHome || "…").replace(/\/+$/, "")}/${projectName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` : ""}`}
          >
            <input
              id="launch-location"
              className="field-input mono"
              list="launch-location-options"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={projectsHome ?? "/srv/repos"}
              autoComplete="off"
            />
            <datalist id="launch-location-options">
              {[...new Set(recentRepos.map((r) => r.replace(/\/[^/]+\/?$/, "")))].map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </Field>
        </>
      ) : null}

      {source === "continue" ? (
        <Field
          label="Workspace"
          htmlFor="launch-target"
          help="Same worktree and branch. The agent restarts on the new task, and its work still lands in review."
        >
          <select id="launch-target" className="field-select" value={chosenTarget} onChange={(e) => setTarget(e.target.value)}>
            {continuable.map((w) => (
              <option key={w.id} value={w.id}>
                {w.id}, {w.task}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <Field label="What should the agent do?" htmlFor="launch-task">
        <textarea
          id="launch-task"
          className="field-textarea launch-task"
          rows={3}
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder={source === "continue" ? "now add tests for the retry path" : source === "new" ? "scaffold a CLI that parses invoices" : "fix the billing rounding bug"}
        />
      </Field>

      {source !== "continue" ? (
        <fieldset className="field">
          <legend className="field-label">Agent</legend>
          <div className="segmented mt-1.5">
            {agentNames.map((name) => (
              <label key={name}>
                <input type="radio" name="launch-agent" value={name} checked={chosenAgent === name} onChange={() => setAgent(name)} />
                <span className="mono">{name}</span>
              </label>
            ))}
          </div>
          <p className="field-help">{reported ? "Installed on this server." : "None reported as installed, showing every known agent."}</p>
        </fieldset>
      ) : null}

      {source !== "continue" ? (
        <details className="launch-limits">
          <summary>More: branch, first message, limits</summary>
          <div className="mt-3 flex flex-col gap-4">
            {source !== "new" ? (
              <Field label="Start from branch" htmlFor="launch-branch" help={branchNote ?? "Leave empty for the default branch."}>
                <div className="flex gap-2">
                  <input
                    id="launch-branch"
                    className="field-input mono"
                    list="launch-branch-options"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    onFocus={() => branches === null && void loadBranches()}
                    placeholder="default branch"
                    autoComplete="off"
                  />
                  <datalist id="launch-branch-options">
                    {(branches ?? []).map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                </div>
              </Field>
            ) : null}
            <Field
              label="First message to the agent"
              htmlFor="launch-payload"
              help="Typed into the agent when it starts, so it gets to work without you. Leave empty to start it idle."
            >
              <textarea
                id="launch-payload"
                className="field-textarea"
                rows={2}
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
                placeholder={task.trim() || "read the README and fix the failing test"}
              />
            </Field>
            <div className="grid gap-3 shell:grid-cols-2">
              <Field label="Time limit (minutes)" htmlFor="launch-timeout">
                <input
                  id="launch-timeout"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  className="field-input"
                  value={timeoutMin}
                  onChange={(e) => setTimeoutMin(e.target.value)}
                  placeholder="no limit"
                />
              </Field>
              <Field label="Memory limit (MB)" htmlFor="launch-memory">
                <input
                  id="launch-memory"
                  type="number"
                  min={64}
                  inputMode="numeric"
                  className="field-input"
                  value={memoryMb}
                  onChange={(e) => setMemoryMb(e.target.value)}
                  placeholder="no limit"
                />
              </Field>
            </div>
          </div>
        </details>
      ) : null}

      {error ? (
        <p id="launch-error" role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      ) : null}

      <div className="launch-actions">
        {missing && !busy ? <span className="mr-auto text-xs text-text-muted">{missing}</span> : null}
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" variant="primary" disabled={busy || !!missing}>
          <Rocket size={14} weight="fill" />
          {busy ? (source === "clone" ? "Cloning…" : "Starting…") : source === "continue" ? "Continue" : "Start agent"}
        </Button>
      </div>
    </form>
  );
}

/** /new: a side sheet on desktop, full screen on phones. */
export function LaunchSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="sheet" aria-describedby={undefined}>
          <header className="sheet-head">
            <Dialog.Title className="m-0 text-xl font-semibold tracking-tight">Start an agent</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="quiet" iconOnly aria-label="close">
                <X size={16} />
              </Button>
            </Dialog.Close>
          </header>
          <NewWorkspaceForm onCancel={onClose} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* -------------------------------------------------------------- the view -- */

/**
 * What is waiting on you, oldest first: the longer an agent's work has sat
 * unreviewed, the further its branch has drifted. Only rendered when non-empty,
 * so an empty queue costs no space.
 */
/** +/- line counts across a workspace's diff; null until it loads. */
function useDiffStats(id: string): { files: number; add: number; del: number } | null {
  const [stats, setStats] = useState<{ files: number; add: number; del: number } | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .diff(id)
      .then((files) => {
        let add = 0;
        let del = 0;
        for (const f of files) {
          for (const line of f.diff.split("\n")) {
            if (line.startsWith("+") && !line.startsWith("+++")) add++;
            else if (line.startsWith("-") && !line.startsWith("---")) del++;
          }
        }
        if (alive) setStats({ files: files.length, add, del });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);
  return stats;
}

function ReviewCard({ w }: { w: Workspace }) {
  const navigate = useApp((s) => s.navigate);
  const stats = useDiffStats(w.id);
  const open = () => navigate({ kind: "workspace", id: w.id, tab: "review" });
  return (
    <li className="inbox-card">
      <div className="flex min-w-0 items-baseline gap-3">
        <StatusChip status="needs-review" />
        <span className="mono truncate text-sm font-medium text-text-primary">{w.id}</span>
        <span className="tnum ml-auto shrink-0 text-xs text-text-muted" title="waiting since">
          {relativeTime(w.stopped ?? w.created)}
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-base text-text-primary">{w.task}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="mono text-xs text-text-muted">{w.agent}</span>
        {stats ? (
          <span className="mono tnum text-xs text-text-muted">
            <span className="text-text-primary">+{stats.add}</span> −{stats.del}
            {" · "}
            {stats.files} file{stats.files === 1 ? "" : "s"}
          </span>
        ) : null}
        <Button variant="primary" size="sm" className="ml-auto" onClick={open}>
          review diff
          <ArrowRight size={13} aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

/** The inbox: finished work waiting on a decision, oldest first. */
function ReviewQueue({ items }: { items: Workspace[] }) {
  return (
    <section className="mt-6" aria-labelledby="inbox-title">
      <h2 id="inbox-title" className="section-title">
        Waiting for you <span className="tnum text-text-muted">{items.length}</span>
      </h2>
      <ul className="mt-3 grid gap-3 lg:grid-cols-2">
        {items.map((w) => (
          <ReviewCard key={w.id} w={w} />
        ))}
      </ul>
    </section>
  );
}

/** Last non-empty line an agent printed: proof of life without opening it. */
function useLastLine(id: string): string | null {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .log(id)
        .then(({ log }) => {
          // Strip ANSI so a colour code never reads as text.
          const clean = log.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\r/g, "");
          const last = clean.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? null;
          if (alive) setLine(last);
        })
        .catch(() => {});
    void load();
    const t = window.setInterval(load, 10_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [id]);
  return line;
}

function RunningRow({ w }: { w: Workspace }) {
  const navigate = useApp((s) => s.navigate);
  const last = useLastLine(w.id);
  return (
    <li>
      <button
        type="button"
        className="running-row"
        onClick={() => navigate({ kind: "workspace", id: w.id, tab: "terminal" })}
      >
        <span className="chip-dot live-dot shrink-0 text-status-running" aria-hidden="true" />
        <span className="mono w-28 shrink-0 truncate text-sm text-text-primary shell:w-44">{w.id}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-text-secondary">{w.task}</span>
          <span className="mono block truncate text-xs text-text-faint">{last ?? "waiting for output"}</span>
        </span>
        <span className="mono hidden shrink-0 text-xs text-text-muted shell:inline">{w.agent}</span>
        <span className="tnum shrink-0 text-xs text-text-muted">{relativeTime(w.started ?? w.created)}</span>
      </button>
    </li>
  );
}

function RunningList({ items }: { items: Workspace[] }) {
  return (
    <section className="mt-8" aria-labelledby="running-title">
      <h2 id="running-title" className="section-title">
        Running <span className="tnum text-text-muted">{items.length}</span>
      </h2>
      <ul className="panel mt-3 divide-y divide-line-subtle overflow-hidden">
        {items.map((w) => (
          <RunningRow key={w.id} w={w} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Home: the review queue first, then every workspace with search, a status
 * filter and per-row actions. This replaced a separate "Command center" that
 * showed the same workspaces as KPI cards, a second tabbed table and an
 * activity feed: three readings of one list, none of which acted on it.
 */
/* --------------------------------------------------------------- open menu -- */

/**
 * The page-level way back into existing work: a fresh shell or a relaunched
 * agent in any workspace. Creating a workspace belongs to the sidebar.
 */
function OpenMenu({ workspaces }: { workspaces: Workspace[] }) {
  const navigate = useApp((s) => s.navigate);
  const refresh = useApp((s) => s.refresh);
  const setOpenShell = useApp((s) => s.setOpenShell);
  // Most recently touched first: that is the one you are coming back to.
  const recent = useMemo(
    () => [...workspaces].sort((a, b) => (b.stopped ?? b.started ?? b.created) - (a.stopped ?? a.started ?? a.created)),
    [workspaces],
  );

  const openTerminal = (id: string) => {
    setOpenShell(id);
    navigate({ kind: "workspace", id, tab: "terminal" });
  };

  const runAgent = async (w: Workspace) => {
    const action = w.running ? "restart" : "start";
    try {
      await toastAction(w.id, action);
      await refresh();
      announce(`${w.id} agent ${action === "start" ? "starting" : "restarting"}`);
      navigate({ kind: "workspace", id: w.id, tab: "terminal" });
    } catch {
      /* toastAction already reported the reason */
    }
  };

  return (
    <Menu
      label="open a terminal or agent"
      trigger={
        <Button variant="primary">
          <TerminalWindow size={14} weight="bold" />
          open…
          <CaretDown size={12} weight="bold" />
        </Button>
      }
    >
      <MenuSub label="Terminal in" icon={<TerminalWindow size={14} />}>
        {recent.map((w) => (
          <MenuItem key={w.id} onSelect={() => openTerminal(w.id)}>
            <span className="mono">{w.id}</span>
          </MenuItem>
        ))}
      </MenuSub>
      <MenuSub label="Agent in" icon={<Robot size={14} />}>
        {recent.map((w) => (
          <MenuItem key={w.id} onSelect={() => void runAgent(w)}>
            <span className="mono flex-1">{w.id}</span>
            <span className="text-xs text-text-faint">{w.running ? "restart" : w.agent}</span>
          </MenuItem>
        ))}
      </MenuSub>
    </Menu>
  );
}

/* -------------------------------------------------------------- the view -- */

export default function WorkspacesView() {
  const workspaces = useApp((s) => s.workspaces);
  const navigate = useApp((s) => s.navigate);
  const refresh = useApp((s) => s.refresh);
  const route = useApp((s) => s.route);
  const can = useCan();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // `/new` (the sidebar button, the palette) arrives with the form open, and a
  // second arrival while already here opens it too: the route object is new.
  const wantsCreate = route.kind === "workspaces" && !!route.create;
  const [creating, setCreating] = useState(wantsCreate);
  useEffect(() => {
    if (wantsCreate) setCreating(true);
  }, [route, wantsCreate]);
  const closeForm = () => {
    setCreating(false);
    if (wantsCreate) navigate({ kind: "workspaces" }, { replace: true });
  };

  const queue = useMemo(
    () =>
      workspaces
        .filter((w) => workspaceStatus(w) === "needs-review")
        .sort((a, b) => (a.stopped ?? a.created) - (b.stopped ?? b.created)),
    [workspaces],
  );
  const running = useMemo(() => workspaces.filter((w) => w.running), [workspaces]);
  const [pendingDelete, setPendingDelete] = useState<Workspace | null>(null);
  const [deleting, setDeleting] = useState(false);

  const counts = useMemo(() => {
    const by: Record<Filter, number> = {
      all: workspaces.length,
      running: 0,
      "needs-review": 0,
      committed: 0,
      stopped: 0,
      discarded: 0,
    };
    for (const w of workspaces) by[workspaceStatus(w)] += 1;
    // Discarded is shown under `stopped` (it is stopped: not running, not waiting
    // on anyone, and its row carries its own chip), so the number beside that
    // filter has to include it or it would undercount what it shows.
    by.stopped += by.discarded;
    return by;
  }, [workspaces]);

  const trimmedQuery = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      workspaces
        // Discarded counts as stopped here: without this it would match no filter
        // except "all", which is a dead end for the state a reject produces.
        .filter((w) => {
          const st = workspaceStatus(w);
          const inFilter = filter === "all" || st === filter || (filter === "stopped" && st === "discarded");
          return inFilter && matches(w, trimmedQuery);
        })
        .sort(byReviewFirst),
    [workspaces, filter, trimmedQuery],
  );

  const clearFilters = () => {
    setQuery("");
    setFilter("all");
  };

  const toggle = async (w: Workspace) => {
    const verb = w.running ? "stop" : "start";
    try {
      await withToast(`${verb === "start" ? "Starting" : "Stopping"} ${w.id}`, () => api.action(w.id, verb));
      await refresh();
      announce(`${w.id} is ${verb === "start" ? "starting" : "stopping"}`);
    } catch {
      /* withToast already reported the reason */
    }
  };

  const share = async (w: Workspace) => {
    try {
      const copied = await withToast(`Share link for ${w.id}`, async () => {
        const res = await api.share(w.id);
        const url = `${location.origin}/?share=${res.share}`;
        return copyText(url)
          .then(() => true)
          .catch(() => false);
      });
      announce(copied ? `share link for ${w.id} copied` : `share link for ${w.id} created`);
    } catch {
      /* withToast already reported the reason */
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setDeleting(true);
    try {
      await withToast(`Deleting ${id}`, () => api.action(id, "delete"));
      await refresh();
      announce(`${id} deleted`);
      setPendingDelete(null);
    } catch {
      /* withToast already reported the reason */
    }
    setDeleting(false);
  };

  const describedFilter = [
    trimmedQuery ? `“${trimmedQuery}”` : null,
    filter === "all" ? null : STATUS_LABEL[filter],
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="surface">
      <div className="surface-inner">
        {/* Creating lives in the sidebar; the page action re-enters existing work. */}
        <PageHeader
          title="Workspaces"
          description={
            queue.length > 0
              ? `${queue.length} waiting for you. Everything an agent has been given on this server is below.`
              : "Nothing is waiting for review. Everything an agent has been given on this server is below."
          }
          actions={can.mutate && workspaces.length > 0 ? <OpenMenu workspaces={workspaces} /> : undefined}
        />

        {/* The form sits directly under the button that opened it, not between
            the filter tabs and the list they control. */}
        <LaunchSheet open={creating && can.mutate} onClose={closeForm} />

        {queue.length > 0 ? <ReviewQueue items={queue} /> : null}
        {running.length > 0 ? <RunningList items={running} /> : null}

        <div className="mt-10">
          <h2 className="section-title">All workspaces</h2>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 basis-56">
            <MagnifyingGlass
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
              aria-hidden="true"
            />
            <input
              type="search"
              className="field-input pl-8"
              aria-label="search workspaces by id, task or agent"
              placeholder="search id, task or agent"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <span className="tnum text-xs text-text-muted">
            {visible.length} of {workspaces.length}
          </span>
        </div>

        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabList label="filter workspaces by status" className="mt-3">
          {FILTERS.map((option) => (
            <Tab key={option} value={option}>
              {FILTER_LABEL[option]}
              <span className="tnum text-2xs text-text-muted">{counts[option]}</span>
            </Tab>
          ))}
        </TabList>

        <TabPanel value={filter} className="mt-3" tabIndex={-1}>
          {workspaces.length === 0 ? (
            <Panel>
              <EmptyState
                icon={<Plus size={18} />}
                title="No workspaces on this server"
                description="The setup steps walk through installing an agent and creating the first one."
                action={
                  can.mutate ? (
                    <Button variant="primary" onClick={() => setCreating(true)}>
                      new workspace
                    </Button>
                  ) : undefined
                }
              />
            </Panel>
          ) : visible.length === 0 ? (
            /* The system has data; the filter excluded it. Creation is the wrong
               offer here, the way out is to widen the filter again. */
            <Panel>
              <EmptyState
                icon={<MagnifyingGlass size={18} />}
                title={`No workspaces match ${describedFilter}`}
                description="Nothing is hidden, the filter is just narrower than the list."
                action={<Button onClick={clearFilters}>clear filters</Button>}
              />
            </Panel>
          ) : (
            <>
              <Panel className="hidden overflow-hidden shell:block">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">workspace</th>
                      <th scope="col">task</th>
                      <th scope="col">status</th>
                      <th scope="col">agent</th>
                      <th scope="col">age</th>
                      <th scope="col">
                        <span className="sr-only">actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((w) => {
                      const status = workspaceStatus(w);
                      return (
                        <tr key={w.id}>
                          <th scope="row" className="normal-case tracking-normal">
                            {/* The id is the row's way in. The icon actions are
                                opacity 0 until hover, so on their own they
                                leave the list with no visible target: someone
                                scanning for what needs review sees nothing to
                                press. This target needs no hover, so it also
                                works wherever hover does not exist. */}
                            <button
                              type="button"
                              className="row-link mono text-sm font-medium"
                              onClick={() => navigate({ kind: "workspace", id: w.id })}
                            >
                              {w.id}
                            </button>
                          </th>
                          <td className="max-w-md truncate text-text-secondary">{w.task}</td>
                          <td>
                            <StatusChip status={status} />
                          </td>
                          <td className="mono text-xs text-text-muted">{w.agent}</td>
                          <td className="tnum text-xs text-text-muted">{relativeTime(w.created)}</td>
                          <td>
                            {can.mutate ? (
                            <div className="row-actions flex items-center justify-end gap-1">
                              <Button
                                variant="quiet"
                                iconOnly
                                size="sm"
                                aria-label={`${w.running ? "stop" : "start"} ${w.id}`}
                                onClick={() => void toggle(w)}
                              >
                                {w.running ? <Stop size={13} /> : <Play size={13} />}
                              </Button>
                              <Button
                                variant="quiet"
                                iconOnly
                                size="sm"
                                aria-label={`copy share link for ${w.id}`}
                                onClick={() => void share(w)}
                              >
                                <LinkSimple size={13} />
                              </Button>
                              <Button
                                variant="quiet"
                                iconOnly
                                size="sm"
                                aria-label={`delete ${w.id}`}
                                onClick={() => setPendingDelete(w)}
                              >
                                <Trash size={13} />
                              </Button>
                            </div>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Panel>

              {/* Below the shell breakpoint a table reflows into one card per
                  workspace with a single primary action, never a sideways scroll. */}
              <ul className="flex flex-col gap-2 shell:hidden">
                {visible.map((w) => (
                  <li key={w.id} className="panel p-3">
                    <div className="flex items-center gap-2">
                      <span className="mono text-sm font-medium text-text-primary">{w.id}</span>
                      <StatusChip status={workspaceStatus(w)} />
                      <div className="flex-1" />
                      <span className="tnum text-2xs text-text-faint">{relativeTime(w.created)}</span>
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-sm text-text-secondary">{w.task}</p>
                    <p className="mono mt-1 truncate text-2xs text-text-muted" title={w.repo}>
                      {w.agent} · {w.repo}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="flex-1"
                        onClick={() => navigate({ kind: "workspace", id: w.id })}
                      >
                        <ArrowSquareOut size={13} />
                        open
                      </Button>
                      {can.mutate ? (
                        <Menu
                          label={`more actions for ${w.id}`}
                          trigger={
                            <Button variant="secondary" size="sm" iconOnly>
                              <DotsThree size={16} weight="bold" />
                            </Button>
                          }
                        >
                          <MenuItem onSelect={() => void toggle(w)}>
                            {w.running ? <Stop size={14} /> : <Play size={14} />}
                            {w.running ? "stop" : "start"}
                          </MenuItem>
                          <MenuItem onSelect={() => void share(w)}>
                            <LinkSimple size={14} />
                            copy share link
                          </MenuItem>
                          <MenuItem tone="danger" onSelect={() => setPendingDelete(w)}>
                            <Trash size={14} />
                            delete
                          </MenuItem>
                        </Menu>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </TabPanel>
        </Tabs>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={pendingDelete ? `Delete ${pendingDelete.id}?` : "Delete workspace?"}
        description={
          pendingDelete
            ? `${pendingDelete.id} at ${pendingDelete.path} is removed from this server, along with any uncommitted agent changes. This cannot be undone.`
            : ""
        }
        confirmLabel="delete"
        busy={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
