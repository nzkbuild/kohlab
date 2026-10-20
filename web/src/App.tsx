import { lazy, Suspense, useEffect } from "react";
import { Toaster } from "sonner";
import { ArrowLeft, List, PencilSimple } from "@phosphor-icons/react";
import { useApp, useCan } from "./store";
import { useSync } from "./lib/useSync";
import { ROUTE_LABEL } from "./lib/route";
import { workspaceStatus } from "./lib/status";
import { api } from "./api";
import { useDrawerSwipe } from "./lib/drawerSwipe";
import { cn } from "./lib/utils";
import AuthGate from "./components/AuthGate";
import JoinView from "./components/JoinView";
import ErrorBoundary from "./components/ErrorBoundary";
import Sidebar from "./components/Sidebar";
import CommandPalette from "./components/CommandPalette";
import ShortcutsDialog from "./components/ShortcutsDialog";
import WorkspacesView, { LaunchSheet } from "./components/WorkspacesView";
import Settings from "./components/Settings";
import Onboarding from "./components/Onboarding";
import StatusBar from "./components/StatusBar";
import { Announcer, Button, SkeletonRows, TooltipProvider } from "./components/ui";

// xterm is ~390 KB and Monaco is far larger. Only lazy() defers the *fetch*,
// a static import would pull them into the entry chunk and block first paint.
const WorkspaceDetail = lazy(() => import("./components/WorkspaceDetail"));

export default function App() {
  const authed = useApp((s) => s.setAuthed);
  const isAuthed = useApp((s) => s.authed);
  const route = useApp((s) => s.route);
  const workspaces = useApp((s) => s.workspaces);
  const loading = useApp((s) => s.loading);
  const error = useApp((s) => s.error);
  const connection = useApp((s) => s.connection);
  const unreachable = useApp((s) => s.refreshFailures >= 2);
  const loadMe = useApp((s) => s.loadMe);
  const newOpen = useApp((s) => s.newOpen);
  const setNewOpen = useApp((s) => s.setNewOpen);
  const navOpen = useApp((s) => s.navOpen);
  const powerTools = useApp((s) => s.powerTools);
  const setNavOpen = useApp((s) => s.setNavOpen);
  const navIndex = useApp((s) => s.navIndex);
  // On a phone, a page reached from inside the app gets Back in place of the menu; Home keeps the menu.
  const backChevron = route.kind !== "workspaces" && navIndex > 0;
  const can = useCan();

  useDrawerSwipe(navOpen, setNavOpen);

  useSync();

  // Role decides which controls render, so it is read once per sign-in.
  useEffect(() => {
    if (isAuthed) void loadMe();
  }, [isAuthed, loadMe]);

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
    document.title = review > 0 ? `kohlab, ${review} ready for review` : "kohlab";
  }, [workspaces]);

  // The drawer is a mobile affordance; leaving it open across a route change
  // would hide the page the user just navigated to.
  useEffect(() => {
    setNavOpen(false);
  }, [route]);

  // An invitation is redeemed before anyone has a key: the token is the
  // credential, so this route has to render ahead of the gate.
  if (route.kind === "join") return <JoinView />;

  if (!isAuthed) return <AuthGate />;

  return (
    <TooltipProvider delayDuration={300}>
      <CommandPalette />
      <ShortcutsDialog />
      <LaunchSheet open={newOpen && can.mutate} onClose={() => setNewOpen(false)} />
      <Announcer />
      <Toaster
        theme="system"
        position="bottom-right"
        mobileOffset={{ bottom: "4.75rem" }}
        toastOptions={{
          style: {
            background: "var(--surface-overlay)",
            border: "1px solid var(--line-strong)",
            color: "var(--text-primary)",
            fontSize: "0.8125rem",
          },
        }}
      />

      <div className="flex h-full min-h-0 flex-col">
      <div className="app-shell min-h-0 flex-1">
          <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />

          {/* Scrim behind the mobile drawer. A real button so it is keyboard and
              screen-reader dismissible, not a decorative div. */}
          {navOpen ? (
            <button className="scrim shell:hidden" aria-label="Close navigation" onClick={() => setNavOpen(false)} />
          ) : null}

          <main className="app-main">
            {/* On a project page the project's own header is the only bar on a phone. */}
            <header className={cn("app-topbar", route.kind === "workspace" && "max-shell:!hidden")}>
              {backChevron ? (
                <Button variant="quiet" iconOnly className="shell:hidden" aria-label="Back" onClick={() => history.back()}>
                  <ArrowLeft size={18} />
                </Button>
              ) : (
                <Button
                  variant="quiet"
                  iconOnly
                  className="shell:hidden"
                  aria-label="Open navigation"
                  onClick={() => setNavOpen(true)}
                >
                  <List size={18} />
                </Button>
              )}

              {/* No route label here: every surface renders its own <h1> directly
                  below, so a label in the bar reads as the title twice. On mobile
                  this bar is the app chrome (menu button and brand) and the page
                  supplies the heading. */}
              <span className="text-base font-semibold tracking-tight">kohlab</span>

              <div className="flex-1" />

              {can.mutate ? (
                <Button variant="quiet" iconOnly aria-label="New project" onClick={() => setNewOpen(true)}>
                  <PencilSimple size={18} />
                </Button>
              ) : null}
            </header>

            {/* Silent while connected; the page only speaks up when it cannot
                reach the server, and says the agents are unaffected. */}
            {/* Two background refreshes in a row failed: a slim line, gone on the next success. The socket's banner below takes precedence. */}
            {unreachable && connection !== "reconnecting" && connection !== "offline" ? (
              <div role="status" className="flex items-center gap-2 bg-surface-raised px-4 py-1.5 text-sm text-text-secondary">
                Can&apos;t reach Kohlab. Trying again…
              </div>
            ) : null}
            {connection === "reconnecting" || connection === "offline" ? (
              <div role="status" className="conn-banner" data-state={connection}>
                <span className="chip-dot" aria-hidden="true" />
                {connection === "reconnecting"
                  ? "Reconnecting to the server… your projects keep running."
                  : "Can't reach the server. Your projects keep running there; this page catches up when it reconnects."}
              </div>
            ) : null}

            <div className="app-content">
              {error && workspaces.length === 0 ? (
                <div className="p-6">
                  <p className="text-sm text-status-danger" role="alert">
                    {error}
                  </p>
                </div>
              ) : null}

              <ErrorBoundary label={ROUTE_LABEL[route.kind]}>
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
                      <WorkspaceDetail key={route.id} workspaceId={route.id} />
                    </Suspense>
                  </ErrorBoundary>
                ) : null}
              </ErrorBoundary>
            </div>
          </main>
      </div>
      {powerTools ? <StatusBar /> : null}
      </div>
    </TooltipProvider>
  );
}
