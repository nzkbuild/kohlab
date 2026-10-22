# UI Laws + Laws of UX audit: Kohlab (HEAD 26dcfb8, v2.3 work in progress)

Date: 2026-10-22. Baseline: `docs/research/laws-of-ux-audit.md` (2026-10-20, v2.1.0). Rules audited: the 13 on https://www.uilaws.com and the 30 on https://lawsofux.com. Binding rules: `PRODUCT.md`, `DESIGN.md`.

Screenshots are in `/tmp/uilaws/shots/` (throwaway, not committed), named `<view>-<desk|phone>-<dark|light>.png`: desk is 1280x900, phone is 390x844. Scripts and raw numbers are in `/tmp/uilaws/` (`audit.jsonl`, `log.jsonl`). `file:line` cites the tree at HEAD 26dcfb8.

## How this was done

- **uilaws.com.** The index page fetched fine. Its law pages are client-rendered, so WebFetch only ever saw the "Law not found" shell. There is no bot protection on the site. The text of all 13 laws sits in the site's own public JavaScript data chunk (`/_next/static/chunks/753-098a68f325281641.js`), and I read the one-line description and "practical application" from that. Nothing was bypassed.
- **lawsofux.com.** Re-read the index (30 laws) and used the earlier audit as the baseline.
- **The real app.** I built `web/` and ran a throwaway server on 127.0.0.1:7801 with a temp `WORKS_DIR` and its own pty daemon. I seeded 6 chat projects (ready to check, asking, kept, error, empty, live), wrote a realistic transcript, and ran two short real Claude Haiku 5.5 exchanges (permission ask, Allow, ready card, Keep). I drove it with Playwright in 4 variants (desk/phone x dark/light), about 150 screenshots.
- **A caveat on timing.** The reviewer committed `26dcfb8` while I worked. My first ~40 page loads used a build from just before it. That build had a cold-load crash (finding F1 below). After rebuilding at 26dcfb8 I re-tested, and the crash is gone. Everything else is measured on, or re-checked against, the final tree.

## STEP 1: the 13 rules on uilaws.com

| # | Rule | One line | Practical takeaway |
|---|---|---|---|
| 1 | Symmetry | Mirrored elements are seen as one whole. | Balance layouts around a central axis; use it for the key controls. |
| 2 | Rule of Thirds | A 3x3 grid; put key elements on its lines. | Anchor headline and main action near the third lines, not dead centre, and do it the same on every similar screen. |
| 3 | White Space | Empty space aids reading and focus. | Generous padding between groups, tighter inside them. |
| 4 | Color Theory | Colour carries emotion and state. | Few colours, used for meaning (state, emphasis), consistently. |
| 5 | Typography Hierarchy | Size, weight and colour order the content. | Each level must look clearly different, with a consistent scale. |
| 6 | Consistency | Same elements look and act the same. | One button style per role, one radius and height scale, one vocabulary. |
| 7 | Proximity | Near means related. | Group related controls and keep unrelated ones apart. |
| 8 | Contrast | Things that differ stand out. | One clear primary; contrast for text and for state. |
| 9 | Closure | The mind completes partial shapes. | Fills and shapes can imply edges, but keep enough contrast that the shape is read. |
| 10 | Continuity | Things on a line or curve read as related. | Align edges and rows; show progress as a line of steps. |
| 11 | Fitts's Law | Big, near targets are quicker. | Make the main action large and in a reachable corner; give touch targets room. |
| 12 | Hick's Law | More choices, slower decisions. | Categorise, default, hide the rarely used. |
| 13 | Jakob's Law | People expect what other sites do. | Follow conventions; innovate only where it pays. |

## STEP 2: Laws of UX

The 30 laws are as on lawsofux.com. Their one-line definitions are in the earlier audit and unchanged. The per-law verdicts below carry the earlier verdict, what changed, and what is still open.

## Measurements (HEAD 26dcfb8, desktop 1280x900, local server)

**Click-to-feedback.** Doherty threshold is 400 ms. Times include Playwright overhead of about 20-40 ms, so treat them as upper bounds.

| Interaction | Now | Earlier audit |
|---|---|---|
| Send to user bubble | 351 ms | 226 ms |
| Send to Stop button | **463 ms** (live) | 339 ms |
| Allow to card replaced | 154 ms | 129 ms |
| **Keep click to "Kept this version" note** | **3584 ms** (live, Haiku project) | 102 ms (button only; the note did not exist) |
| Sidebar click to other chat painted | 182-328 ms | 1016 ms |
| Changes tab, first visit / warm | 1004 ms / 458-813 ms | 1288 ms / 145-171 ms |
| Preview open | 134-177 ms | 248 ms |
| Palette open | 110-177 ms (first 347 ms) | n/a |
| Project menu / model menu / account menu | 144-207 / 118-189 / 125-129 ms | n/a |
| Starter chip fills the box | 109-125 ms | n/a |
| Live Haiku: ask card / ready card | 4.6 s / 11.5 s | 5.4 s / 7.9 s |

