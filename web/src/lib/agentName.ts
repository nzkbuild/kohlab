/** The name a person sees for an agent: "Claude", "Hermes". An agent it does not know is shown as its own name. */
const NAMES: Record<string, string> = { claude: "Claude", hermes: "Hermes", omp: "omp", codex: "Codex", gemini: "Gemini", opencode: "OpenCode", pi: "Pi", sh: "Terminal" };

/** The AIs a project can run. "sh" (a plain terminal) and any other command are not. */
const AI_AGENTS = new Set(["claude", "hermes", "omp", "codex", "gemini", "opencode", "pi"]);

export function agentName(agent: string): string {
  return Object.prototype.hasOwnProperty.call(NAMES, agent) ? NAMES[agent] : agent;
}

export function isAiAgent(agent: string | undefined): boolean {
  return !!agent && AI_AGENTS.has(agent);
}
