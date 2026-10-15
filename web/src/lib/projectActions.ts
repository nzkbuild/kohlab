import { toast } from "sonner";
import { api } from "../api";
import { useApp } from "../store";
import type { Workspace } from "../types";

export type ModelChoice = "opus" | "sonnet" | "haiku" | "default";

/** Names as the project menu, the palette and the status bar show them. */
export const MODEL_LABEL: Record<ModelChoice, string> = {
  opus: "Opus 5.5",
  sonnet: "Sonnet 5.5",
  haiku: "Haiku 5.5",
  default: "Account default",
};

/** Workspace.model is undefined until someone picks one: that is the account default. */
export function modelOf(w: Workspace | undefined): ModelChoice {
  return w?.model ?? "default";
}

/** Continue needs a conversation to resume: a chat with no messages has no session yet. */
export function canContinue(w: Workspace | undefined): boolean {
  return !!w?.chat && !!w.chatSession;
}

/** Saves the model, then refreshes the list. Errors are shown, never thrown. */
export async function changeModel(w: Workspace, model: ModelChoice): Promise<void> {
  try {
    await api.setModel(w.id, model);
    await useApp.getState().refresh();
    const name = model === "default" ? "the account default" : MODEL_LABEL[model];
    toast.success(w.chat ? `Claude will use ${name} from the next message` : `Claude will use ${name} after Restart Claude`);
  } catch (e) {
    toast.error(`Could not change the model, ${(e as Error).message}`);
  }
}
