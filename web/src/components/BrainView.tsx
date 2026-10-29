import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { DownloadSimple, WarningCircle } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../api";
import type { BrainGraph, BrainHit, BrainNote, BrainNodeInfo } from "../types";
import { useApp, useCan } from "../store";
import { layout, nodeRadius, TYPE_SHAPE, type NodeShape } from "../lib/brainGraph";
import { Button, Field, SkeletonRows } from "./ui";
import ConfirmDialog from "./ConfirmDialog";

// The graph is drawn at this size, not scaled: a phone scrolls it sideways rather than shrinking 12px text.
const BOX_W = 720;
const BOX_H = 520;
const LABEL_MAX = 22;
const BODY_MAX = 8000;
const NAME_MAX = 80;
const NOT_HERE = "The project brain isn't available here.";
// Same link syntax the server reads: [[Name]], [[Name|alias]], [[Name#heading]].
const LINK = /\[\[([^\]\n|#]{1,120})(?:[#|][^\]\n]*)?\]\]/g;

/** Plain words for a failed read or write. A refusal (403, 404, 409, 413) has a sentence of its own. */
function messageOf(e: unknown): string {
  const status = (e as { status?: number }).status;
  if (status === 403) return NOT_HERE;
  if (status === 404) return "That note isn't here any more.";
  if (status === 409) return "The project brain is full. Delete a note to make room.";
  if (status === 413) return "That's too long to save.";
  return e instanceof Error && e.message ? e.message : "Something went wrong. Try again.";
}

const shortLabel = (name: string) => ([...name].length > LABEL_MAX ? `${[...name].slice(0, LABEL_MAX - 1).join("")}…` : name);
const dateText = (ms: number) => new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
const hexPoints = (r: number) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return `${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`;
  }).join(" ");

/** One note's shape, drawn around the origin. Filled shapes take the text colour; the ring is an outline. */
function Glyph({ shape, r }: { shape: NodeShape; r: number }) {
  const fill = "fill-text-secondary";
  switch (shape) {
    case "circle":
      return <circle r={r} className={fill} />;
    case "square":
      return <rect x={-r} y={-r} width={2 * r} height={2 * r} rx={2} className={fill} />;
    case "diamond":
      return <polygon points={`0,${-r} ${r},0 0,${r} ${-r},0`} className={fill} />;
    case "triangle":
      return <polygon points={`0,${-r} ${r},${r * 0.8} ${-r},${r * 0.8}`} className={fill} />;
    case "hexagon":
      return <polygon points={hexPoints(r)} className={fill} />;
    case "ring":
      return <circle r={r} fill="none" strokeWidth={2} className="stroke-text-secondary" />;
    case "pill":
      return <rect x={-2 * r} y={-0.6 * r} width={4 * r} height={1.2 * r} rx={0.6 * r} className={fill} />;
  }
}

/** Body text with [[Name]] links: a button when the note exists, muted text when it does not. */
function BodyText({ body, resolve, onOpen }: { body: string; resolve: (target: string) => string | null; onOpen: (name: string) => void }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of body.matchAll(LINK)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(body.slice(last, at));
    const target = m[1].trim();
    const real = resolve(target);
    parts.push(
      real ? (
        // A link in prose: marked so the size rule (DESIGN.md: links in prose are out of scope) can leave it out.
        <button key={key++} type="button" data-prose-link className="text-text-primary underline underline-offset-2" onClick={() => onOpen(real)}>
          {target}
        </button>
      ) : (
        <span key={key++} className="text-text-muted">
          {target}
        </span>
      ),
    );
    last = at + m[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return <p className="whitespace-pre-wrap break-words text-base leading-relaxed text-text-secondary">{parts}</p>;
}

/** Plain muted line with an icon: a failure is never red. */
function MutedLine({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-start gap-2 text-sm text-text-muted">
      <WarningCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

interface Props {
  workspaceId: string;
}

/**
 * The project brain: the notes Kohlab keeps for a chat project, drawn as a graph with a list beside it, and one note open at a time.
 * The page is keyed by project, so this view starts fresh for each one.
 */
export default function BrainView({ workspaceId }: Props) {
  const can = useCan();
  const pending = useApp((s) => s.brainNote);
  const setBrainNote = useApp((s) => s.setBrainNote);

  const [graph, setGraph] = useState<BrainGraph | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped after a save or delete, so the graph and the open note are read again.
  const [rev, setRev] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<BrainNote | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [editing, setEditing] = useState<"edit" | "new" | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState("");
  // The server's hits, kept with the query they answer, so a stale list never shows under a new query.
  const [hits, setHits] = useState<{ q: string; hits: BrainHit[] } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  const bump = () => setRev((r) => r + 1);

  // A Run panel title: open that note once, then clear it so it does not come back on the next visit.
  useEffect(() => {
    if (!pending) return;
    setSelected(pending);
    setEditing(null);
    setBrainNote(null);
  }, [pending, setBrainNote]);

  useEffect(() => {
    let live = true;
    api.brain(workspaceId).then(
      (g) => {
        if (!live) return;
        setGraph(g);
        setLoadError(null);
      },
      (e: unknown) => {
        if (live) setLoadError(messageOf(e));
      },
    );
    return () => {
      live = false;
    };
  }, [workspaceId, rev]);

  useEffect(() => {
    if (!selected) {
      setNote(null);
      setNoteError(null);
      return;
    }
    let live = true;
    api.brainNote(workspaceId, selected).then(
      (n) => {
        if (!live) return;
        setNote(n);
        setNoteError(null);
      },
      (e: unknown) => {
        if (!live) return;
        setNote(null);
        setNoteError(messageOf(e));
      },
    );
    return () => {
      live = false;
    };
  }, [workspaceId, selected, rev]);

  const trimmed = query.trim();
  useEffect(() => {
    if (!trimmed) {
      setHits(null);
      return;
    }
    let live = true;
    // A short wait so typing does not send a request per key.
    const t = setTimeout(() => {
      api.brainSearch(workspaceId, trimmed).then(
        (r) => {
          if (live) setHits({ q: trimmed, hits: r.hits });
        },
        () => {
          if (live) setHits({ q: trimmed, hits: [] });
        },
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [workspaceId, trimmed]);

  // Laid out once per graph load: the same graph always draws the same way, and nothing moves while you look.
  const positions = useMemo(() => (graph ? layout(graph.nodes.map((n) => ({ id: n.name })), graph.edges, BOX_W, BOX_H) : new Map<string, { x: number; y: number }>()), [graph]);
  const byLower = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.name.toLowerCase(), n.name] as const)), [graph]);
  const activeHits = hits && hits.q === trimmed ? hits.hits : null;
  const matchSet = trimmed && activeHits ? new Set(activeHits.map((h) => h.name.toLowerCase())) : null;
  const hitByLower = new Map((activeHits ?? []).map((h) => [h.name.toLowerCase(), h] as const));
  const shown = (name: string) => !matchSet || matchSet.has(name.toLowerCase());
  const resolve = (target: string) => byLower.get(target.toLowerCase()) ?? null;

  const select = (name: string) => {
    setSelected(name);
    setEditing(null);
    setSaveError(null);
  };

  const startNew = () => {
    setSelected(null);
    setDraftName("");
    setDraftBody("");
    setSaveError(null);
    setEditing("new");
  };

  const startEdit = () => {
    if (!note) return;
    setDraftBody(note.body);
    setSaveError(null);
    setEditing("edit");
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const name = editing === "new" ? draftName.trim() : (note?.name ?? "");
      const saved = await api.putBrainNote(workspaceId, { name, body: draftBody });
      setEditing(null);
      setSelected(saved.name);
      bump();
    } catch (e) {
      setSaveError(messageOf(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!note) return;
    setDeleting(true);
    try {
      await api.deleteBrainNote(workspaceId, note.name);
      setConfirming(false);
      setSelected(null);
      bump();
    } catch (e) {
      setConfirming(false);
      setNoteError(messageOf(e));
    } finally {
      setDeleting(false);
    }
  };

  const download = () => {
    api.downloadBrain(workspaceId).catch((e: Error) => toast.error(`Couldn't download the project brain. ${e.message}`));
  };

  const onNodeKey = (e: KeyboardEvent<SVGGElement>, name: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select(name);
    }
  };

  const refused = loadError === NOT_HERE;
  const empty = graph !== null && graph.nodes.every((n) => n.source === "seed");
  const listNodes: BrainNodeInfo[] = graph ? graph.nodes.filter((n) => shown(n.name)) : [];
  const panelOpen = editing !== null || selected !== null;

  const graphArea = (() => {
    if (loadError !== null) {
      return refused ? (
        <MutedLine>{NOT_HERE}</MutedLine>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <MutedLine>{loadError}</MutedLine>
          <Button variant="secondary" size="sm" onClick={bump}>
            Try again
          </Button>
        </div>
      );
    }
    if (!graph) return <SkeletonRows rows={4} />;
    if (empty) return <p className="text-base text-text-muted">Kohlab remembers goals, decisions and handoffs here as you work.</p>;
    return (
      <>
        <div className="overflow-auto">
          <svg role="img" className="h-auto w-full min-w-[560px] max-w-[720px]" aria-label="Project brain graph" width={BOX_W} height={BOX_H} viewBox={`0 0 ${BOX_W} ${BOX_H}`}>
            {graph.edges.map(([a, b]) => {
              const p = positions.get(a);
              const q = positions.get(b);
              if (!p || !q || !shown(a) || !shown(b)) return null;
              return <line key={`${a}\u0000${b}`} data-brain-edge x1={p.x} y1={p.y} x2={q.x} y2={q.y} strokeWidth={1} className="stroke-line-strong" />;
            })}
            {graph.nodes.map((node) => {
              const p = positions.get(node.name);
              if (!p || !shown(node.name)) return null;
              const r = nodeRadius(node.degree);
              const isSelected = selected === node.name;
              const isFocused = focused === node.name;
              return (
                <g
                  key={node.name}
                  data-brain-node
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.name}, ${node.type}`}
                  transform={`translate(${p.x} ${p.y})`}
                  className="cursor-pointer outline-none"
                  onClick={() => select(node.name)}
                  onKeyDown={(e) => onNodeKey(e, node.name)}
                  onFocus={() => setFocused(node.name)}
                  onBlur={() => setFocused(null)}
                >
                  {/* A transparent disc takes the click and the touch around the shape, not only on the shape itself. */}
                  <circle r={r + 6} fill="transparent" />
                  {isSelected || isFocused ? <circle r={r + 5} fill="none" strokeWidth={2} className={isSelected ? "stroke-text-primary" : "stroke-focus"} /> : null}
                  <Glyph shape={TYPE_SHAPE[node.type]} r={r} />
                  <text y={r + 16} textAnchor="middle" className="fill-text-secondary text-xs">
                    {shortLabel(node.name)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {trimmed && listNodes.length === 0 && activeHits ? <p className="text-sm text-text-muted">No notes match.</p> : null}
        <ul aria-label="All notes" className="flex flex-col gap-1">
          {listNodes.map((node) => {
            const snippet = hitByLower.get(node.name.toLowerCase())?.snippet;
            return (
              <li key={node.name} className="flex flex-col">
                <button
                  type="button"
                  onClick={() => select(node.name)}
                  aria-current={selected === node.name ? "true" : undefined}
                  className={`flex min-h-11 w-full items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-hover ${selected === node.name ? "bg-surface-active" : ""}`}
                >
                  <span className="min-w-0 truncate text-text-primary">{node.name}</span>
                  <span className="shrink-0 text-xs text-text-muted">{node.type}</span>
                </button>
                {snippet ? <span className="px-3 text-sm text-text-muted">{snippet}</span> : null}
              </li>
            );
          })}
        </ul>
        {graph.summary.tokens > 0 ? (
          <p className="text-xs text-text-muted">The AI gets a short summary of this at the start of each chat (about {graph.summary.tokens} tokens).</p>
        ) : null}
      </>
    );
  })();

  const panel = (() => {
    if (editing === "new") {
      return (
        <div className="flex flex-col gap-4">
          <h2 className="text-xl font-semibold text-text-primary">New note</h2>
          <Field label="Name" htmlFor="brain-new-name">
            <input id="brain-new-name" className="field-input w-full" maxLength={NAME_MAX} value={draftName} onChange={(e) => setDraftName(e.target.value)} />
          </Field>
          <textarea aria-label="Note text" className="field-input min-h-48 w-full resize-y" maxLength={BODY_MAX} value={draftBody} onChange={(e) => setDraftBody(e.target.value)} />
          {saveError ? <MutedLine>{saveError}</MutedLine> : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={saving || !draftName.trim()} onClick={() => void save()}>
              Save
            </Button>
            <Button variant="quiet" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      );
    }
    if (noteError && !note) return <MutedLine>{noteError}</MutedLine>;
    if (!note) return <SkeletonRows rows={3} />;
    if (editing === "edit") {
      return (
        <div className="flex flex-col gap-4">
          <h2 className="text-xl font-semibold text-text-primary">{note.name}</h2>
          <textarea aria-label="Note text" className="field-input min-h-48 w-full resize-y" maxLength={BODY_MAX} value={draftBody} onChange={(e) => setDraftBody(e.target.value)} />
          {saveError ? <MutedLine>{saveError}</MutedLine> : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              Save
            </Button>
            <Button variant="quiet" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold text-text-primary">{note.name}</h2>
          <p className="text-sm text-text-muted tabular-nums">
            {note.type}
            {note.status ? ` · ${note.status}` : ""} · {dateText(note.updated)}
          </p>
        </div>
        {note.body.trim() ? <BodyText body={note.body} resolve={resolve} onOpen={select} /> : <p className="text-base text-text-muted">This note is empty.</p>}
        {note.backlinks.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-text-secondary">Linked from</h3>
            <ul className="flex flex-col gap-1">
              {note.backlinks.map((b) => (
                <li key={b.name}>
                  <button type="button" className="flex min-h-11 w-full items-center rounded-lg px-2 text-left text-sm text-text-primary hover:bg-surface-hover" onClick={() => select(b.name)}>
                    {b.name}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {noteError ? <MutedLine>{noteError}</MutedLine> : null}
        {can.mutate ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={startEdit}>
              Edit
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          </div>
        ) : null}
      </div>
    );
  })();

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 min-[56.25rem]:flex-row min-[56.25rem]:overflow-hidden">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 min-[56.25rem]:overflow-y-auto">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            aria-label="Search notes"
            placeholder="Search notes"
            className="field-input min-w-0 flex-1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {can.mutate ? (
            <Button variant="secondary" onClick={startNew}>
              New note
            </Button>
          ) : null}
          <Button variant="quiet" onClick={download}>
            <DownloadSimple size={16} aria-hidden="true" />
            Download vault for Obsidian
          </Button>
        </div>
        {graphArea}
      </section>

      {panelOpen ? (
        <aside aria-label="Note" className="flex min-w-0 shrink-0 flex-col rounded-2xl bg-surface-raised p-4 min-[56.25rem]:w-[380px] min-[56.25rem]:overflow-y-auto">
          {panel}
        </aside>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete this note?"
        description={note?.type === "Goal" ? "The goal's text is cleared. The Goal note stays." : `${note?.name ?? "This note"} is removed from the project brain. The AI forgets it.`}
        confirmLabel="Delete note"
        busy={deleting}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
