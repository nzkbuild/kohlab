import type { AgentStatus, DiffFile, ReleaseStatus, TreeNode, Workspace } from "./types";

export interface TeamUser { id: string; name: string; role: string; pending?: boolean; }
export interface AuditEvent { t: number; user: string; action: string; id?: string; detail?: string; }

let key = new URLSearchParams(location.search).get("key") || localStorage.getItem("kohlab_key") || "";

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
  create: (body: { task: string; repo?: string; agent: string; branch?: string; limits?: { timeoutSec?: number; maxMemoryMb?: number; maxProcs?: number } }) =>
    json<Workspace>("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  clone: (body: { url: string; task: string; agent: string; limits?: { timeoutSec?: number; maxMemoryMb?: number; maxProcs?: number } }) =>
    json<Workspace>("/api/clone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  action: (id: string, action: string) =>
    json<Workspace>(`/api/workspaces/${id}/${action}`, { method: "POST" }),
  share: (id: string) =>
    json<{ id: string; share: string }>(`/api/workspaces/${id}/share`, { method: "POST" }),
  diff: (id: string) => json<DiffFile[]>(`/api/workspaces/${id}/diff`),
  commit: (id: string, message: string) =>
    json<{ ok: boolean }>(`/api/workspaces/${id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }),
  files: (id: string) => json<TreeNode[]>(`/api/workspaces/${id}/files`),
  file: (id: string, path: string) =>
    json<{ path: string; content: string }>(`/api/workspaces/${id}/file?path=${encodeURIComponent(path)}`),
  log: (id: string) => json<{ log: string }>(`/api/workspaces/${id}/log`),
  users: () => json<{ users: TeamUser[]; canInvite: boolean }>("/api/users"),
  /** Who this browser is, as far as the server is concerned. */
  account: () => json<{ id: string; role: string; kind: string }>("/api/account"),
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
      headers: { "content-type": image.type || "application/octet-stream" },
      body: image,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body as { error?: string }).error || res.statusText);
    return body as { path: string; mimeType: string; bytes: number };
  },
};

export type { Workspace };
