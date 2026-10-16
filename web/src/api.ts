import type { AgentStatus, ChatEvent, DiffFile, ReleaseStatus, TreeNode, Version, Workspace } from "./types";

export interface TeamUser { id: string; name: string; role: string; pending?: boolean; }
export interface AuditEvent { t: number; user: string; action: string; id?: string; detail?: string; }
/** A plan window's use in percent, and when it resets (an ISO time). */
export interface ChatUsageWindow { percent: number; resetsAt: string | null; }
/** The chat footer's usage: the context window, and the plan's limits when the CLI reports them. */
export interface ChatUsage {
  context: { used: number; limit: number; percent: number } | null;
  plan: { subscription: string | null; fiveHour: ChatUsageWindow | null; week: ChatUsageWindow | null } | null;
}

// A ?key= arrival (bookmark or tunnel link) is adopted into storage once, so
// the key leaves the URL bar and never leaks into history or Referer again.
// Next visit the stored copy signs in with no typing.
const urlKey = new URLSearchParams(location.search).get("key");
let key = urlKey || localStorage.getItem("kohlab_key") || "";
if (urlKey) {
  try {
    localStorage.setItem("kohlab_key", urlKey);
    history.replaceState(history.state, "", location.pathname + location.hash);
  } catch {
    /* private mode: the session still works, it just will not persist */
  }
}

export function setKey(k: string) {
  key = k;
  localStorage.setItem("kohlab_key", k);
}
export function clearKey() {
  key = "";
  localStorage.removeItem("kohlab_key");
}
export function hasKey() {
  return !!key;
}

/**
 * Every HTTP call carries the key in a header, never in the URL. The URL form is
 * still accepted by the server, for existing bookmarks and curl, but a key in a
 * query string leaks into browser history, proxy logs and Referer.
 */
async function req(path: string, opts: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    ...opts,
    headers: key ? { ...(opts.headers || {}), authorization: `Bearer ${key}` } : { ...(opts.headers || {}) },
  });
  return res;
}

/** The subprotocol a socket offers to carry the key. Mirrors the server's KEY_PROTOCOL. */
export function socketProtocol(k = key): string[] {
  return k ? [`kohlab.key.${k}`] : ["kohlab"];
}

async function json<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await req(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || res.statusText);
  return body as T;
}

