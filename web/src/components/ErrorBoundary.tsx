import { Component, type ErrorInfo, type ReactNode } from "react";
import { Warning } from "@phosphor-icons/react";
import { Button } from "./ui";
import { UPDATE_READY, isChunkLoadError } from "../lib/build";

interface Props {
  /** Shown in the fallback so a failed pane says which pane failed. */
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Per-pane error containment.
 *
 * Without a boundary a single throwing component blanks the entire app; the
 * user loses their workspace list, their terminal, and any way to recover
 * except a full reload. A boundary here keeps the shell: and every sibling
 * pane: alive, and offers a retry that remounts just this subtree.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfaced so a production failure is observable rather than console-only.
    console.error(`[kohlab] ${this.props.label} crashed`, error, info.componentStack);
    // A deleted chunk means a new version was installed: say so in the bar, not only in this pane.
    if (isChunkLoadError(error)) window.dispatchEvent(new Event(UPDATE_READY));
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    // A chunk that the rebuild deleted cannot be retried in place: a reload fetches the new build.
    if (isChunkLoadError(error)) {
      return (
        <div className="grid h-full place-items-center p-6 text-center">
          <div className="max-w-md">
            <p className="text-base font-semibold text-text-primary">{this.props.label} needs a reload</p>
            <p className="mt-1.5 text-sm text-text-muted">Kohlab was updated while this page was open.</p>
            <div className="mt-4 flex justify-center">
              <Button variant="primary" onClick={() => location.reload()}>
                Reload
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-md">
          <div className="mx-auto mb-3 grid size-10 place-items-center rounded-lg bg-surface-hover text-status-danger">
            <Warning size={18} />
          </div>
          <p className="text-base font-semibold text-text-primary">{this.props.label} failed to render</p>
          <p className="mono mt-1.5 text-xs leading-relaxed text-text-muted">{error.message}</p>
          <div className="mt-4 flex justify-center">
            <Button variant="secondary" onClick={() => this.setState({ error: null })}>
              retry
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