The Keep delay is a code cause, not a slow server. `POST /commit` answers in 80 ms (curl). But `keep()` at `ChatView.tsx:2298-2308` never calls `repoll()`, so the note waits for the next chat poll. For about 3.5 s the only feedback is the button dimming to 40%.

**Choices per menu.**

| Menu | Choices |
|---|---|
| Home | 1 field, 1 AI chip, 7 starter chips, 2 quiet links, up to 2 status rows |
| Composer | attach, AI, model, mode, Send (5) |
| AI menu | 4 (1 disabled) |
| Model menu | 4 plus "Show older models"; expanded, 14 (was 13) |
| Mode menu | 4, each with a one-line detail |
| Project menu | 7 (was 7; the terminal items are gone, "Make a copy" is new) |
| Sidebar row ⋯ | 2 |
| Account | 3 desktop, 2 phone |
| Palette, empty query | 17 options in groups (searchable) |
| Preview ⋯ | 4 |
| Message ⋯ | 1-2 |
| Phone "AI and model" | 9 (4 AIs plus 5 model rows) |
| Ready card | 4 actions (Preview, Keep, Check it works, Undo all since last keep) |
| Settings | 5 sections |

**Target sizes (Fitts).**
- Desktop, smallest first:
  - Sidebar ⋯ is 28x28.
  - Chat/Changes segment is 108x30.
  - Message ⋯, search and collapse are 32x32.
  - AI/model/mode chips are 32 tall (86-102 wide).
  - Copy reply is 40x40; Send and attach are 40x40.
  - Ready-card buttons are 41 tall (Keep 170, Preview 107, Undo 216 wide).
  - Preview-bar icons are 40x40; the device size buttons are 32 tall.
  - Allow is the same size as Don't allow.
- All of these pass WCAG 2.2 AA (24 px). The 28-32 px ones are below DESIGN's 40 px and below 44 px.
- Phone: every control measured is 44 px or more. The exceptions are the project-title menu trigger (142x36) and the textarea row (36, inside a taller box).

**Contrast.** The audit checked every visible text node against its nearest opaque background, in 4 variants, about 25 views.
- Only one text fails WCAG AA 4.5:1: the Changes count badge.
  - Dark: 4.04:1.
  - Light: 4.05 to 4.32:1.
  - It is `text-text-faint` on the active segment (`WorkspaceDetail.tsx:787`).
- UI-shape contrast, computed from the tokens:

| Pair | Ratio |
|---|---|
| Composer fill vs page, dark | 1.20:1 |
| Composer fill vs page, light | 1.10:1 |
| Ready/Ask card vs page, dark | 1.20:1 |
| Sidebar vs page, light | 1.05:1 |
| Primary button vs page, dark | 13.6:1 |

  - The light composer's edge is barely visible (`chat-ready-desk-light.png`). It is a deliberate DESIGN choice, so this is an owner decision (F17).

**Type scale in use.**
- Tokens (`index.css:288-303`): 12 (`2xs` and `xs` are the same), 13, 14, 15, 16, 20, 28.
- Steps actually rendered per view: Home 12/13/15/28; chat 12/13/14/15; Settings 12/13/14/15/16/28; empty chat 12/13/15/20; Usage dialog adds 16/20.
- Five steps sit within 4 px (12-16 px), a ratio of 1.04-1.08 per step. Hierarchy in chat leans on weight (400/500/550/600) and colour.
- Usage count: `text-sm` 98, `text-xs` 82, `text-base` 43, `text-small` 33, `text-lg` 4, `text-2xs` 3 (DiffView only), `text-xl` 2, `text-2xl` 2.

**Spacing (gaps used per view).**
- Home: 2, 4, 6, 7, 8, 10, 16 (7 values).
- Chat ready: 2, 4, 6, 7, 10, 12, 24 (7).
- With a menu open: add 8 (8).
- Usage dialog: 2, 4, 6, 7, 10, 12, 16, 20, 24 (9).
- Settings: 2, 4, 7, 10, 12, 16, 32.
- 6, 7 and 10 are off a 4/8 grid. 7 is the sidebar's dot slot.

**Distinct button styles per view.**
- Counted as fill x radius x text/icon, including the sidebar that is always on screen.
- Home 8 (3 filled); chat ready 10 (4 filled); preview open 11; Add-picture dialog 12 (6 filled).
- Radii on buttons: 6 (sidebar ⋯), 8 (rows), 10 (wordmark button), 14 (tool-summary toggles), pill. DESIGN names 8 for rows and pill for buttons.
- Heights seen: 28, 30, 32, 36, 40, 41. The 41 is `.btn`: DESIGN says 40.

