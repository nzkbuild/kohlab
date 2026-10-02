# Kohlab UI and UX 2.0.0

Status: authoritative delta plan for the current v1.16 frontend.

This document does not repeat fixes already recorded in `docs/EVAL-AND-REDESIGN.md`.
It starts from the measured baseline that exists today.

## 1. Baseline

`bun run check` passed all 20 checks on 2026-09-26.

The suite passed:

- token contrast against WCAG 2.2 AA
- static accessibility scan
- frontend types
- performance budgets
- backend contract and security checks

A source inventory found 37 frontend files and 7,658 lines.
The inventory found zero raw hex literals and zero hard-coded color utility matches in `web/src`.
Those are not open findings.

The source inventory is a lead generator, not a conformance result.
Rendered focus order, target geometry, clipping, and responsive reflow still need browser measurement.

## 2. Current verified delta

### D1. Update polling ignores document visibility

`UpdatePanel` starts a three-second interval while an update is running:
`web/src/components/UpdatePanel.tsx:55-60`.

`LogView` already gates its polling on `document.hidden` and listens for visibility changes:
`web/src/components/LogView.tsx:65-90`.

Impact:

- hidden tabs continue polling during long updates
- server work increases without user-visible benefit
- behavior is inconsistent across two async surfaces

Change:

- reuse the visibility-gated pattern from `LogView`
- pause polling while hidden
- perform one refresh when the document becomes visible
- keep the existing three-second cadence while visible

Measure:

- hidden tab: zero update-status requests over 30 seconds
- visible tab: request interval remains 3 seconds ± scheduling jitter
- visibility restore: one immediate request, then normal cadence

### D2. Browser conformance evidence is incomplete

The repository checks prove static rules and token contrast.
They do not measure rendered target size, focus order, or focus obstruction.

The 2.0.0 gate must add a browser run against the built UI.

Required measurements:

- WCAG 2.2 AA axe rules, including the `wcag22` ruleset where supported
- every actionable control has a 24 CSS pixel minimum target
- primary touch controls target approximately 44 CSS pixels
- keyboard focus order follows visual task order
- focused controls are not clipped or obscured
- no horizontal overflow at 320, 390, 768, and 1280 CSS pixels
- each route exposes one page-level `h1`

A failed browser measurement is a finding only when the failing DOM state and viewport are recorded.

### D3. Audit coverage must distinguish absence of evidence from compliance

The source inventory reports zero focus-handler matches in some files.
That is not a finding because native buttons and Radix primitives provide keyboard behavior.
The actual handler and rendered DOM must be inspected before citing a keyboard defect.

The same rule applies to loading, error, dialog, and heading counts.
Regex counts are leads only.

## 3. Page inventory

The 2.0.0 browser audit covers every current page and workbench surface:

- authentication: `AuthGate.tsx`
- shell and navigation: `App.tsx`, `Sidebar.tsx`, `CommandPalette.tsx`
- command center: `Dashboard.tsx`
- workspace list and first run: `WorkspacesView.tsx`, `Onboarding.tsx`
- workspace cockpit: `WorkspaceDetail.tsx`
- terminal, log, review, and files: `TerminalView.tsx`, `LogView.tsx`, `DiffView.tsx`, `BrowseView.tsx`, `FileTree.tsx`, `CodeView.tsx`
- settings and access: `Settings.tsx`, `Account.tsx`, `Team.tsx`, `JoinView.tsx`
- operations: `AgentInstaller.tsx`, `UpdatePanel.tsx`
- shared behavior: `ui.tsx`, `ConfirmDialog.tsx`, `ErrorBoundary.tsx`

No page is declared compliant from source inspection alone.

## 4. Standards

- WCAG 2.2 is the conformance target: https://www.w3.org/TR/WCAG22/
- WAI-ARIA APG is the interaction-pattern reference: https://www.w3.org/WAI/ARIA/apg/
- The existing repository contract remains the local implementation rule: `docs/frontend-contract.md`
- Existing research remains authoritative for Primer, Carbon, Geist, token, terminal, and React patterns: `docs/research/01-accessibility-platform-2026.md` through `04-react-frontend-architecture-2026.md`

Relevant WCAG 2.2 checks for the browser audit:

- 1.4.3 contrast minimum
- 1.4.10 reflow
- 1.4.11 non-text contrast
- 2.4.3 focus order
- 2.4.7 focus visible
- 2.4.11 focus not obscured
- 2.5.8 target size minimum
- 4.1.2 name, role, value

## 5. Delivery order

1. Add the visibility gate to `UpdatePanel`.
2. Run the browser audit against a throwaway server and the built UI.
3. Record each failure with route, viewport, selector, computed geometry, and screenshot or DOM evidence.
4. Fix only confirmed failures.
5. Run `bun run check`, frontend typecheck, build, and the browser audit again.

## 6. Non-goals

- no replacement of the existing token system
- no new component library
- no rework of already-passing static accessibility checks
- no visual redesign based only on subjective preference
- no claim of WCAG conformance without rendered browser evidence

## 7. Current limits

Verified in this pass: repository checks, source inventory, `UpdatePanel` polling code, and `LogView` visibility-gated polling.

Not verified in this pass: rendered axe results, target geometry, focus order, focus obstruction, screen-reader output, and mobile screenshots.

The most likely way this plan could be wrong is that a browser run may show the UpdatePanel interval is already stopped by a higher-level lifecycle condition. The source currently shows no visibility guard in that interval, so the browser test must confirm the request behavior before implementation.
