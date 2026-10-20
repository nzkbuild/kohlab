---
name: Kohlab
description: A quiet, charcoal app for building with Claude on a server you own. ChatGPT-like: separation by background not borders, no spinners or badges, one primary per view, follows the OS light or dark setting.
colors:
  surface-base: "#212121 dark / #ffffff light"
  surface-sidebar: "#171717 / #f9f9f9"
  surface-raised: "#2f2f2f / #f4f4f4"
  surface-bubble: "#303030 / #f4f4f4"
  surface-hover: "#2a2a2a / #ececec"
  surface-active: "#3a3a3a / #e5e5e5"
  surface-pressed: "#454545 / #d9d9d9"
  surface-terminal: "#181818 in both modes"
  text-primary: "#ececec / #0d0d0d"
  text-secondary: "#c4c4c4 / #3d3d3d"
  text-muted: "#a3a3a3 / #5d5d5d"
  text-faint: "#9a9a9a / #6e6e6e"
  line-subtle: "rgba(255,255,255,.10) / rgba(0,0,0,.10)"
  status-danger: "oklch(0.82 0.14 25) / oklch(0.55 0.19 25)"
typography:
  family: "Geist Variable (UI), Geist Mono Variable (machine text only)"
  body: "15-16px"
rounded:
  row: "8px"
  card: "16px"
  composer: "24px"
  button: "pill"
---

# Design System: Kohlab

## Overview

**North star: "A calm place to build."** Someone describes what they want, Claude builds it, asks before anything risky, and they look at a preview and keep or undo it. The look is ChatGPT / Claude desktop: charcoal in dark, white in light, nothing decorative. The app follows the OS (`prefers-color-scheme`); dark values live in `:root` of `web/src/index.css`, light values in the media block under it.

Copy is plain English in sentence case, no developer words in the main path. Icons are Phosphor only, regular weight (the running status dot is a filled shape, not an icon), 16px in rows and menus, 18px in header buttons. Geist is self-hosted; Geist Mono is only for whole machine values (file names, code, terminal output).

## Principles

