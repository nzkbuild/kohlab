/** The helper tree of a run: what each line of the CLI stream does to it, and its one-line labels. */
/** The label of a helper agent (a Task or Agent tool call): its description, else the start of its prompt. Pure. */
export function helperLabel(input: unknown): string {
  const i = (input ?? {}) as { description?: unknown; prompt?: unknown };
  const flat = (x: unknown) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "");
  const d = flat(i.description);
  const p = flat(i.prompt).slice(0, 60).trim();
  return (d || p || "a helper").slice(0, 80).trim();
}

/** One helper agent in the run view (chat snapshot helperTree). Opaque ids: parentId points at another node's id. */
export interface HelperNode {
  id: string;
  taskId: string | null;
  parentId: string | null;
  label: string;
  kind: string | null;
  model: string | null;
  status: "running" | "done" | "failed" | "stopped";
  background: boolean;
  startedAt: number;
  endedAt: number | null;
  tools: number | null;
  tokens: number | null;
  lastTool: string | null;
  summary: string | null;
  canStop: boolean;
}

const HELPER_CAP = 50;
const oneLineText = (x: unknown, n: number): string => (typeof x === "string" ? x.replace(/\s+/g, " ").trim().slice(0, n) : "");
const textOrNull = (x: unknown, n: number): string | null => oneLineText(x, n) || null;
const countOrNull = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.round(x) : null);

/** Parents before their children (an unknown parent makes a root), otherwise in the order they came. */
function orderNodes(nodes: HelperNode[]): HelperNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const out: HelperNode[] = [];
  const seen = new Set<string>();
  const visit = (n: HelperNode) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    out.push(n);
    for (const c of nodes) if (c.parentId === n.id) visit(c);
  };
  for (const n of nodes) if (!n.parentId || !ids.has(n.parentId)) visit(n);
  for (const n of nodes) visit(n); // a loop of parents: still shown
  return out;
}

/** A task event's end time as epoch ms: seconds, milliseconds or an ISO string. Null when it is none of them. */
function endTimeOf(x: unknown): number | null {
  const t = typeof x === "string" ? Date.parse(x) : typeof x === "number" ? x : NaN;
  if (!Number.isFinite(t) || t <= 0) return null;
  return t < 1e12 ? Math.round(t * 1000) : Math.round(t);
}

