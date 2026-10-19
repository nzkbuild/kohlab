/** The name a person sees for an agent: "Claude", "Hermes". An agent it does not know is shown as its own name. */
const NAMES: Record<string, string> = { claude: "Claude", hermes: "Hermes", omp: "omp", codex: "Codex", gemini: "Gemini", opencode: "OpenCode" };

export function agentName(agent: string): string {
  return Object.prototype.hasOwnProperty.call(NAMES, agent) ? NAMES[agent] : agent;
}