## STEP 3 inventory (what was captured)

- Home: `home-*`, `new-project-*`, `home-drawer-phone-*`.
- Chat idle, working, asking, asked-after-restart, error, empty, kept: `chat-ready-*`, `chat-working-early-*`, `chat-asking-live-*`, `chat-asking-restart-*`, `chat-error-*`, `chat-empty-*`, `chat-kept-*`.
- Live Haiku exchange: `chat-live-empty-*`, `chat-after-allow-*`, `chat-ready-live-*`, `chat-kept-live-*`.
- Ready card: `chat-ready-*`, `chat-ready2-*`. Tools open: `chat-tools-open-*`.
- Preview: `preview-*`, `preview-size-tablet-*`, `preview-size-phone-*`, `preview-oldversion-*`.
- Changes and Earlier versions: `changes-*`, `changes-versions-*`.
- Settings: `settings-*`, `settings-2-*`.
- Menus: `menu-project-*`, `menu-row-*`, `menu-account-*`, `menu-ai-*` (desk), `menu-aimodel-*` (phone), `menu-model-*`, `menu-model-older-*`, `menu-mode-*`, `menu-message-*`, `menu-preview-*`.
- Palette: `palette-*`.
- Dialogs: `dialog-notes-*`, `dialog-share-*`, `dialog-picture-*` (desk only; the phone flow could not reach it), `dialog-usage-*`, `dialog-shortcuts-*` (desk only), `dialog-undo-*`.
- Not captured: the "Usage" numbers (the throwaway server has no Claude plan data, so the dialog stays on its skeleton), and the Add-picture dialog on phone.

---

## Part A: UI Laws (uilaws.com)

Verdicts: good / needs work / violated. "Fix" refers to the numbered fixes in the top-20 list below.

