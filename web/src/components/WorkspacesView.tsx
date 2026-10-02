import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  DotsThree,
  GithubLogo,
  LinkSimple,
  MagnifyingGlass,
  Play,
  Plus,
  Robot,
  Rocket,
  Stop,
  TerminalWindow,
  Trash,
} from "@phosphor-icons/react";
import { api } from "../api";
import { useApp } from "../store";
import { announce } from "../lib/announce";
import { toastAction, withToast } from "../lib/actions";
import { relativeTime } from "../lib/format";
import { STATUS_LABEL, byReviewFirst, workspaceStatus, type WorkspaceStatus } from "../lib/status";
import { AGENT_CATALOG } from "../types";
import type { Workspace } from "../types";
import { Button, EmptyState, Field, Menu, MenuItem, MenuSub, PageHeader, Panel, StatusChip, Tab, TabList, TabPanel, Tabs } from "./ui";
import { ActivityPanel, AgentsPanel, ReviewQueue } from "./HomePanels";
import ConfirmDialog from "./ConfirmDialog";

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
 * status call failed) — it must never be the primary source.
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
export function NewWorkspaceForm({ onCancel }: { onCancel?: () => void }) {
  const refresh = useApp((s) => s.refresh);
  const navigate = useApp((s) => s.navigate);
  const { names: agentNames, reported } = useAgentOptions();

  const [task, setTask] = useState("");
  const [repo, setRepo] = useState("");
  const [agent, setAgent] = useState("");
  const [timeoutSec, setTimeoutSec] = useState("");
  const [memoryMb, setMemoryMb] = useState("");
  const [busy, setBusy] = useState(false);

  const [repos, setRepos] = useState<string[] | null>(null);
  const [reposBusy, setReposBusy] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);

  // The server list may land after first paint; fall back rather than sit empty.
  const chosenAgent = agent || agentNames[0] || "";

  const loadRepos = async () => {
    setReposBusy(true);
    setReposError(null);
    try {
      const res = await api.ghRepos();
      setRepos(res.repos);
      if (!res.authed) setReposError("GitHub is not authenticated on this server — paste a path or URL instead.");
      else if (res.repos.length === 0) setReposError("GitHub returned no repositories for this account.");
    } catch (e) {
      setRepos([]);
      setReposError((e as Error).message);
    }
    setReposBusy(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !task.trim() || !chosenAgent) return;
    const trimmed = repo.trim();
    const limits =
      timeoutSec || memoryMb
        ? {
            timeoutSec: timeoutSec ? Number(timeoutSec) : undefined,
            maxMemoryMb: memoryMb ? Number(memoryMb) : undefined,
          }
        : undefined;
    setBusy(true);
    try {
      const created = await withToast("Creating workspace", () =>
        /^https?:\/\//.test(trimmed)
          ? api.clone({ url: trimmed, task: task.trim(), agent: chosenAgent, limits })
          : api.create({ task: task.trim(), repo: trimmed || undefined, agent: chosenAgent, limits }),
      );
      await refresh();
      announce(`${created.id} created — the agent is starting`);
      navigate({ kind: "workspace", id: created.id });
    } catch {
      /* withToast already reported the reason */
    }
    setBusy(false);
  };

  return (
    <Panel className="p-4">
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Field label="Task" htmlFor="new-workspace-task" help="What the agent should do. One workspace is one task.">
          <input
            id="new-workspace-task"
            className="field-input"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="fix the billing rounding bug"
            autoFocus
          />
        </Field>

        <Field
          label="Repository"
          htmlFor="new-workspace-repo"
          help={reposError ?? "A path on the server, or a GitHub URL (cloned into a new workspace)."}
        >
          <div className="flex gap-2">
            <input
              id="new-workspace-repo"
              className="field-input"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="/srv/repos/app or https://github.com/owner/name"
            />
            <Button onClick={() => void loadRepos()} disabled={reposBusy}>
              <GithubLogo size={15} />
              {reposBusy ? "loading…" : "github"}
            </Button>
          </div>
        </Field>

        {repos && repos.length > 0 ? (
          <select
            className="field-select"
            aria-label="Pick a GitHub repository"
            value=""
            onChange={(e) => {
              if (e.target.value) setRepo(asCloneUrl(e.target.value));
            }}
          >
            <option value="">pick a repository…</option>
            {repos.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : null}

        <Field
          label="Agent"
          htmlFor="new-workspace-agent"
          help={reported ? "Reported as installed by this server." : "This server reports none installed — showing every known agent."}
        >
          <select
            id="new-workspace-agent"
            className="field-select"
            value={chosenAgent}
            onChange={(e) => setAgent(e.target.value)}
          >
            {agentNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid gap-3 shell:grid-cols-2">
          <Field label="Timeout" htmlFor="new-workspace-timeout" help="Optional cap in seconds.">
            <input
              id="new-workspace-timeout"
              type="number"
              inputMode="numeric"
              className="field-input"
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(e.target.value)}
              placeholder="no limit"
            />
          </Field>
          <Field label="Memory cap" htmlFor="new-workspace-memory" help="Optional cap in MB.">
            <input
              id="new-workspace-memory"
              type="number"
              inputMode="numeric"
              className="field-input"
              value={memoryMb}
              onChange={(e) => setMemoryMb(e.target.value)}
              placeholder="no limit"
            />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2">
          {onCancel ? (
            <Button variant="quiet" onClick={onCancel}>
              cancel
            </Button>
          ) : null}
          <Button type="submit" variant="primary" disabled={busy || !task.trim() || !chosenAgent}>
            <Rocket size={15} weight="fill" />
            {busy ? "creating…" : "create & start"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/* --------------------------------------------------------------- open menu -- */

/**
 * The page-level entry into existing work: a fresh shell or a relaunched agent
 * in any workspace. Creating a workspace stays in the sidebar.
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
    navigate({ kind: "workspace", id });
  };

  const runAgent = async (w: Workspace) => {
    const action = w.running ? "restart" : "start";
    try {
      await toastAction(w.id, action);
      await refresh();
      announce(`${w.id} agent ${action === "start" ? "starting" : "restarting"}`);
      navigate({ kind: "workspace", id: w.id });
    } catch {
      /* toastAction already reported the reason */
    }
  };

  return (
    <Menu
      label="Open a terminal or agent"
      trigger={
        <Button variant="primary" disabled={workspaces.length === 0}>
          <TerminalWindow size={15} weight="bold" />
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

/**
 * Home: the review queue first, then every workspace (search, status filter,
 * per-row actions), then activity and agents as context.
 */
export default function WorkspacesView() {
  const workspaces = useApp((s) => s.workspaces);
  const navigate = useApp((s) => s.navigate);
  const refresh = useApp((s) => s.refresh);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const creating = useApp((s) => s.creating);
  const setCreating = useApp((s) => s.setCreating);
  const [pendingDelete, setPendingDelete] = useState<Workspace | null>(null);
  const [deleting, setDeleting] = useState(false);

  const counts = useMemo(() => {
    const by: Record<Filter, number> = {
      all: workspaces.length,
      running: 0,
      "needs-review": 0,
      committed: 0,
      stopped: 0,
    };
    for (const w of workspaces) by[workspaceStatus(w)] += 1;
    return by;
  }, [workspaces]);

  const trimmedQuery = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      workspaces
        .filter((w) => (filter === "all" || workspaceStatus(w) === filter) && matches(w, trimmedQuery))
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
        return navigator.clipboard
          .writeText(url)
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
        <PageHeader
          title="Workspaces"
          description="Every task an agent has been given on this server. Work waiting for review comes first."
          actions={<OpenMenu workspaces={workspaces} />}
        />

        <div id="new-workspace">
          {creating ? (
            <div className="mt-4">
              <NewWorkspaceForm onCancel={() => setCreating(false)} />
            </div>
          ) : null}
        </div>

        <ReviewQueue workspaces={workspaces} />

        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} className="mt-6">

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="relative min-w-56 flex-1">
            <MagnifyingGlass
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
              aria-hidden="true"
            />
            <input
              type="search"
              className="field-input pl-8"
              aria-label="Search workspaces by id, task or agent"
              placeholder="search id, task or agent"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <span className="tnum text-xs text-text-muted">
            {visible.length} of {workspaces.length}
          </span>
        </div>

        <TabList label="Filter workspaces by status">
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
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    new workspace
                  </Button>
                }
              />
            </Panel>
          ) : visible.length === 0 ? (
            /* The system has data; the filter excluded it. Creation is the wrong
               offer here — the way out is to widen the filter again. */
            <Panel>
              <EmptyState
                icon={<MagnifyingGlass size={18} />}
                title={`No workspaces match ${describedFilter}`}
                description="Nothing is hidden — the filter is just narrower than the list."
                action={<Button onClick={clearFilters}>clear filters</Button>}
              />
            </Panel>
          ) : (
            <>
              <Panel className="hidden overflow-hidden shell:block">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Workspace</th>
                      <th scope="col">Task</th>
                      <th scope="col">Status</th>
                      <th scope="col">Agent</th>
                      <th scope="col">Age</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((w) => {
                      const status = workspaceStatus(w);
                      return (
                        <tr key={w.id}>
                          <th scope="row" className="normal-case tracking-normal">
                            <span className="mono text-sm font-medium text-text-primary">{w.id}</span>
                          </th>
                          <td className="max-w-md truncate text-text-secondary">{w.task}</td>
                          <td>
                            <StatusChip status={status} />
                          </td>
                          <td className="mono text-xs text-text-muted">{w.agent}</td>
                          <td className="tnum text-xs text-text-muted">{relativeTime(w.created)}</td>
                          <td>
                            <div className="row-actions flex items-center justify-end gap-1">
                              <Button
                                variant="quiet"
                                iconOnly
                                size="sm"
                                aria-label={`open ${w.id}`}
                                onClick={() => navigate({ kind: "workspace", id: w.id })}
                              >
                                <ArrowSquareOut size={14} />
                              </Button>
                              <Button
                                variant="quiet"
                                iconOnly
                                size="sm"
                                aria-label={`${w.running ? "stop" : "start"} ${w.id}`}
                                onClick={() => void toggle(w)}
                              >
                                {w.running ? <Stop size={14} /> : <Play size={14} />}
                              </Button>
                              <Button
                                variant="quiet"
                                iconOnly
                                size="sm"
                                aria-label={`copy share link for ${w.id}`}
                                onClick={() => void share(w)}
                              >
                                <LinkSimple size={14} />
                              </Button>
                              <Button
                                variant="quiet"
                                iconOnly
                                size="sm"
                                aria-label={`delete ${w.id}`}
                                onClick={() => setPendingDelete(w)}
                              >
                                <Trash size={14} />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Panel>

              {/* Below the shell breakpoint a table reflows into one card per
                  workspace with a single primary action — never a sideways scroll. */}
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
                        <ArrowSquareOut size={14} />
                        open
                      </Button>
                      <Menu
                        label={`More actions for ${w.id}`}
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
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </TabPanel>
        </Tabs>

        <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-2">
          <ActivityPanel workspaces={workspaces} />
          <AgentsPanel />
        </div>
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
