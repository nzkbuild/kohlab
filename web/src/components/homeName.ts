/** Words that say nothing about what a project is. */
const FILLER = new Set([
  "a", "an", "the", "my", "me", "i", "id", "for", "to", "of", "and", "or", "in", "on", "with", "that", "which",
  "is", "it", "so", "please", "make", "build", "create", "want", "need", "some", "can", "you", "us", "our", "be",
  "this", "just", "would", "like", "thats",
]);

/**
 * A folder name from the first idea someone types: up to five meaningful words,
 * lowercase, [a-z0-9-] only, 40 characters at most.
 */
export function projectNameFromIdea(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !FILLER.has(w));
  let name = "";
  for (const w of words.slice(0, 5)) {
    const next = name ? `${name}-${w}` : w;
    if (next.length > 40) break;
    name = next;
  }
  return name || "my-project";
}