| Rule | Verdict | Evidence | Fix |
|---|---|---|---|
| **Symmetry** | **good** | The Chat/Changes switch is centred on the content column, measured at x=770 for both (`chat-ready-desk-dark.png`, `WorkspaceDetail.tsx:754-790` grid with equal side columns). Asymmetry is only where chat convention wants it (user bubble right, Claude left). With the preview open, the switch moves to its own centred row (`preview-desk-dark.png`), so it still reads as balanced. | none |
| **Rule of Thirds** | **needs work** (minor) | Two screens that look the same sit at different heights. Home's heading is at y=154 (17% of 900, `WorkspacesView.tsx:425` `pt-[12vh]`). The empty chat's heading is at y=401 (45%, `ChatView.tsx:2617` `justify-center`), and its heading is 20 px (`ChatView.tsx:2651`, `text-xl`) against Home's 28 px (`WorkspacesView.tsx:426`, `text-2xl`). Compare `home-desk-dark.png` with `chat-empty-desk-dark.png`: after the first message, the composer jumps 247 px. | F8 |
| **White Space** | **good** | A 720 px column, 24 px between blocks, 12 px between a card's parts. Weak spots are small. On phone the ready card wraps to three rows of buttons with only 6 px between rows (`chat-ready-phone-dark.png`, `ChatView.tsx:2701-2719` `gap-1.5`). | F11 (a shorter Undo label removes one wrap) |
| **Color Theory** | **good** | Monochrome charcoal/white. Red only on Delete, the Undo confirm and the error line (`menu-project-desk-dark.png`, `dialog-undo-desk-dark.png`). Status is never colour-only. One drift: the error line is red text (`chat-error-desk-dark.png`, `ChatView.tsx:2515-2518`), but DESIGN says "red means destructive only". | F20 |
| **Typography Hierarchy** | **needs work** | Five steps sit inside 12-16 px (see Measurements). Chat uses only 12/13/14/15. A Claude reply's heading is 16 px against 15 px body (`ChatView.tsx:772`), and the "Ready to check" card title is 15 px semibold, the same size as body (`ChatView.tsx:2703`). Hierarchy is carried by weight alone. `text-2xs` is an alias of `xs` and is used 3 times (`DiffView.tsx`). | F14, F16 |
| **Consistency** | **needs work** | Good: one component set, vocabulary now matches (Keep/Kept, Ready to check in tab title `App.tsx:78`). Not consistent: button heights 28/30/32/36/40/41 and button radii 6/8/10/14/pill (measured, `chat-ready-desk-dark.png`). Dialogs close three ways: Usage, Shortcuts and Share have no visible close button, while Notes and Add picture have Cancel (`dialog-usage-desk-dark.png` vs `dialog-notes-desk-dark.png`). One view has two primaries (see Contrast). | F13, F16, F18, F3 |
| **Proximity** | **good** | Allow / Don't allow 12 px apart; ready-card parts grouped; user ⋯ under its bubble. One miss: in Earlier versions, the time column has a variable width, so the labels do not line up (see Continuity). | F12 |
| **Contrast** | **needs work** | The primary is strong (13.6:1) and there is one per ready card. Misses: (1) **two primaries** in the earlier-version view, "Keep this version" in the chat plus "Go back to this one" in the preview bar (`preview-size-tablet-desk-dark.png`, `preview-oldversion-desk-light.png`, `PreviewPanel.tsx:536`, `DiffView.tsx:489`); (2) **needs-you and ready-to-check are the same dot** (`home-desk-dark.png` sidebar, `Sidebar.tsx:480`, `index.css:985`); (3) the count badge is 4.04:1 (`WorkspaceDetail.tsx:787`); (4) the light composer's edge is 1.10:1. | F3, F4, F5, F17 |
| **Closure** | **good** | The composer, cards and segmented switch are read as whole shapes from a fill alone, and no border is needed (`chat-ready-desk-dark.png`). The risk is the light composer's 1.10:1 fill (see Contrast). | F17 |
| **Continuity** | **needs work** | Left edges differ. The sidebar wordmark starts at x=12, its "Projects" label and rows at x=19-20 (`home-desk-dark.png`). The composer's text starts at x=426, but chat text at x=434 (`chat-ready-desk-dark.png`; `Composer.tsx`, `px-4`). In Earlier versions the time column is as wide as its text ("now", "5 min"), so the labels start at x=459 and x=467 and the buttons do not line up (`changes-versions-desk-dark.png`, `DiffView.tsx:520`). On phone the labels truncate to "First d…" (`changes-versions-phone-dark.png`). Good: the Home and chat columns line up. | F12, F17 |
| **Fitts's Law** | **needs work** | Phone is excellent: every control 44 px or more. Desktop is smaller than DESIGN's 40 px for several controls: sidebar ⋯ 28x28, segment 108x30, message ⋯ 32x32, chips 32. Improved since earlier: Allow now matches Don't allow (`chat-asking-live-desk-dark.png`), starter chips are 44 px on touch, toasts are top-centred (`App.tsx:101-107`). Send is a 40 px round in the bottom-right corner (good). | F13 |
| **Hick's Law** | **good** | Model menu is 4 plus "Show older models" (`menu-model-desk-dark.png`, `ChatView.tsx:1244`), mode menu 4, project menu 7, Home 7 chips (at the limit; `home-desk-dark.png`). Palette has 17 but is searchable and grouped. The ready card has 4 actions in 3 style tiers (one primary, one secondary, two quiet). | none |
| **Jakob's Law** | **good** | Sidebar, centred "What should we build?", pill composer, bubble right and plain reply left, Stop replaces Send, a "/" palette on Ctrl+K: all as in ChatGPT or Claude (`home-desk-dark.png`, `chat-ready-desk-dark.png`). Toasts are borderless and top-centred. New project opens the composer (`new-project-desk-dark.png`). The one bare-glyph control is "Copy reply" (`ChatView.tsx:453`). | none |

Tally: 7 good (Symmetry, White Space, Color Theory, Proximity, Closure, Hick, Jakob), 6 needs work (Rule of Thirds, Typography, Consistency, Contrast, Continuity, Fitts), 0 violated.

## Part B: Laws of UX

"Earlier" is the verdict in `laws-of-ux-audit.md`. "Now" is today's.