export const api = {
  async testKey(k: string): Promise<boolean> {
    try {
      const res = await fetch("/api/workspaces", { headers: { authorization: `Bearer ${k}` } });
      return res.status === 200;
    } catch {
      return false;
    }
  },
  async authRequired(): Promise<boolean> {
    try {
      const res = await fetch(`/api/auth/required`);
      const body = (await res.json()) as { required?: boolean };
      return !!body.required;
    } catch {
      return true; // unreachable server → don't silently skip auth
    }
  },
  workspaces: () => json<Workspace[]>("/api/workspaces"),
  agentsStatus: () => json<AgentStatus>("/api/agents-status"),
  create: (body: { task: string; repo?: string; agent: string; branch?: string; payload?: string; newProject?: string; location?: string; chat?: boolean; limits?: { timeoutSec?: number; maxMemoryMb?: number; maxProcs?: number } }) =>
    json<Workspace>("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  paths: () => json<{ projects: string }>("/api/paths"),
  /** Download a file, or a folder as .tar.gz, through the authenticated fetch. */
  download: async (id: string, path: string): Promise<void> => {
    const res = await req(`/api/workspaces/${encodeURIComponent(id)}/raw?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error || res.statusText);
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "download";
    const href = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
  },
  branches: (source: string) => json<{ branches: string[] }>(`/api/branches?source=${encodeURIComponent(source)}`),
  clone: (body: { url: string; task: string; agent: string; branch?: string; payload?: string; chat?: boolean; limits?: { timeoutSec?: number; maxMemoryMb?: number; maxProcs?: number } }) =>
    json<Workspace>("/api/clone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  /** Same worktree and branch, new task: the agent restarts on it. */
  continue: (id: string, task: string) =>
    json<Workspace>(`/api/workspaces/${id}/continue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task }) }),
  action: (id: string, action: string) =>
    json<Workspace>(`/api/workspaces/${id}/${action}`, { method: "POST" }),
  /** Chat events after sequence number `after`, plus whether the AI is working and which question it waits on. */
  chat: (id: string, after: number) =>
    json<{
      events: ChatEvent[];
      busy: boolean;
      /** when the current turn started (ms), or null when idle */
      busySince: number | null;
      /** the server's clock, to correct a device clock that is off */
      now: number;
      /** background tasks still running */
      background: number;
      /** the same tasks, by id, for the Stop list */
      tasks: { id: string; type: string; description: string }[];
      /** the CLI is retrying a failed request: which try, of how many */
      retry: { attempt: number; max: number } | null;
      /** context in use and plan limits, read when the last turn ended */
      usage: ChatUsage | null;
      model: string | null;
      mode: string | null;
      waiting: string | null;
      draft: string;
      terminalOpen?: boolean;
      /** the current effort level, when one was set in this process */
      effort: string | null;
      /** slash commands the CLI offers (at most 200) */
      commands: { name: string; description: string; argumentHint: string }[];
      /** models the CLI offers, with the effort levels each supports */
      models: { value: string; displayName: string; description: string; supportedEffortLevels: string[] }[];
    }>(`/api/workspaces/${encodeURIComponent(id)}/chat?after=${after}`),
  chatSend: (id: string, text: string) =>
    json<{ ok: boolean }>(`/api/workspaces/${encodeURIComponent(id)}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  chatAnswer: (id: string, requestId: string, allow: boolean) =>
    json<{ ok: boolean }>(`/api/workspaces/${encodeURIComponent(id)}/chat/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, allow }),
    }),
  /** The chat's menu actions: "interrupt" (stop the turn), "model", "mode" or "effort" with a value; "files" (@ mentions),
   *  "stop_task", and Undo's "rewind_preview" and "rewind" with the message id. Some answer with data. */
  chatControl: (id: string, action: string, value: unknown) =>
    json<{ ok: boolean; files?: string[]; insertions?: number; deletions?: number }>(`/api/workspaces/${encodeURIComponent(id)}/chat/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, value }),
    }),
  /** Give a project a new name (its title in the UI). The server checks the name. */
  rename: (id: string, title: string) =>
    json<Workspace>(`/api/workspaces/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  /** `fresh` makes a new link and stops the old one working. */
  preview: (id: string, fresh = false) => json<{ url: string }>(`/api/workspaces/${id}/preview${fresh ? "?new=1" : ""}`, { method: "POST" }),
  /** The shared browser's address. Starts the browser if needed, which can take ~30 s the first time. */
  browser: (id: string) => json<{ url: string | null }>(`/api/workspaces/${id}/browser`),
  browserAct: (id: string, action: "open" | "home" | "back" | "forward" | "reload" | "viewport", url?: string, size?: { width: number; height: number }) =>
    json<{ url: string }>(`/api/workspaces/${id}/browser`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, url, ...size }),
    }),
  versions: (id: string) => json<Version[]>(`/api/workspaces/${id}/versions`),
  restoreVersion: (id: string, version: string) =>
    json<{ ok: true }>(`/api/workspaces/${id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version }),
    }),
  setModel: (id: string, model: "opus" | "sonnet" | "haiku" | "default") =>
    json<{ ok: boolean; model?: string }>(`/api/workspaces/${id}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    }),
  closeTerminal: (id: string, terminalId: string) =>
    json<{ ok: boolean }>(`/api/workspaces/${id}/terminal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminalId }),
    }),
  diff: (id: string) => json<DiffFile[]>(`/api/workspaces/${id}/diff`),
  commit: (id: string, message: string) =>
    json<{ ok: boolean }>(`/api/workspaces/${id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }),
  merge: (id: string, message?: string) =>
    json<{ repo: string; branch: string; from: string; to: string; previous: string; commit: string }>(`/api/workspaces/${id}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }),
  files: (id: string) => json<TreeNode[]>(`/api/workspaces/${id}/files`),
  users: () => json<{ users: TeamUser[]; canInvite: boolean }>("/api/users"),
  /** Who this browser is, as far as the server is concerned. */
  account: () => json<{ id: string; role: string; kind: string; prefs?: { powerTools?: boolean } }>("/api/account"),
  /** Save my preferences on the server, so they follow my account to every device. */
  savePrefs: (prefs: { powerTools: boolean }) =>
    json<{ powerTools?: boolean }>("/api/account/prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prefs),
    }),
  /** Rotate my own key. Returns the new one once; the old one dies here. */
  rotateMyKey: () => json<{ key: string }>("/api/account/key", { method: "POST" }),
  invite: (body: { id: string; name?: string; role?: string }) =>
    json<{ id: string; role: string; expires: number; path: string }>("/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  /**
   * Redeem an invitation. The one call that carries its own credential: the
   * helper sends a stored key when there is one, and a joiner has none.
   */
  join: (token: string) =>
    json<{ user: TeamUser; key: string }>("/api/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  /**
   * Pair a fresh device: trade a short one-time code (minted by `kohlab pair`
   * on the server) for the real key. The one auth call that carries no stored
   * key: the code is the credential, exactly like join's token.
   */
  pairClaim: (code: string) =>
    json<{ key: string }>("/api/pair/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }),
  pushKey: () => json<{ key: string }>("/api/push/key"),
  pushSubscribe: (sub: PushSubscriptionJSON) =>
    json<{ ok: true }>("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sub),
    }),
  pushUnsubscribe: (endpoint: string) =>
    json<{ ok: true }>("/api/push/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }),
  pushTest: (endpoint: string) =>
    json<{ ok: true }>("/api/push/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }),
  setRole: (id: string, role: string) =>
    json<{ user: TeamUser }>(`/api/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    }),
  addUser: (body: { id: string; name: string; role: string }) =>
    json<{ user: TeamUser; key: string }>("/api/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  removeUser: (id: string) => json<{ ok: boolean }>(`/api/users/${id}`, { method: "DELETE" }),
  audit: () => json<{ events: AuditEvent[] }>("/api/audit"),
  installAgent: (name: string, cmd: string) =>
    json<{ ok: boolean; output?: string }>("/api/agents/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, cmd }) }),
  ghRepos: () => json<{ ok: boolean; repos: string[]; authed: boolean }>("/api/gh/repos"),
  release: (force = false) => json<ReleaseStatus>(`/api/release${force ? "?force=1" : ""}`),
  applyUpdate: () => json<{ started?: boolean; log?: string }>("/api/release/update", { method: "POST" }),
  uploadImage: async (workspaceId: string, image: Blob): Promise<{ path: string; mimeType: string; bytes: number }> => {
    const res = await req(`/api/workspaces/${encodeURIComponent(workspaceId)}/image`, {
      method: "POST",
      headers: {
        "content-type": image.type || "application/octet-stream",
        // Non-image files keep (a sanitised form of) their own name on the server.
        ...(image instanceof File && image.name ? { "x-file-name": encodeURIComponent(image.name) } : {}),
      },
      body: image,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body as { error?: string }).error || res.statusText);
    return body as { path: string; mimeType: string; bytes: number };
  },
  /** Saves a file into the project folder at `path`. `ok: false` means that path already exists (409), so the caller can try another name. */
  uploadFile: async (id: string, path: string, file: Blob): Promise<{ ok: boolean; path: string }> => {
    const res = await req(`/api/workspaces/${encodeURIComponent(id)}/fs?op=upload&path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    if (res.status === 409) return { ok: false, path };
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body as { error?: string }).error || res.statusText);
    return { ok: true, path: (body as { path?: string }).path ?? path };
  },
  /** One file as text. The server reads it as UTF-8, so the caller checks for binary and size. */
  file: (id: string, path: string) =>
    json<{ path: string; content: string }>(`/api/workspaces/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`),
  /** Create a folder or an empty file in a workspace's tree. */
  fsOp: (id: string, op: "mkdir" | "touch", path: string) =>
    json<{ ok: boolean; path: string }>(`/api/workspaces/${encodeURIComponent(id)}/fs?op=${op}&path=${encodeURIComponent(path)}`, { method: "POST" }),
  /** Write bytes to `path`. Replaces an existing file only when `overwrite` is set; otherwise the server answers 409 ("already exists"). */
  putFile: (id: string, path: string, file: Blob, overwrite = false) =>
    json<{ ok: boolean; path: string; bytes: number }>(
      `/api/workspaces/${encodeURIComponent(id)}/fs?op=upload&path=${encodeURIComponent(path)}${overwrite ? "&overwrite=1" : ""}`,
      { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file },
    ),
  /** A file's bytes through the authenticated fetch, for images (an <img src> cannot send the key). */
  rawBlob: async (id: string, path: string): Promise<Blob> => {
    const res = await req(`/api/workspaces/${encodeURIComponent(id)}/raw?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(res.statusText);
    return res.blob();
  },
};

export type { Workspace };
