/** The chat transcript on disk: where it lives, the read cursor, and how a transcript becomes chat events. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKS_DIR } from "./lib";
import { describeTool, toolFile, toolDetail, resultText, noticeText, taskFinishedLine } from "./chat-text";
import type { Body } from "./chat-text";

export const chatsDir = () => join(WORKS_DIR, "chats");
export const transcriptPath = (id: string) => join(chatsDir(), `${id}.jsonl`);
export const cursorPath = (id: string) => join(chatsDir(), `${id}.cursor.json`);
/** A terminal project's first import reads at most this many bytes of Claude's transcript, and shows its last FIRST_IMPORT events. */
export const TAIL_BYTES = 8 * 1024 * 1024;
export const FIRST_IMPORT = 300;

/** Claude Code's transcript for a session: under the home, in a folder named after the worktree path. */
export function transcriptFile(home: string, cwd: string, sid: string, configDir?: string): string {
  return join(configDir ?? join(home, ".claude"), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sid}.jsonl`);
}

/** How far into a terminal project's transcript the chat has read, for one session. */
export function readCursor(id: string): { sid: string; offset: number } | null {
  try {
    const c = JSON.parse(readFileSync(cursorPath(id), "utf8"));
    return typeof c.sid === "string" && Number.isSafeInteger(c.offset) && c.offset >= 0 ? c : null;
  } catch {
    return null;
  }
}

export function writeCursor(id: string, sid: string, offset: number) {
  mkdirSync(chatsDir(), { recursive: true, mode: 0o700 });
  writeFileSync(cursorPath(id), JSON.stringify({ sid, offset }), { mode: 0o600 });
}

/** Bookkeeping tools whose calls are not shown as steps (the checklist already shows the tasks). */
export const HIDDEN_TOOLS = new Set(["TodoWrite", "ToolSearch", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop"]);

/** Claude Code's transcript lines as chat events: what the person wrote and what Claude said and did. Pure. */
export function transcriptEvents(lines: string[], cwd: string): Body[] {
  const out: Body[] = [];
  const shown = new Set<string>(); // tool ids whose line this call emitted: their results follow in the same lines
  for (const line of lines) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      continue; // a torn or foreign line: skip it
    }
    if (!m || typeof m !== "object" || m.isSidechain || m.isMeta) continue; // a helper agent's work, or a note for Claude itself
    // a compaction note: one quiet line. Model switches are live-only, so they are not read from the transcript.
    if (m.type === "system" && m.subtype === "compact_boundary") out.push({ kind: "note", text: noticeText(m) ?? "" });
    if (m.type === "user") {
      const content = m.message?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type !== "tool_result" || !shown.has(b.tool_use_id)) continue;
        shown.delete(b.tool_use_id);
        const output = resultText(b.content);
        if (output !== "" || b.is_error) out.push({ kind: "result", toolId: b.tool_use_id, output, ...(b.is_error ? { failed: true } : {}) });
      }
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) text = content.map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
      text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
      // a slash command's own bookkeeping, not a message
      if (!text || ["<command-name>", "<local-command", "<command-message>"].some((p) => text.startsWith(p))) continue;
      // a background task's note to Claude: one quiet line; a helper's message to Claude: not the person's
      if (text.startsWith("<task-notification>")) {
        out.push({ kind: "note", text: taskFinishedLine(text) });
        continue;
      }
      if (text.startsWith("<agent-message")) continue;
      out.push({ kind: "user", text });
    } else if (m.type === "assistant") {
      for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) out.push({ kind: "assistant", text: b.text.trim() });
        else if (b?.type === "tool_use" && typeof b.name === "string" && !HIDDEN_TOOLS.has(b.name)) {
          const detail = toolDetail(b.name, b.input ?? {}, cwd);
          const file = toolFile(b.name, b.input ?? {}, cwd);
          shown.add(b.id);
          out.push({ kind: "tool", text: describeTool(b.name, b.input ?? {}, cwd), toolId: b.id, ...(detail !== undefined ? { detail } : {}), ...(file !== undefined ? { file } : {}) });
        }
      }
    }
  }
  return out;
}
