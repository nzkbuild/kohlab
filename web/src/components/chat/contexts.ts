/** Contexts the chat's HTML and image frames read: the workspace id and the agent's name. */
import { createContext } from "react";

/** The workspace the reply's project pictures come from. Provided once, where the event list is drawn. */
export const WorkspaceCtx = createContext<string>("");
/** The agent's name as a person sees it ("Claude"), for the parts of the chat that speak for it. */
export const AgentCtx = createContext<string>("Claude");
