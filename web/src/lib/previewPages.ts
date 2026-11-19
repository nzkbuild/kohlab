import type { PreviewPage } from "../types";

/** An HTML file in the project: the files that Preview can show as a page. */
export const isPagePath = (path: string) => /\.html?$/i.test(path);

/** The address of a page under the project's own address (".../p/<token>/"). Each segment is encoded, so any name works. */
export function pageAddress(base: string, path: string): string {
  const root = base.endsWith("/") ? base : `${base}/`;
  return root + path.split("/").map(encodeURIComponent).join("/");
}

/** The listed page that changed most recently, among the changed files. Null when no changed file is a listed page. */
export function pickChangedPage(changedPaths: string[], pages: PreviewPage[]): string | null {
  const changed = new Set(changedPaths);
  let best: PreviewPage | null = null;
  for (const page of pages) if (changed.has(page.path) && (!best || page.changed > best.changed)) best = page;
  return best?.path ?? null;
}

/** Asks Preview to open a page of a project (the Preview panel answers, see WorkspaceDetail). */
export function openPageInPreview(workspaceId: string, path: string) {
  window.dispatchEvent(new CustomEvent("kohlab:open-preview", { detail: { id: workspaceId, page: path } }));
}

// The page Preview last opened, per project. localStorage can throw (private mode): then it is just not remembered.
const pageKey = (id: string) => `kohlab.previewPage.${id}`;
export function readRememberedPage(id: string): string | null {
  try {
    return localStorage.getItem(pageKey(id));
  } catch {
    return null;
  }
}
export function rememberPage(id: string, path: string) {
  try {
    localStorage.setItem(pageKey(id), path);
  } catch {
    /* storage disabled: nothing to keep */
  }
}
