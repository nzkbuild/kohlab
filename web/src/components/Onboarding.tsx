import { useState, type ReactNode } from "react";
import { Rocket, Terminal } from "@phosphor-icons/react";
import { useApp } from "../store";
import { Button, EmptyState, Panel } from "./ui";
import AgentInstaller from "./AgentInstaller";
import { NewWorkspaceForm } from "./WorkspacesView";

/**
 * One wizard step. Steps are numbered but never gated: every step renders its
 * own controls immediately, so arriving at step 2 without doing step 1 is a
 * supported path rather than a dead end.
 */
function Step({
  n,
  title,
  description,
  children,
  onSkip,
}: {
  n: number;
  title: string;
  description: string;
  children: ReactNode;
  onSkip: () => void;
}) {
  return (
    <Panel className="p-4">
      <div className="flex items-start gap-3">
        <span className="tnum inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-full border border-line-strong px-1.5 text-2xs font-semibold text-text-secondary">
          {n}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-text-muted">{description}</p>
        </div>
      </div>
      <div className="mt-3">{children}</div>
      <div className="mt-3 flex justify-end border-t border-line-subtle pt-3">
        <Button variant="quiet" size="sm" onClick={onSkip}>
          skip to command center
        </Button>
      </div>
    </Panel>
  );
}

/**
 * First run. The empty state is the base layer and stands on its own; the
 * three-step guide is an optional layer opened from it, never a gate — the app
 * is fully usable with the guide closed or abandoned halfway.
 */
export default function Onboarding() {
  const navigate = useApp((s) => s.navigate);
  const [guide, setGuide] = useState(false);

  const skip = () => navigate({ kind: "dashboard" });

  return (
    <div className="surface">
      <div className="surface-inner">
        {/* A route must expose exactly one <h1>; with no workspaces the surface
            below is an empty state, so the heading lives here. */}
        <header className="mb-4">
          <h1 className="surface-title">Workspaces</h1>
          <p className="surface-description">
            One task, one repository, one agent — each in its own isolated worktree.
          </p>
        </header>

        <EmptyState
          icon={<Terminal size={18} />}
          title="No workspaces yet"
          description="A workspace is one task, one repository and one agent. The three steps below take about two minutes — or skip them entirely and explore first."
          action={
            <>
              <Button
                variant="primary"
                aria-expanded={guide}
                aria-controls="onboarding-steps"
                onClick={() => setGuide(true)}
              >
                <Rocket size={15} weight="fill" />
                get started
              </Button>
              <Button variant="quiet" onClick={skip}>
                skip to command center
              </Button>
            </>
          }
        />

        {guide ? (
          <div id="onboarding-steps" className="flex flex-col gap-3">
            <Step
              n={1}
              title="Install an agent"
              description="Kohlab runs the CLI agent you already trust. Install one here, or skip this step if you already have one on this server."
              onSkip={skip}
            >
              <AgentInstaller />
            </Step>

            <Step
              n={2}
              title="Create a workspace"
              description="One task, one repository, one agent. Creating the workspace starts the agent — there is nothing to launch afterwards."
              onSkip={skip}
            >
              {/* No cancel here: the step's own skip and "hide the guide" are the
                  ways out, and neither of them throws away the other steps. */}
              <NewWorkspaceForm />
            </Step>

            <Step
              n={3}
              title="Monitor and commit"
              description="What you do with a running agent, in one place."
              onSkip={skip}
            >
              <ul className="flex flex-col gap-1.5 text-sm leading-relaxed text-text-secondary">
                <li>
                  <span className="text-text-primary">The terminal is the agent, live.</span> The log tab keeps the full
                  tail; the file tree shows what it touched.
                </li>
                <li>
                  <span className="text-text-primary">Finishing lands it in the review queue.</span> The workspace shows
                  its diff, so you read the change before anything else happens to it.
                </li>
                <li>
                  <span className="text-text-primary">Committing is yours.</span> Nothing is committed automatically —
                  you write the message and press commit.
                </li>
              </ul>
              <div className="mt-3">
                <Button variant="primary" onClick={skip}>
                  open the command center
                </Button>
              </div>
            </Step>

            <div className="flex justify-end">
              <Button variant="quiet" size="sm" onClick={() => setGuide(false)}>
                hide the guide
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
