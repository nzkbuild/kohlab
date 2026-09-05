import type { AgentStatus, DiffFile, TreeNode, Workspace } from "./types";

export interface TeamUser { id: string; name: string; role: string; }
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

async function req(path: string, opts: RequestInit = {}): Promise<Response> {
  const sep = path.includes("?") ? "&" : "?";
  const url = key ? `${path}${sep}key=${encodeURIComponent(key)}` : path;
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}) },
  });
  return res;
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
      const res = await fetch(`/api/workspaces?key=${encodeURIComponent(k)}`);
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
  users: () => json<{ users: TeamUser[] }>("/api/users"),
  addUser: (body: { id: string; name: string; role: string }) =>
    json<{ user: TeamUser; key: string }>("/api/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  removeUser: (id: string) => json<{ ok: boolean }>(`/api/users/${id}`, { method: "DELETE" }),
  audit: () => json<{ events: AuditEvent[] }>("/api/audit"),
  installAgent: (name: string, cmd: string) =>
    json<{ ok: boolean; output?: string }>("/api/agents/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, cmd }) }),
  ghRepos: () => json<{ ok: boolean; repos: string[]; authed: boolean }>("/api/gh/repos"),
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
