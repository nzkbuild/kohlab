import { lazy, Suspense, useEffect, useState } from "react";
import { Toaster } from "sonner";
import { List } from "@phosphor-icons/react";
import { useApp } from "./store";
import { useSync } from "./lib/useSync";
import { ROUTE_LABEL } from "./lib/route";
import { workspaceStatus } from "./lib/status";
import { api } from "./api";
import AuthGate from "./components/AuthGate";
import ErrorBoundary from "./components/ErrorBoundary";
import Sidebar from "./components/Sidebar";
import CommandPalette from "./components/CommandPalette";
import Dashboard from "./components/Dashboard";
import WorkspacesView from "./components/WorkspacesView";
import Settings from "./components/Settings";
import Onboarding from "./components/Onboarding";
import { Announcer, Button, SkeletonRows } from "./components/ui";

// xterm is ~390 KB and Monaco is far larger. Only lazy() defers the *fetch* —
// a static import would pull them into the entry chunk and block first paint.
const WorkspaceDetail = lazy(() => import("./components/WorkspaceDetail"));

export default function App() {
  const authed = useApp((s) => s.setAuthed);
  const isAuthed = useApp((s) => s.authed);
  const route = useApp((s) => s.route);
  const workspaces = useApp((s) => s.workspaces);
  const loading = useApp((s) => s.loading);
  const error = useApp((s) => s.error);

  const [navOpen, setNavOpen] = useState(false);

  useSync();

  // Auth bootstrap: only prompt when the server actually requires a key.
  useEffect(() => {
    void api.authRequired().then((required) => {
      if (!required) {
        authed(true);
        return;
      }
      const key = new URLSearchParams(location.search).get("key") ?? localStorage.getItem("kohlab_key");
      if (!key) return;
      void api.testKey(key).then((ok) => {
        if (ok) authed(true);
      });
    });
  }, [authed]);

  // The tab title is the only signal a backgrounded operator gets without an OS
  // notification, so it carries the review count rather than a transient flash.
  useEffect(() => {
    const review = workspaces.filter((w) => workspaceStatus(w) === "needs-review").length;
    document.title = review > 0 ? `kohlab — ${review} ready for review` : "kohlab";
  }, [workspaces]);

  // The drawer is a mobile affordance; leaving it open across a route change
  // would hide the page the user just navigated to.
  useEffect(() => {
    setNavOpen(false);
  }, [route]);

  if (!isAuthed) return <AuthGate />;

  return (
    <>
      <CommandPalette />
      <Announcer />
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          style: {
            background: "var(--surface-overlay)",
            border: "1px solid var(--line-strong)",
            color: "var(--text-primary)",
            fontSize: "0.8125rem",
          },
        }}
      />

      <div className="app-shell">
        <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />

        {/* Scrim behind the mobile drawer. A real button so it is keyboard and
            screen-reader dismissible, not a decorative div. */}
        {navOpen ? (
          <button className="scrim shell:hidden" aria-label="Close navigation" onClick={() => setNavOpen(false)} />
        ) : null}

        <main className="app-main">
          <header className="app-topbar">
            <Button
              variant="quiet"
              iconOnly
              className="shell:hidden"
              aria-label="Open navigation"
              onClick={() => setNavOpen(true)}
            >
              <List size={18} />
            </Button>

            {/* No route label here: every surface renders its own <h1> directly
                below, so a label in the bar reads as the title twice. On mobile
                this bar is the app chrome — menu button and brand — and the page
                supplies the heading. */}
            <span className="text-base font-semibold tracking-tight">kohlab</span>

            <div className="flex-1" />
          </header>

          <div className="app-content">
            {error && workspaces.length === 0 ? (
              <div className="p-6">
                <p className="text-sm text-status-danger" role="alert">
                  {error}
                </p>
              </div>
            ) : null}

            <ErrorBoundary label={ROUTE_LABEL[route.kind]}>
              {route.kind === "dashboard" ? <Dashboard /> : null}
              {route.kind === "settings" ? <Settings /> : null}
              {route.kind === "workspaces" ? (
                loading ? (
                  <div className="surface">
                    <div className="surface-inner">
                      <SkeletonRows rows={5} className="panel" />
                    </div>
                  </div>
                ) : workspaces.length === 0 ? (
                  <Onboarding />
                ) : (
                  <WorkspacesView />
                )
              ) : null}
              {route.kind === "workspace" ? (
                <ErrorBoundary label="Workspace">
                  <Suspense
                    fallback={
                      <div className="surface">
                        <div className="surface-inner">
                          <SkeletonRows rows={4} className="panel" />
                        </div>
                      </div>
                    }
                  >
                    <WorkspaceDetail workspaceId={route.id} />
                  </Suspense>
                </ErrorBoundary>
              ) : null}
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </>
  );
}