- **No spinners, no looping animation, no "Working" badge or chip.** Claude working is one grey line in the chat ("Writing menu.html", or "Working") with a small dot that breathes (the one animation allowed; reduced motion turns it off), plus the send button turning into a round Stop button.
- **No status chip beside project names.** In the sidebar, status is one 7px dot in the text colour on the right of a row, only when the project needs you or is ready to check. It has an accessible label ("Needs you" / "Ready to check"). Nothing otherwise.
- **Separation by background, not borders.** No line between sidebar and page or under headers. Cards, the Ask box, icon tiles and secondary buttons are tonal fills with no border. The only lines left are focus rings, true dividers (between panes, a palette's search field, above a footnote), and the boundary of a text field (`line-strong`, 3:1 against its surface). The composer has none.
- **One primary per view.** The filled pill in `text-primary` colour (white in dark, near-black in light). A second action is secondary (tonal pill) or quiet.
- **Status never relies on hue.** Word and shape carry it; red means destructive only.

## Colours

Defined only in `web/src/index.css`, in two tiers: primitive ramps (`--neutral-*`, `--red-*`, `--lime-*`) and the semantic tier (what a thing is: `surface-raised`, `text-muted`, `status-danger`). The approved palette is written as hex in the semantic tier, light and dark. Components use semantic names via Tailwind (`bg-surface-raised`, `text-text-muted`); no component holds a colour literal or a primitive name. `scripts/check-contrast.mjs` audits the pairs.

| Role | Dark | Light |
|---|---|---|
| Page (`surface-base`) | #212121 | #ffffff |
| Sidebar | #171717 | #f9f9f9 |
| Field, composer, raised | #2f2f2f | #f4f4f4 |
| User message bubble | #303030 | #f4f4f4 |
| Hover | #2a2a2a | #ececec |
| Active row, segmented thumb, hovered secondary button | #3a3a3a | #e5e5e5 |
| Pressed secondary button | #454545 | #d9d9d9 |
| Text primary / secondary / muted / faint | #ececec / #c4c4c4 / #a3a3a3 / #9a9a9a | #0d0d0d / #3d3d3d / #5d5d5d / #6e6e6e |
| Terminal surface (always dark, `.dark-pane`) | #181818 | #181818 |

Lime (`status-running`) survives only in Settings and update panels as a "healthy" chip; it is never used for Claude working.

## Typography

Body and controls 15-16px, nothing below 12px. The type scale is tokens in `web/src/index.css`: `text-xs` 12px (meta, counts), `text-sm` 13px (controls, menu items, chips), `text-small` 14px (tool lines, the working line), `text-base` 15px (body, composer), `text-lg` 16px (prose headings). Use the tokens, never a bracketed pixel size. Home heading `text-2xl` (28px) weight 500. Headings are sentence case, no uppercase kickers. Counters and timestamps use tabular numerals. Mono only for a whole machine value, never for labels or a word in a sentence.

## Layout and shapes

- **Shell:** sidebar 260px on desktop (collapsible), off-canvas drawer below the `shell` breakpoint (900px); a 52px top bar on phones (menu, "kohlab", new-project pencil) with 44px hit areas. The composer is pinned at the bottom.
- **Radii:** rows 8px, cards 16px, composer 24px, user bubble 20px, buttons pills.
- **Sidebar:** wordmark, then Back and Forward arrows (Alt+← / Alt+→; disabled when there is nowhere to go inside the app), search (opens the command palette) and collapse; a "New project" row; a small "Projects" label and one flat list (needs-you first, then most recent). Each project row is one full-width 36px pill with an 8px radius: the name on the left, and on the right the status dot or, on hover, keyboard focus, selection or an open menu, the ⋯ button inside the pill. Hover is `surface-hover`, selected `surface-active`. No group headings, counts, times or status icons. Bottom: one account row that opens a menu with Settings, Keyboard shortcuts (not on touch screens) and Install app (when available).
- **Project header (56px, no border):** left, project name with a ⌄ menu (Rename, New chat for chat projects, Restart/Stop for terminal projects, Delete project); centre, one segmented pill switch. A project that runs Claude shows "Chat · Terminal · Changes" (Files too once power tools are on); a chat project shows "Chat · Changes"; a project without Claude shows "Terminal · Changes". Changes shows a muted count when above 0. Segments are of equal width and centred on the content column, beside an open preview pane too. The Chat or Terminal choice is remembered per project, and an old `terminal` link opens the remembered view. Right, a quiet Preview button with the Browser icon, pressed (`surface-active`, `aria-pressed`) while the pane is open. Title, switch and Preview are all 36px tall; the header's left and right padding are equal.
- **Chat:** 720px centred column. User message: right-aligned bubble, with a ⋯ menu under it that holds its message actions. Notes such as "Switched to Hermes" or "Went back to an earlier message" are quiet centred text between faint rules, not bubbles. Claude text: plain, no label. Tools: one muted 14px summary line with a chevron; a live run stays folded and the working line names the current step. Ready to check sits under the reply: "Changed N files", then Keep this version (primary), Preview (secondary pill), "Undo all since last keep" (quiet, confirmed as a danger action). Copy shows only under a finished Claude reply that ends in text (not mid-turn, not under a tool run), with a "Copy" tooltip. An Ask is a 16px-radius tonal card with no line: semibold title, muted reason, Allow (primary), Don't allow (secondary), "Show details" quiet, 12px between buttons.
- **Composer:** one 24px raised box with no border, in two rows. The top row holds attached files and the text. The bottom row, left: quiet icon-only squares for Add files (paperclip) and Commands ("/", tooltip "Commands (type /)"), then the model (its effort sits inside the model menu) and the mode, each with its one-line detail in the menu. The row's left edge sits 10px into the margin, so the first glyph and the text chips' labels line up with the text above. Other composer chips are text plus a caret, no leading icons. The AI chip shows the AI's name (Claude, Hermes, omp, Codex); an AI that is not signed in is listed but disabled, with "Sign in first in Settings". "Saved (N)" appears only when prompts are saved for later. Chat projects have no Commands chip, since Claude chat runs without slash commands. On phones the Commands chip is hidden (typing "/" still opens the list). Right: the context chip when it applies, then one round button. It is Send when idle (disabled when empty), and Stop (square, aria-label "Stop") for the whole time Claude works, whatever is typed. Enter while Claude works queues the text: a quiet card above the box reads "Waiting to send: “first 80 characters”" and "Sends when Claude finishes" (the server holds the message, so the card has no buttons). Ctrl/Cmd+Enter stops and sends the box now. Never two round buttons side by side. The "/" and "@" lists open above the box. Placeholder on desktop: "Message Claude — / for commands, @ for files"; on a phone: "Message Claude".
- **Context chip:** shown only at 50% of the context window or more: "Chat 72% full", and "Chat almost full" from 85%. Its click opens the Usage dialog.
- **Usage dialog:** titled "Usage", opened by Ctrl/Cmd+U (listed in Keyboard shortcuts), the account menu, the command palette or the context chip. "Your Claude plan": two slim meters (a `surface-raised` track, `text-secondary` fill, `role="meter"`), "Next few hours" and "This week", each "34% used · resets at 7:20 pm" ("resets tomorrow at …" when not today). "This chat: 23% full" with "Long chats get summarised automatically. Start a fresh project chat for a new task." when a Claude chat is open. Only the owner's plan is read (`GET /api/usage`; others see "Only the server owner can see plan usage."); loading is skeleton rows, failure is one sentence with a secondary Try again.
- **Connection:** when two background refreshes in a row fail, a slim full-width line at the top of the page reads "Can't reach Kohlab. Trying again…" (`surface-raised` fill, `text-sm`, no border, `role="status"`). The next success hides it. Uploads and other requests show the same plain sentence.
- **Keyboard shortcuts:** a dialog opened by "?" (outside text fields), by the command palette or by the account menu. It lists only the keys that exist. Ctrl-key hints are hidden on touch screens (`(pointer: coarse)`).
- **Home:** centred "What should we build?", the composer, starter chips (tonal pills, no line). If a project needs you, at most one quiet link line under the chips.
- **Terminal project:** the terminal sits in a #181818 panel, radius 14px, 12px from the edges (not the top), 20/24px inner padding. Attach and Copy float inside it.

## Components

Radix primitives are styled once in `web/src/components/ui.tsx` (Button, Menu, Tabs, Dialog, Tooltip, Field, Panel, EmptyState, Skeleton, Kbd, ...); surfaces import from there, never from `@radix-ui/*`. The status icon comes only from `STATUS_ICON` in `ui.tsx`; running is a small static filled dot, never a spinner glyph.

Buttons: min-height 40px (44px on touch), weight 550. Primary filled, dimmed to 40% when disabled; secondary tonal (`surface-raised` fill, hover `surface-active`, pressed `surface-pressed`, no border); quiet borderless; danger red text on a red tint. Icon-only buttons are square with an `aria-label`. Focus is a 2px soft grey (focus-ring token) outline, inset on full-width rows, shown for keyboard use only.

Chip (`ComposerChip` in `ui.tsx`): a quiet pill trigger for composer controls. 32px tall (44px on touch), 13px secondary text, an optional 14px icon before the label and a 12px caret when it opens a menu. Hover `surface-hover`; open or pressed `surface-active`; no border. It forwards its ref, so it can be a Menu trigger. The status chip (`Chip`) is a different thing and stays for status words.

Menus, dialogs and the palette sit on `surface-overlay` with a soft shadow; in-page cards and rows are flat. The "/" and "@" lists in the composer use the same surface, radius, shadow and item sizes as the menus. Forced-colors maps borders and outlines to system colours.

## Do and Don't

- Do add colour by adding a primitive, aliasing it in the semantic tier and bridging it in `@theme inline`; give every colour a light and a dark value.
- Do size controls with `--control-h`, `--control-h-sm`, `--row-h` as min-height; stack with the `--z-*` tokens.
- Do keep one `<h1>` per surface.
- Don't add spinners, looping animation, badges, or status chips next to names. The skeleton shimmer and the working line's breathing dot are the only exceptions.
- Don't put a border between sidebar and page or under a header.
- Don't put a hex, OKLCH literal or primitive name in a component; don't import `@radix-ui/*` outside `ui.tsx`.
- Don't add hero metrics or summary tiles to Home; don't load fonts from a third party.