/** The helper agents after one line of the CLI's stream. Every field is optional: a line that is not about helpers changes nothing. Pure (returns a new list). */
export function applyHelperLine(nodes: HelperNode[], m: any, now: number): HelperNode[] {
  if (!m || typeof m !== "object") return nodes;
  const sub = m.type === "system" ? m.subtype : undefined;
  const isTask = sub === "task_started" || sub === "task_progress" || sub === "task_updated" || sub === "task_notification";
  if (!isTask && m.type !== "assistant" && m.type !== "user") return nodes;
  const list = nodes.map((n) => ({ ...n }));
  const find = (toolUseId: unknown, taskId: unknown) =>
    list.find((n) => (typeof toolUseId === "string" && toolUseId !== "" && n.id === toolUseId) || (typeof taskId === "string" && taskId !== "" && n.taskId === taskId));
  const make = (id: string, over: Partial<HelperNode> = {}): HelperNode => ({
    id, taskId: null, parentId: null, label: "a helper", kind: null, model: null, status: "running", background: false,
    startedAt: now, endedAt: null, tools: null, tokens: null, lastTool: null, summary: null, canStop: false, ...over,
  });
  const finish = (n: HelperNode, status: HelperNode["status"], at: number = now) => {
    n.status = status;
    n.endedAt ??= at;
  };
  if (m.type === "assistant") {
    const parent = typeof m.parent_tool_use_id === "string" && m.parent_tool_use_id ? m.parent_tool_use_id : null;
    const blocks: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
    if (parent) {
      const n = list.find((x) => x.id === parent);
      if (n) {
        const model = textOrNull(m.message?.model, 100);
        if (model) n.model = model;
        const last = [...blocks].reverse().find((b) => b?.type === "tool_use" && typeof b.name === "string");
        if (last) n.lastTool = oneLineText(last.name, 100);
      }
    }
    for (const b of blocks) {
      if (b?.type !== "tool_use" || (b.name !== "Agent" && b.name !== "Task") || typeof b.id !== "string" || !b.id) continue;
      const have = find(b.id, null);
      const kind = textOrNull(b.input?.subagent_type, 60);
      const model = textOrNull(b.input?.model, 100);
      if (have) {
        have.kind ??= kind;
        have.model ??= model;
        continue;
      }
      list.push(make(b.id, { parentId: parent, label: helperLabel(b.input), kind, model, background: b.input?.run_in_background === true }));
    }
  } else if (m.type === "user") {
    for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
      if (b?.type !== "tool_result") continue;
      const n = find(b.tool_use_id, null);
      // a helper started in the background answers its call at once and goes on
      if (n && n.status === "running" && !n.background) finish(n, b.is_error ? "failed" : "done");
    }
  } else if (sub === "task_started") {
    const tuid = typeof m.tool_use_id === "string" && m.tool_use_id ? m.tool_use_id : null;
    const tid = typeof m.task_id === "string" && m.task_id ? m.task_id : null;
    if (!tuid && !tid) return nodes;
    let n = find(tuid, tid);
    if (!n) {
      // a background command is a task too, but not a helper
      if (typeof m.task_type === "string" && /bash|shell/i.test(m.task_type) && !m.subagent_type) return nodes;
      n = make(tuid ?? `task:${tid}`, { label: oneLineText(m.description, 80) || "a helper" });
      list.push(n);
    } else if (n.label === "a helper") n.label = oneLineText(m.description, 80) || n.label;
    n.taskId ??= tid;
    n.kind ??= textOrNull(m.subagent_type, 60);
    if (m.is_backgrounded === true) n.background = true;
    if (!n.parentId && typeof m.parent_task_id === "string" && m.parent_task_id) n.parentId = list.find((x) => x.taskId === m.parent_task_id)?.id ?? `task:${m.parent_task_id}`;
  } else if (sub === "task_progress") {
    const n = find(m.tool_use_id, m.task_id);
    if (!n) return nodes;
    const tools = countOrNull(m.usage?.tool_uses);
    const tokens = countOrNull(m.usage?.total_tokens);
    if (tools !== null) n.tools = tools;
    if (tokens !== null) n.tokens = tokens;
    const last = textOrNull(m.last_tool_name, 100);
    if (last) n.lastTool = last;
    const summary = textOrNull(m.summary, 200);
    if (summary) n.summary = summary;
  } else if (sub === "task_updated") {
    const n = find(null, m.task_id);
    if (!n) return nodes;
    const patch = m.patch ?? {};
    const to = patch.status === "completed" ? "done" : patch.status === "failed" ? "failed" : patch.status === "killed" ? "stopped" : patch.status === "pending" || patch.status === "running" || patch.status === "paused" ? "running" : null;
    if (to && to !== "running") {
      n.status = to;
      n.endedAt ??= endTimeOf(patch.end_time) ?? now;
    } else if (to === "running" && n.status === "running") n.endedAt = null;
    if (typeof patch.is_backgrounded === "boolean") n.background = patch.is_backgrounded;
    const err = textOrNull(patch.error, 200);
    if (err && n.status === "failed") n.summary = err;
  } else if (sub === "task_notification") {
    const n = find(m.tool_use_id, m.task_id);
    if (!n) return nodes;
    const to = m.status === "completed" ? "done" : m.status === "failed" ? "failed" : m.status === "stopped" ? "stopped" : null;
    if (to) finish(n, to);
    const summary = textOrNull(m.summary, 200);
    if (summary) n.summary = summary;
    const tools = countOrNull(m.usage?.tool_uses);
    const tokens = countOrNull(m.usage?.total_tokens);
    if (tools !== null) n.tools = tools;
    if (tokens !== null) n.tokens = tokens;
  }
  while (list.length > HELPER_CAP) {
    const old = list.findIndex((n) => n.status !== "running");
    list.splice(old < 0 ? 0 : old, 1);
  }
  return orderNodes(list);
}

/** A new turn: helpers that finished are gone, the ones still running in the background stay. */
export const helpersNewTurn = (nodes: HelperNode[]): HelperNode[] => nodes.filter((n) => n.status === "running");
/** A turn's result: helpers working in the foreground are done, background ones go on. */
export const helpersAtResult = (nodes: HelperNode[], now: number): HelperNode[] =>
  nodes.map((n) => (n.status === "running" && !n.background ? { ...n, status: "done" as const, endedAt: now } : n));
/** The process ended: nothing is running any more. */
export const helpersAtExit = (nodes: HelperNode[], now: number): HelperNode[] =>
  nodes.map((n) => (n.status === "running" ? { ...n, status: "stopped" as const, endedAt: now } : n));

/** The model and token count a done line carries, from the turn's result line. Each is left out when unknown. Pure. */
export function doneFields(model: unknown, usage: unknown): { model?: string; tokens?: { in: number; out: number } } {
  const u = (usage ?? {}) as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
  const parts = [n(u.input_tokens), n(u.cache_read_input_tokens), n(u.cache_creation_input_tokens)];
  const out = n(u.output_tokens);
  const known = parts.some((x) => x !== null) || out !== null;
  return {
    ...(typeof model === "string" && model ? { model } : {}),
    ...(known ? { tokens: { in: parts.reduce<number>((a, x) => a + (x ?? 0), 0), out: out ?? 0 } } : {}),
  };
}