| # | Law | Earlier / Now | What improved since | Evidence (screenshot, file:line) and what is still open | Fix |
|---|---|---|---|---|---|
| 1 | Aesthetic-Usability | good / **good** | Preview-open header no longer collides (the switch drops to its own row). Toast moved top-centre and borderless. | `preview-desk-dark.png`, `App.tsx:101-107`. The look also hid the cold-load crash (F1). | F1 |
| 2 | Choice Overload | violated / **good** | Model menu: 13 entries became 4 plus "Show older models". | `menu-model-desk-dark.png`, `ChatView.tsx:1244`. Expanded it is 14 rows (`menu-model-older-desk-dark.png`), which is the opt-in case. Open: the mode names "Auto" and "Edits allowed" (`ChatView.tsx:185`) are still jargon-ish. | none |
| 3 | Chunking | good / **good** | "You allowed Claude to create index.html" now sits before the "Wrote 1 file" it unlocked. | `chat-kept-live-desk-dark.png`. | none |
| 4 | Cognitive Bias | needs work / **good** | Preview is primary until the person has opened it, then Keep. | `chat-ready-desk-dark.png`, `ChatView.tsx:2565`. | none |
| 5 | Cognitive Load | needs work / **needs work** | Terminal items are gone from a chat project's menu. The preview address reads "Your page". Ready card has a hint line. | Still developer words in the main path: "Ran 1 command", "Looked at the project folder", "Created index.html" (`chat-tools-open-desk-dark.png`, classifier at `ChatView.tsx:80-120`, lines written by `chat.ts` `describeTool`), "You allowed Claude to run a command / Show details" (live exchange), "Show the code", and Haiku's reply names `index.html` in a code chip (`chat-kept-live-desk-dark.png`) despite the system prompt (`chat.ts:54`). Shortcuts lists "Ctrl `" for the terminal (`ShortcutsDialog.tsx:15`). | F6 |
| 6 | Doherty Threshold | needs work / **needs work** | Sidebar click to chat is 182-328 ms (was 1016). Preview opens in 134-177 ms. Changes first visit is 1004 ms (was 1288). | **Keep takes 3584 ms to show its note** (`ChatView.tsx:2298`, no `repoll()`). Send to Stop is 463 ms. Changes first paint is still above 400 ms. | F2, F10 |
| 7 | Fitts's Law | needs work / **needs work** | Allow equals Don't allow; empty composer centred; chips 44 px on touch; toast top-centre. | Desktop ⋯ 28, segment 30, message ⋯ 32. | F13 |
| 8 | Flow | needs work / **good** | New project opens Home's describe-first composer (`new-project-desk-dark.png`). | Empty project has heading and composer only, no starters (`chat-empty-desk-dark.png`). Minor. | none |
| 9 | Goal-Gradient | needs work / **needs work** | After Keep: "Show someone: Copy link" (`chat-kept-live-desk-dark.png`). | No progress cue while working; only "Working 1s" (`chat-working-early-desk-dark.png`, `ChatView.tsx:264`). | F15 |
| 10 | Hick's Law | needs work / **good** | Model menu 4; project menu has no terminal items; Home shows both status rows. | `home-desk-dark.png`. | none |
| 11 | Jakob's Law | needs work / **good** | New project opens a composer; the empty-chat composer is centred; toasts are borderless. | `new-project-desk-dark.png`, `chat-empty-desk-dark.png`. Open: bare-glyph Copy reply (`ChatView.tsx:453`). | none |
| 12 | Common Region | good / **good** | Ready block is now a tonal card like the Ask card. | `chat-ready-desk-dark.png`, `ChatView.tsx:2701`. | none |
| 13 | Proximity | good / **good** | none needed. | Open: Earlier-versions columns do not align (`changes-versions-desk-dark.png`). | F12 |
| 14 | Prägnanz | good / **good** | none needed. | Open: a one-segment "Chat" switch shows on empty and error chats (`chat-empty-desk-dark.png`, `chat-error-desk-dark.png`), a control with one choice. | F9 |
| 15 | Similarity | needs work / **needs work** | Vocabulary is one set (Keep/Kept, tab title "kohlab, 1 ready to check" at `App.tsx:78`, notifications at `useSync.ts:89-96`). | Needs-you and ready-to-check are still the same dot (`Sidebar.tsx:480`). Undo has three labels: "Undo all since last keep" (`ChatView.tsx:2719`), "Undo" (Changes, `DiffView.tsx`), "Undo the changes?" (dialog). | F5, F11 |
| 16 | Uniform Connectedness | good / **good** | none needed. | `chat-kept-live-desk-dark.png`. | none |
| 17 | Mental Model | needs work / **needs work** | A question asked before a restart stays visible, dimmed, above "Kohlab restarted…" (`chat-asking-restart-desk-dark.png`, `ChatView.tsx:2506`). | Builders still see file words: "Changed 2 files", file names, "New/Changed" (`changes-desk-dark.png`), "Undo all since last keep" needs a model of checkpoints. | F6, F11 |
| 18 | Miller's Law | good / **good** | none needed. | Every menu is 7 or fewer except the opt-in expansion (14) and the grouped palette (17). | none |
| 19 | Occam's Razor | needs work / **needs work** | Preview and Changes are hidden until there is something to see (`chat-empty-desk-dark.png`). | One-segment switch; header Preview and the ready-card Preview both show (`chat-ready-desk-dark.png`); the Changes tab repeats Keep/Undo. | F9 |
| 20 | Paradox of the Active User | good / **good** | Ready card hint "Look at it in Preview, then keep it or undo it" (`ChatView.tsx:1710,2289`). | none | none |
| 21 | Pareto | needs work / **good** | The 80% path (describe, Allow, Preview, Keep) now ends with a note and a "Copy link". | Keep is slow (F2). | F2 |
| 22 | Parkinson | good / **good** | Describe-first New project; chip fills in about 110 ms. | none | none |
| 23 | Peak-End | violated / **needs work** | Keep adds a "Kept this version" note and "Show someone: Copy link"; no toast over Send. | The ending arrives 3.6 s late and is 12 px faint text (`chat-kept-live-desk-dark.png`). Claude's last line still says "Press Preview" under it. | F2 |
| 24 | Postel | good / **good** | none needed. | Enter while Claude works queues; drafts kept. | none |
| 25 | Selective Attention | needs work / **needs work** | Home shows both states as tonal rows (`home-desk-dark.png`, `WorkspacesView.tsx:557,564`). | The rows are plain text with no icon or caret, so they read as captions. The two quiet links under the starters have no affordance (`WorkspacesView.tsx:518-530`). Sidebar dots look identical. | F5, F7 |
| 26 | Serial Position | good / **good** | none needed. | none | none |
| 27 | Tesler | needs work / **good** | Four plain model choices; "Ask Claude again" after a restart. | The mode menu still asks a first-timer to pick (default is safe). | none |
| 28 | Von Restorff | good / **needs work** | The Keep/Undo toasts that competed with Send are gone. | **Two primaries in one view** (`preview-size-tablet-desk-dark.png`, `PreviewPanel.tsx:536`, `DiffView.tsx:489`), which breaks DESIGN's "one primary per view". | F3 |
| 29 | Working Memory | needs work / **good** | Notifications and announcements use the title (`useSync.ts:89`), ids are no longer doubled, the stale question stays, drafts persist. | none | none |
| 30 | Zeigarnik | needs work / **good** | Sidebar lists needs-you, then ready (`home-desk-dark.png`); Home shows both; tab title says "ready to check". | The two states look alike in the sidebar (F5). | F5 |

