/** Words that say nothing about what a project is. */
const FILLER = new Set([
  "a", "an", "the", "my", "me", "i", "id", "for", "to", "of", "and", "or", "in", "on", "with", "that", "which",
  "is", "it", "so", "please", "make", "build", "create", "write", "want", "need", "some", "can", "you", "us", "our", "be",
  "this", "just", "would", "like", "thats", "called", "named",
]);

/**
 * A folder name from the first idea someone types: up to five meaningful words,
 * lowercase, [a-z0-9-] only, 40 characters at most. A name someone capitalised
 * (not the first word, like "Crumb") is kept even past the fifth word.
 */
export function projectNameFromIdea(text: string): string {
  const words = text
    .replace(/['’]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .map((t, i) => ({ w: t.toLowerCase(), proper: i > 0 && /^[A-Z][a-z]/.test(t) }))
    .filter((t) => t.w && !FILLER.has(t.w));
  let pick = words.slice(0, 5).map((t) => t.w);
  const proper = words.find((t) => t.proper)?.w;
  if (proper && !pick.includes(proper)) pick = [...words.slice(0, 4).map((t) => t.w), proper];
  let name = "";
  for (const w of pick) {
    const next = name ? `${name}-${w}` : w;
    if (next.length > 40) break;
    name = next;
  }
  return name || "my-project";
}
