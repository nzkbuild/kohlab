/** Contexts the chat's HTML and image frames read: the workspace id and the agent's name. */
import { createContext } from "react";

/** The workspace the reply's project pictures come from. Provided once, where the event list is drawn. */
export const WorkspaceCtx = createContext<string>("");
/** The agent's name as a person sees it ("Claude"), for the parts of the chat that speak for it. */
export const AgentCtx = createContext<string>("Claude");

/** The file cards of the conversation. newest: the path written last (its card opens by default). edits: how many times each file was written (the cache-bust). lastEdit: the event number of each file's latest write (where its card sits). */
export type FileCards = { newest: string | null; edits: Map<string, number>; lastEdit: Map<string, number> };
export const FileCardsCtx = createContext<FileCards>({ newest: null, edits: new Map(), lastEdit: new Map() });