Tally now: 20 good, 10 needs work, 0 violated. Earlier: 12 good, 16 needs work, 2 violated.

**Improved since the earlier audit (verified in this run):** Keep's ending note and Copy link (23); Preview-first button order (4); four-choice model menu (2, 10); Allow = Don't allow (7); stale question kept (17); describe-first New project and centred empty composer (8, 11); header collision gone (1); borderless top-centre toasts (1, 11); ready card as a tonal card with a hint (12, 20); "You allowed…" before its effect (3); titles not ids in notifications (29); sidebar click to chat 1016 to about 250 ms (6); tab title "ready to check" (15).

**Still open:** Keep latency 3.6 s (6, 23); dot shapes (15, 25, 30); developer words (5); one-segment switch and duplicate Preview (14, 19); Home rows lack affordance (25); two primaries in the earlier-version view (28); undo vocabulary (15); progress cue (9).

---

## Findings that are not in a law

- **F1 (found, now fixed in the tree).** On a hard load or reload of any `/w/<id>` URL, the app showed "Workspace failed to render, Minified React error #310". Measured in the pre-26dcfb8 build: 7 of 8 sequential hard loads in one browser context crashed, and my screenshot script had to click "retry" 42 times across the 4 variants. A fresh browser context did not always show it. Cause: a `useRef` and a `useEffect` were added after the `if (!w)` early return in `WorkspaceDetail.tsx` (then at lines 667 and 672). When the workspace list arrived after the first render, React saw more hooks than before. At 26dcfb8 the ref is at `WorkspaceDetail.tsx:513`, above the `if (!w)` at 522, and 7 sequential hard loads gave 0 crashes. The remaining work is a guard so it cannot come back (F1).
- **Haiku named the file anyway.** `chat-kept-live-desk-dark.png`: "I made a one-page lemonade stand website in `index.html`". The system prompt (`chat.ts:54`) bans git words and "open it in your browser" but not file names.

---

## Top 20 fixes

Package A touches only `ChatView.tsx`, `Composer.tsx` and `chat.ts`. Package B touches every other `web/src` file, `DESIGN.md`, and new files under `scripts/`. The two packages share no file, so two workers can run in parallel. Where a fix needs a DESIGN.md sentence, it is listed under B.

Effort: S under 1 hour, M a few hours, L a day or more. Verify with `cd web && bun run build`, a throwaway server on its own port, and Playwright, as in this audit. The scripts in `/tmp/uilaws/` (`scen2.mjs`, `bench.mjs`, `live2.mjs`) are throwaway; the commands below say what to measure.

### P0

