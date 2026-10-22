/**
 * Problem text: the plain-English summary and the message that asks the AI to fix
 * it. Pure, so scripts/check-problems-text.mjs can test it.
 */

export interface ProblemLike {
  kind: "console" | "page" | "request" | "devserver";
  text: string;
  detail?: string;
}

const LABEL: Record<ProblemLike["kind"], string> = {
  console: "console error",
  page: "page error",
  request: "failed request",
  devserver: "app start",
};

/** The file a failed request was for, when its text names one ("GET 404 https://x.test/img/logo.png" gives "logo.png"). */
function fileName(text: string): string {
  const name = text
    .split(/\s+/)
    .map((w) => (w.split(/[?#]/)[0] ?? "").split("/").pop() ?? "")
    .find((w) => /^[\w@.-]+\.[a-z0-9]{1,8}$/i.test(w));
  return name ? name.slice(0, 60) : "";
}

function oneSummary(p: ProblemLike): string {
  if (p.kind === "devserver") return "Your app didn't start.";
  if (p.kind === "request") {
    const name = fileName(p.text);
    return name ? `A part of the page didn't load (${name}).` : "A part of the page didn't load.";
  }
  return "The page showed an error.";
}

/** One sentence for the first problem, and a count when there are more. Empty when there are none. */
export function problemSummary(problems: readonly ProblemLike[]): string {
  const first = problems[0];
  if (!first) return "";
  const one = oneSummary(first);
  return problems.length > 1 ? `${one} There are ${problems.length} problems in all.` : one;
}

/** The most characters one message to the AI carries (the chat allows 20 000). */
export const MAX_MESSAGE = 12_000;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The chat message that asks the AI to fix the problems. One line per problem,
 * inside a code fence longer than any run of backticks in it, so page text
 * cannot close the fence or start markdown.
 */
export function problemsMessage(problems: readonly ProblemLike[]): string {
  // The chat takes 20 000 characters; stay well under, shortening the details first and then the headlines.
  const head = (p: ProblemLike) => `[${LABEL[p.kind]}] ${oneLine(p.text)}`.slice(0, 400);
  const heads = problems.map(head);
  const room = Math.max(0, MAX_MESSAGE - 300 - heads.reduce((n, h) => n + h.length + 3, 0));
  const share = Math.floor(room / Math.max(1, problems.length));
  const body = problems
    .map((p, i) => {
      const detail = p.detail ? oneLine(p.detail) : "";
      const cut = detail.length > share ? `${detail.slice(0, Math.max(0, share - 1))}…` : detail;
      return cut ? `${heads[i]}: ${cut}` : heads[i];
    })
    .join("\n");
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `The page has a problem. Please find out what's wrong, fix it, then check the page again.\n\n${fence}text\n${body}\n${fence}`;
}
