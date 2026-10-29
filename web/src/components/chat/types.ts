/** Chat event types, as the chat view reads them. */
import type { ChatEvent as StoredChatEvent } from "../../types";

/** An event as chat.ts writes it. `why` is the AI's one-line reason for a command (on ask events). */
export type ChatEvent = StoredChatEvent & { why?: string };
export type ToolEvent = Extract<ChatEvent, { kind: "tool" }>;
export type ToolResult = { output: string; failed?: boolean };
export type AskEvent = Extract<ChatEvent, { kind: "ask" }>;
