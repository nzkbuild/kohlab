# Accessibility

## What has been verified, and how

| Claim | Verified by | Scope |
| --- | --- | --- |
| Text meets WCAG 2.2 **AA** contrast | `scripts/check-contrast.mjs` | Every design token pair in both themes, computed from the token values |
| No markup-level accessibility faults | `scripts/check-a11y-static.mjs` | 36 source files: clickable non-interactive elements, missing `alt`, unlabelled controls, positive `tabindex`, removed focus ring, missing `lang`/`title`, no live region |
| State changes are announced | `web/src/lib/announce.ts` + the live region the scan requires | Screen-reader announcements for finished / needs-review / committed, with a pause control (SC 2.2.2) |
| The key entry is not a memory test | `AuthGate.tsx` — `autocomplete="current-password"` | SC 3.3.8 (Accessible Authentication) |
| The command palette follows the ARIA combobox pattern | `CommandPalette.tsx` — focus stays on the input, the active option is reported through `aria-activedescendant` | No focusable stop per result |

## What has **not** been verified

This is not an audit and there is no ACR or VPAT. In particular:

- **No browser-based DOM audit.** Nothing here renders a page and inspects the
  accessibility tree. `axe-core` against the real DOM is the obvious next step and
  it needs a headless browser as a dependency; that is a decision, not an
  oversight. Until then the static scan is a source scan: it cannot see computed
  styles, focus order as experienced, or whether an element is actually reachable.
- **No screen-reader pass with a human.** NVDA, JAWS and VoiceOver behave
  differently from each other and from any automated tool. Nobody has driven
  Kohlab with one.
- **Reflow and zoom are untested.** The layout is responsive by construction
  (Tailwind breakpoints), but 320px width at 400% zoom (SC 1.4.10) has not been
  measured.
- **Keyboard-only operation is untested end to end.** Every control is a native
  button, link, input or select, and the palette is documented as following the
  combobox pattern, but nobody has tabbed through a whole session without a mouse.
- **No reduced-motion or high-contrast-mode testing.**
- **The terminal is xterm.js.** What a screen reader makes of a live terminal
  buffer is outside what Kohlab can promise.

## How to run what exists

```bash
node scripts/check-contrast.mjs      # WCAG 2.2 AA token contrast
node scripts/check-a11y-static.mjs   # source scan, with a self-test
bun run check                        # both, plus everything else
```

Both run in the normal suite. The static scan also verifies itself: it runs its
rules over code that is wrong on purpose and fails if it stops detecting the
planted faults, because a scanner silently broken by a regex change would report
a clean codebase forever.

## Reporting an accessibility problem

Open an issue with what you were doing, what you expected, and what happened.
Say which assistive technology and browser if you were using one. Reports about
the gaps listed above are welcome — they are known, but a concrete instance is
worth more than the category.
