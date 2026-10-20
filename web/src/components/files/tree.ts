import type { DiffFile, TreeNode } from "../../types";

/** Above this a file is not opened in the editor (the server reads whole files as text). */
export const MAX_TEXT_CHARS = 1_000_000;

/** VS Code's order at every level: folders first, then files, each case-insensitive and numeric-aware. */
export function sortTree(nodes: TreeNode[]): TreeNode[] {
  return [...nodes]
    .sort(
      (a, b) =>
        (a.type === b.type ? 0 : a.type === "dir" ? -1 : 1) ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "accent" }),
    )
    .map((node) => (node.type === "dir" && node.children ? { ...node, children: sortTree(node.children) } : node));
}

/** Every file path in the tree, in tree order, relative to the project root. */
export function filePaths(nodes: TreeNode[], prefix = ""): string[] {
  return nodes.flatMap((node) => {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    return node.type === "dir" ? filePaths(node.children ?? [], path) : [path];
  });
}

/** The same words in Changes and Files: a file the diff adds is New, one it deletes is Removed, anything else Changed. */
export type Change = "New" | "Removed" | "Changed";

export function changeWord(diff: string): Change {
  if (/^new file mode/m.test(diff) || diff.startsWith("--- /dev/null")) return "New";
  if (/^deleted file mode/m.test(diff)) return "Removed";
  return "Changed";
}

export function changeMap(files: DiffFile[]): Map<string, Change> {
  return new Map(files.map((f) => [f.name, changeWord(f.diff)]));
}

/** The image MIME type for a file the Files view shows as a picture, or null for everything else. */
export function imageType(path: string): string | null {
  const match = /\.(png|jpe?g|gif|webp|bmp|avif|ico)$/i.exec(path);
  if (!match) return null;
  const ext = match[1].toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "ico") return "image/x-icon";
  return `image/${ext}`;
}

/** Text the editor can show: small enough, and no NUL byte (binary files almost always have one). */
export function isTextContent(content: string): boolean {
  return content.length <= MAX_TEXT_CHARS && !content.includes("\u0000");
}
