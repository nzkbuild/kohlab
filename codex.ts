/**
 * Codex sign-in for chat projects: whether the server's Codex is signed in, and the owner's
 * device-code sign-in (`codex login --device-auth`) that Settings → Agents drives.
 *
 * The CLI prints a link and a one-time code, then waits until the person approves it in
 * their browser. The process is kept running until it exits; the page polls for the result.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { childEnv } from "./chat";

const LOGIN_MS = 15 * 60_000; // the code expires in 15 minutes; so does the wait for it
const FIND_MS = 20_000; // the link and code should print at once; if not, something is wrong

/** Removes terminal colour and cursor codes. Pure. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** The sign-in link and one-time code from `codex login --device-auth` output, colour codes allowed. Null until both are in the text. Pure. */
export function parseCodexDeviceAuth(text: string): { url: string; code: string } | null {
  const plain = stripAnsi(text);
  let url = plain.match(/https:\/\/[^\s"'<>]+/)?.[0];
  try {
    if (url && new URL(url).protocol !== "https:") url = undefined; // only a plain https link ever reaches an href
  } catch {
    url = undefined;
  }
  const code = plain.match(/one-time code[^\n]*\r?\n\s*([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/)?.[1];
  return url && code ? { url, code } : null;
}

/** Whether `codex login status` says signed in: exit 0 and no "Not logged in". Pure. */
export function parseCodexLoggedIn(output: string, exitCode: number): boolean {
  return exitCode === 0 && !/not logged in/i.test(stripAnsi(output));
}

/** One sign-in check, shared for 60 s so polling never spawns a process per request. */
let signedInCheck: { at: number; result: Promise<boolean | null> } | null = null;

/** Whether Codex is signed in on this server. Null when the check could not run or timed out. */
export function codexSignedIn(): Promise<boolean | null> {
  if (!signedInCheck || Date.now() - signedInCheck.at >= 60_000) {
    signedInCheck = {
      at: Date.now(),
      result: new Promise<boolean | null>((resolve) => {
        execFile("codex", ["login", "status"], { timeout: 5000 }, (err, stdout, stderr) => {
          const code = err ? (err as { code?: unknown }).code : 0;
          resolve(typeof code === "number" ? parseCodexLoggedIn(`${stdout}${stderr}`, code) : null);
        });
      }),
    };
  }
  return signedInCheck.result;
}

/** Forgets the cached check: the next read asks codex again (after a sign-in). */
export function clearCodexSignedIn(): void {
  signedInCheck = null;
}

type LoginState = "waiting" | "done" | "failed";
interface Login {
  child: ChildProcess;
  state: LoginState;
  url?: string;
  code?: string;
  error?: string;
  out: string;
  ready: Promise<{ url: string; code: string }>;
}
/** The current or last sign-in. One at a time. */
let login: Login | null = null;

/** Where the sign-in stands, for the page to poll. */
export function codexLoginState(): { state: LoginState | "idle"; url?: string; code?: string; error?: string } {
  if (!login) return { state: "idle" };
  return { state: login.state, ...(login.state === "waiting" && login.url ? { url: login.url, code: login.code } : {}), ...(login.error ? { error: login.error } : {}) };
}

/** Starts a device-code sign-in, or returns the one already waiting. Resolves with the link and code once the CLI prints them. */
export function startCodexLogin(): Promise<{ url: string; code: string }> {
  if (login?.state === "waiting") return login.ready;
  const child = spawn("codex", ["login", "--device-auth"], { env: childEnv(homedir()), stdio: ["ignore", "pipe", "pipe"] });
  let reject!: (e: Error) => void;
  let settle!: (v: { url: string; code: string }) => void;
  const cur = {
    child,
    state: "waiting",
    out: "",
    ready: new Promise<{ url: string; code: string }>((res, rej) => ((settle = res), (reject = rej))),
  } as Login;
  login = cur;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail = (error: string) => {
    clearTimeout(timer);
    clearTimeout(findTimer);
    if (cur.state === "waiting") {
      cur.state = "failed";
      cur.error = error;
    }
    reject(new Error(error));
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  const onData = (d: Buffer) => {
    cur.out = (cur.out + d).slice(-8000);
    const found = parseCodexDeviceAuth(cur.out);
    if (found && !cur.url) {
      cur.url = found.url;
      cur.code = found.code;
      clearTimeout(findTimer);
      settle(found);
    }
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  child.on("error", () => fail("Could not start Codex sign-in. Try again."));
  child.on("exit", (code) => {
    clearTimeout(timer);
    clearTimeout(findTimer);
    if (cur.state !== "waiting") return;
    if (code === 0) {
      cur.state = "done";
      clearCodexSignedIn();
    } else fail(cur.url ? "Sign-in did not finish. Start again." : "Could not start Codex sign-in. Try again.");
  });
  const findTimer = setTimeout(() => {
    if (!cur.url) fail("Could not read the sign-in code from Codex. Try again.");
  }, FIND_MS);
  timer = setTimeout(() => fail("The sign-in code expired. Start again."), LOGIN_MS);
  return cur.ready;
}

/** Ends a sign-in still waiting, so no `codex login` outlives the server. */
export function stopCodexLogin(): void {
  if (login?.state === "waiting" && login.child.exitCode === null) login.child.kill("SIGTERM");
}
