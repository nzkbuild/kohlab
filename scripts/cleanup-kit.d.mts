// Types for scripts/cleanup-kit.mjs, so the TypeScript checks can import it.
export const AGENT_COMMANDS: string[];
export function ancestors(p: string): string[];
export function agentBinaryPaths(): string[];
export function dropAcl(paths: string[], opts?: { name?: string; uid?: number }): void;
export function aclLeft(path: string, opts: { name?: string; uid?: number }): boolean;
export function removeTemp(dir: string): void;
export function accountsLike(re: RegExp): string[];
export function pids(): string[];