| # | Pkg | Effort | Fix | Files | Verify |
|---|---|---|---|---|---|
| F1 | B | S | **Guard the cold-load crash.** The hook fix is in; add a check and a lint rule so it cannot return. A `scripts/check-cold-load.mjs` that hard-loads `/w/<id>` 8 times in one browser context and fails if "failed to render" appears; enable `react-hooks/rules-of-hooks` for `web/`. | `web/src/components/WorkspaceDetail.tsx` (already fixed; re-check), new `scripts/check-cold-load.mjs`, add to `scripts/check-all.mjs` | Re-introduce a hook after `if (!w)` on a scratch branch: the check must fail. On HEAD: 0 of 8 crash (7 of 7 were clean in my re-test). |
| F2 | A | S | **Immediate feedback for Keep, Undo and Send.** Call `repoll()` after `api.commit` in `keep()` so the "Kept this version" note shows at once (and the same for undo); set busy optimistically on send so Stop appears with the bubble; change the Keep label while it is in flight ("Keeping…", no spinner, per DESIGN). | `web/src/components/ChatView.tsx:2298-2308`, `:2330` (undo), the send path | Keep to note under 500 ms and Send to Stop under 400 ms in an in-page MutationObserver timeline (was 3584 ms / 463 ms). |
| F3 | B | S | **One primary in the earlier-version view, and fix its copy.** Make the preview bar's "Go back to this one" secondary while "Keep this version" is on screen (or demote Keep); change "from 55 min" to "from 55 min ago". Record in DESIGN's Preview-pane paragraph. | `web/src/components/PreviewPanel.tsx:532-540`, `web/src/components/DiffView.tsx:489`, `DESIGN.md` | In `preview-oldversion` at 1280 and 390: exactly one `.btn-primary` visible; the text reads "ago". |
| F4 | B | S | **Count badge passes AA.** Use `text-text-muted` (4.5:1 dark, 5.2:1 light) instead of `text-text-faint` (4.04:1) for the Changes count; add the pair (faint on `surface-active`) to the contrast check so it cannot return. | `web/src/components/WorkspaceDetail.tsx:787`, `scripts/check-contrast.mjs` | The in-page contrast audit reports 0 failures in all 4 variants. |

### P1

| # | Pkg | Effort | Fix | Files | Verify |
|---|---|---|---|---|---|
| F5 | B | S | **Two sidebar dot shapes.** Filled dot = needs you, ring = ready to check (shape, not colour). Keep the aria labels. Update DESIGN's "one 7px dot" sentence. | `web/src/components/Sidebar.tsx:480`, `web/src/index.css:985`, `DESIGN.md` | `home-*.png` shows both shapes; both pass 3:1; a screen-reader label still says "Needs you" or "Ready to check". |
| F6 | A | M | **Plain-language tool lines and no file names.** Rephrase "Ran 1 command", "Looked at the project folder", "Created index.html" ("Updated your page", "Looked around", "Checked it"); change `describeTool` and the classifier in step (they share prefixes); in the system prompt say "refer to the person's page as 'your page'; do not name files unless asked". | `web/src/components/ChatView.tsx:80-120`, `chat.ts` (`describeTool`, `CHAT_SYSTEM_PROMPT` at :54) | Seeded transcript: no "command", "folder" or file path in the folded summary. A live Haiku turn does not name `index.html` in its reply. `check-copy` still passes. |
| F7 | B | S | **Affordance on Home.** Give the two status rows a leading icon and a trailing caret; give "Attach a screenshot of a site you like" and "Ask me a few questions first" a 16 px Phosphor icon. | `web/src/components/WorkspacesView.tsx:518-530, 557-564` | `home-*.png`: rows and links read as controls; targets stay 44 px on touch. |
| F8 | A | S | **Empty chat matches Home.** Anchor the empty-chat heading and composer at Home's top-third offset (`12vh`) and use the same 28 px heading size. | `web/src/components/ChatView.tsx:2617-2651` | Heading y within 10 px of Home's (154), and the composer docks without a 247 px jump. |
| F9 | B | S | **Hide the one-segment switch.** When a project has only "Chat", show no switch at all (empty and error chats). | `web/src/components/WorkspaceDetail.tsx:754-790` | `chat-empty-*.png` and `chat-error-*.png` have no lone "Chat" pill; it returns when Changes appears. |
| F10 | B | M | **Changes under 400 ms.** Prefetch the diff and versions when the Changes count turns non-zero or the tab is hovered or focused, share the result with DiffView, and show `Skeleton` rows on first paint. | `web/src/components/DiffView.tsx`, `web/src/components/WorkspaceDetail.tsx`, `web/src/api.ts` | Tab click to "Keep this version" visible: first visit under 400 ms (was 1004 ms), warm under 300 ms. |
| F11 | A | S | **One name for Undo.** Rename "Undo all since last keep" (the longest button, 216 px, wraps on phone) to "Undo these changes", matching the Changes tab and the "Undo the changes?" dialog. | `web/src/components/ChatView.tsx:2719` | The three labels agree; the phone ready card needs one fewer wrapped row; the DESIGN sentence naming it is updated in F16's DESIGN pass. |
| F12 | B | S | **Earlier-versions rows align.** Give the time a fixed `w-16` tabular column; on phone stack Look and Go back under the label so it does not truncate to "First d…". | `web/src/components/DiffView.tsx:512-540` | `changes-versions-*.png`: labels start at the same x; no truncated label at 390. |

