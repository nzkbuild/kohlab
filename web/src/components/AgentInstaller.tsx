import { useEffect, useRef, useState } from "react";
import {
  ArrowsClockwise,
  CheckCircle,
  CircleNotch,
  Copy,
  DownloadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { api } from "../api";
import { announce } from "../lib/announce";
import { cn } from "../lib/utils";
import { AGENT_CATALOG, type AgentInfo } from "../types";
import { Button, SkeletonRows } from "./ui";

interface AgentCard extends AgentInfo {
  installed: boolean;
}

const STATUS_CHIP = {
  detected: "chip-running",
  missing: "chip-stopped",
} as const;

export default function AgentInstaller() {
  const [agents, setAgents] = useState<AgentCard[]>(
    AGENT_CATALOG.map((a) => ({ ...a, installed: false })),
  );
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  /** One install at a time: a global npm install is heavy and the states would race. */
  const [running, setRunning] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);

  const load = async () => {
    setLoading(true);
    try {
      const status = await api.agentsStatus();
      setAgents(AGENT_CATALOG.map((a) => ({ ...a, installed: !!status[a.name] })));
      setStatusError(null);
    } catch (e) {
      setStatusError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => window.clearTimeout(copyTimer.current);
  }, []);

  const install = async (agent: AgentCard) => {
    if (!agent.installCmd || running) return;
    setRunning(agent.name);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[agent.name];
      return next;
    });
    try {
      await api.installAgent(agent.name, agent.installCmd);
      announce(`${agent.name} installed`);
      await load();
    } catch (e) {
      // Verbatim per card: the server sends the installer's stderr, and a
      // generic banner would throw away the only useful line.
      setErrors((prev) => ({ ...prev, [agent.name]: (e as Error).message }));
    } finally {
      setRunning(null);
    }
  };

  const copy = async (agent: AgentCard, cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(agent.name);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(null), 2000);
    } catch (e) {
      setErrors((prev) => ({ ...prev, [agent.name]: `copy failed: ${(e as Error).message}` }));
    }
  };

  const missing = agents.filter((a) => !a.installed);

  return (
    <div className="text-left">
      <div className="flex items-center gap-2 px-1 py-1">
        <p className="tnum text-2xs text-text-muted">
          {loading
            ? "checking…"
            : missing.length === 0
              ? "all agents detected"
              : `${missing.length} of ${agents.length} not detected`}
        </p>
        <div className="flex-1" />
        <Button
          variant="quiet"
          size="sm"
          iconOnly
          aria-label="Re-check installed agents"
          disabled={loading}
          onClick={() => void load()}
        >
          <ArrowsClockwise size={14} />
        </Button>
      </div>

      {statusError ? (
        <p role="alert" className="mb-2 flex flex-wrap items-center gap-2 px-1 text-2xs text-status-danger">
          Could not read agent status: {statusError}
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
            retry
          </Button>
        </p>
      ) : null}

      {loading && !statusError ? (
        <SkeletonRows rows={3} />
      ) : (
        <ul className="flex flex-col gap-2">
          {agents.map((agent) => {
            const busy = running === agent.name;
            const error = errors[agent.name];
            return (
              <li key={agent.name} className="rounded-lg border border-line-subtle p-3">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="mono text-sm text-text-primary">{agent.name}</span>
                      <span
                        className={cn(
                          "chip",
                          agent.installed ? STATUS_CHIP.detected : STATUS_CHIP.missing,
                        )}
                      >
                        {agent.installed ? (
                          <CheckCircle size={11} weight="fill" aria-hidden="true" />
                        ) : (
                          <span className="chip-dot" aria-hidden="true" />
                        )}
                        {agent.installed ? "detected" : "not detected"}
                      </span>
                    </p>
                    {agent.setupHint ? (
                      <p className="mt-1 text-2xs leading-relaxed text-text-muted">{agent.setupHint}</p>
                    ) : null}
                    {agent.installCmd ? (
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <code className="mono min-w-0 flex-1 truncate text-xs text-text-secondary">
                          {agent.installCmd}
                        </code>
                        <Button
                          variant="quiet"
                          size="sm"
                          iconOnly
                          aria-label={`Copy install command for ${agent.name}`}
                          title={copied === agent.name ? "Copied" : "Copy install command"}
                          onClick={() => void copy(agent, agent.installCmd ?? "")}
                        >
                          <Copy size={13} />
                        </Button>
                      </div>
                    ) : null}
                  </div>

                  {!agent.installed && agent.installCmd ? (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={running !== null}
                      aria-busy={busy}
                      onClick={() => void install(agent)}
                    >
                      {busy ? (
                        <CircleNotch size={14} className="animate-spin" aria-hidden="true" />
                      ) : (
                        <DownloadSimple size={14} aria-hidden="true" />
                      )}
                      {busy ? "installing…" : "install"}
                    </Button>
                  ) : null}
                </div>

                {error ? (
                  <p
                    role="alert"
                    className="mt-2 flex items-start gap-1.5 border-t border-line-subtle pt-2 text-2xs text-status-danger"
                  >
                    <WarningCircle size={13} className="mt-px shrink-0" aria-hidden="true" />
                    <span className="mono min-w-0 break-words">
                      {agent.name} install failed: {error}
                    </span>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