### P2

| # | Pkg | Effort | Fix | Files | Verify |
|---|---|---|---|---|---|
| F13 | B | S | **Desktop targets and radii.** Sidebar ⋯ 28 to 32 px; wordmark button radius 10 to 8; ⋯ radius 6 to 8; review `.btn` 41 px to 40. | `web/src/components/Sidebar.tsx:491`, `web/src/index.css` (`.btn`, sidebar rules) | In-page audit: no icon target under 32 px on desktop; radii set is 8 plus pill only. |
| F14 | A | S | **Chat heading scale.** Make Claude-reply headings `text-xl` (20) and sub-headings `text-lg` (16) semibold so they read as headings against 15 px body. | `web/src/components/ChatView.tsx:772-773` | A seeded reply with `#` and `###` headings: heading to body ratio at least 1.3 and 1.07 steps visible. |
| F15 | A | S | **Progress in the working line.** When Claude has a checklist, add "step 2 of 5" to the working line. | `web/src/components/ChatView.tsx:264` (WorkingLine), `:211` (Checklist) | A seeded checklist run shows "Writing menu.html · 2 of 5"; with no checklist it is unchanged. |
| F16 | B | M | **Token clean-up.** Delete `text-2xs` (alias of `xs`, 3 uses); fix the gap scale so 6, 7 and 10 move to the 4/8 grid; record the scale in DESIGN. | `web/src/index.css:288-291, 585-1050`, `web/src/components/DiffView.tsx`, `web/src/components/Sidebar.tsx`, `DESIGN.md` | The in-page audit lists at most 6 distinct gaps on Home and chat; no `text-2xs` left (`grep`). |
| F17 | A | S | **Composer lines up with messages; owner call on the light edge.** Composer text starts at x=426, messages at x=434: align them. Decide whether the light composer (1.10:1 against the page) gets an inset hairline (a shadow, not a border); if yes, add to DESIGN. | `web/src/components/Composer.tsx` (padding and class) | Composer text left edge equals prose left edge at 1280; `chat-ready-desk-light.png` composer edge is visible if the hairline is accepted. |
| F18 | B | S | **Every dialog can be closed visibly.** Add a quiet "Done" to Usage, Keyboard shortcuts and Share a link, as Notes and Add picture already have Cancel. | `web/src/components/UsageDialog.tsx`, `web/src/components/ShortcutsDialog.tsx`, `web/src/components/ShareDialog.tsx` | Each dialog has a 44 px (touch) close control reachable by Tab; Esc still works. |
| F19 | B | M | **Make the design rules a check.** A `scripts/check-design.mjs` that opens Home, a ready chat and the old-version view in a throwaway server and fails on: more than one filled primary, a desktop target under 28 px, text under 4.5:1, a one-segment switch. | new `scripts/check-design.mjs`, `scripts/check-all.mjs` | Passes on HEAD after F3, F4 and F9; fails on a scratch change that adds a second primary. |
| F20 | A | S | **Plain Ask and error cards.** When a question card has one question, drop the "Claude has a question" title or the repeated header, so there are not three heading levels (`chat.ts:273` + header chip + question). Make the error line neutral text with its warning icon (red stays for destructive). | `web/src/components/ChatView.tsx:1000-1007, 2515-2518`, `chat.ts:273` | A one-question card shows two lines at most; `chat-error-*.png` has no red text; DESIGN's "red means destructive" holds. |

### Package A: `ChatView.tsx`, `Composer.tsx`, `chat.ts`

F2, F6, F8, F11, F14, F15, F17, F20. Order: F2 first (the P0), then F6, then the rest in any order. F6 and F20 both touch `chat.ts` and `ChatView.tsx`: do them in one worker so the two files do not conflict.

### Package B: every other `web/src` file, `DESIGN.md`, new `scripts/` files

F1, F3, F4, F5, F7, F9, F10, F12, F13, F16, F18, F19. Order: F1, F3, F4 first (P0). The DESIGN.md edits (F3, F5, F11's sentence, F16, and F17 if accepted) go in one pass at the end to avoid conflicts. `web/src/components/DiffView.tsx` is touched by F3, F10, F12 and F16, and `index.css` by F5, F13 and F16: give each file to one worker at a time within the package.

## Cleanup note

The throwaway server, its pty daemon, the preview Chromes it started, and any Claude children it started were stopped. The temp dirs were removed and `git worktree prune` was run. No `kohlab/<id>` branches were created by this run: its projects live in separate temp repos, not in this one.
