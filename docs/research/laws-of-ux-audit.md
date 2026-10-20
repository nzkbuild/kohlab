# Laws of UX audit: Kohlab (v2.1.0, branch feat/conversation-layer)

Date: 2026-10-20. Source of the laws: https://lawsofux.com (30 laws). Method: built `web/`, ran a throwaway server on :7799 with a temp `WORKS_DIR`, seeded four chat projects (ready to check, asking, kept, empty), ran one real Claude Haiku 5.5 exchange (permission ask, Allow, ready to check), drove it with Playwright at 1280x900 and 390x844, dark and light. Screenshots were taken to `/tmp/lux/` (throwaway, not committed); names are cited below so the run can be repeated.

The journey under audit: first open → describe the idea → watch Claude work → answer a question → check the result → Keep / Undo → come back later → share.

## Measurements

**Latency (Doherty threshold is 400 ms).** Desktop, local server, warm cache unless noted.

| Interaction | Time to visible feedback |
|---|---|
| Send → user bubble in chat | 226 ms |
| Send → round button becomes Stop | 339 ms |
| Allow → card replaced by "You allowed…" | 129 ms |
| Keep → button disabled / block gone | 102 ms |
| Undo → confirm dialog | 150 ms |
| Preview → pane open | 248 ms |
| Chat ↔ Changes tab, warm | 145-171 ms |
| **Changes tab, first visit** | **1288 ms** |
| **Sidebar click → project chat painted** | **1016 ms** |
| Cold load → "What should we build?" | 621 ms |
| New project dialog → composer ready | 529 ms |
| Live Haiku turn: ask card / done | 5.4 s / 7.9 s |

**Number of choices per menu (Hick).**

| Menu | Choices |
|---|---|
| Home | 1 field, 1 AI chip, 4 starters, Send |
| Chat composer | attach, AI, model, mode, Send |
| AI chip | 4 (1 disabled) |
| **Model chip** | **13 models + search** (Default, Opus 5.5, Sonnet 5.5, Fable 5.1, Haiku 5.5, Haiku 4.5, Sonnet 5, Opus 5, Fable 5, Opus 4.8/4.7/4.6, Sonnet 4.6) |
| Mode chip | 4, each with a one-line description |
| Project title menu | 7 (Rename, New chat, Conversations ▸, Open terminal, Continue in Claude's terminal, Download project, Delete) |
| Sidebar row ⋯ | 2 |
| Account | 3 on desktop, 2 on phone |
| Palette, empty query | 8 |
| Preview ⋯ | 4 |

**Target sizes (Fitts).** Desktop: Send 40x40, Keep 170x41, Preview 107x41, Undo 216x41, **Allow 68x41**, **attach 32x32**, starter chips 161x36. Phone: Send 44x44, Keep 143x44, attach 44x44, **starter chips 36 px tall** (DESIGN asks for 44 on touch).

## Per-law verdicts

### 1. Aesthetic-Usability Effect: good
*Attractive designs are perceived as easier to use, and good looks can hide usability problems.*
- **Evidence:** the calm ChatGPT-style shell holds in all four variants (`home-projects-*`, `chat-ready-*`). The flip side is that the look hides real flaws: the header collides when Preview is open (`preview-desk-dark.png`; the title is cut to "Rosie's Bakery w" under the switch, `WorkspaceDetail.tsx:668`), and the bordered toast covers Send (`keep-after-desk-dark.png`).
- **Fix:** test the states the look hides: the preview pane at 1280 and below, and toasts over the composer. Fixes are in items P0-2 and P1-9.

### 2. Choice Overload: violated (model chip)
*Too many options degrade decisions, so highlight the relevant one and give tools to narrow.*
- **Evidence:** the model menu lists 13 entries, including seven legacy versions with near-identical blurbs ("Best for everyday, complex tasks" ×4) (`menu-Default-desk-dark.png`, `ChatView.tsx:1166`, `:2267`). A non-technical builder cannot tell Opus 4.7 from Opus 4.8.
- **Fix:** show four plain choices: "Recommended", "Fastest", "Most capable", "Balanced". Each maps to the newest model of its family. Put "Older models" behind one submenu row, and keep the search for power users only.

### 3. Chunking: good
*Group information into meaningful units with clear hierarchy.*
- **Evidence:** tool runs fold to one line ("Wrote 2 files and looked up 1 page"); the ready block groups "Changed N files" with its three actions (`ChatView.tsx:2377`); Settings uses sections. Weak spot: after a pending question, work done earlier in the same turn is held back (`ChatView.tsx:1617`). It then renders as "Wrote 1 file" *above* "You allowed Claude to create index.html", so the effect shows before its cause (`chat-done-live-desk-dark.png`).
- **Fix:** render the answered-ask line before the tool summary it unlocked, or merge them into one line: "You allowed it · Wrote index.html".

### 4. Cognitive Bias: needs work
*Mental shortcuts skew decisions (confirmation, default, anchoring bias).*
- **Evidence:** in the ready block, Keep is the primary and comes first, and Preview is secondary (`ChatView.tsx:2379-2390`). Default bias pushes people to Keep work they have not looked at. Claude's own reply says "Press Preview… then Keep", but the button order says the opposite.
- **Fix:** until the person has opened Preview for this turn, make **Preview** the primary and Keep secondary. Once they have previewed, Keep becomes the primary. There is still only one primary per view.

### 5. Cognitive Load: needs work
*Remove extraneous load and keep only goal-relevant information.*
- **Evidence:**
  - Developer words remain in the main path. The project menu shows "Open terminal Ctrl \`" and "Continue in Claude's terminal" on a *chat* project (`menu-project-desk-dark.png`, `WorkspaceDetail.tsx:541-565`).
  - The preview address bar shows `http://127.0.0.1:7799/p/5IUhHPsRQ…` (`preview-desk-dark.png`).
  - The Changes view lists `index.html` / `style.css`.
  - Claude's reply (Haiku) said "I made `index.html` in the project root… Open it in your browser" (`chat-done-live-desk-dark.png`), which ignores the system prompt in `chat.ts:54`.
- **Fix:**
  - Hide the terminal items unless power tools are on.
  - In the preview bar, show "Your page" plus the path after the project root, not the host.
  - Add a line to `CHAT_SYSTEM_PROMPT` telling Claude never to send the person to "open it in your browser", but to press Preview instead.

### 6. Doherty Threshold: needs work
*Respond within 400 ms; use perceived-performance tricks when you can't.*
- **Evidence:** in-chat actions are fast: 102-339 ms (see the table). Two navigations miss the threshold: opening a project from the sidebar takes 1016 ms, and the first Changes visit takes 1288 ms (the diff is fetched after the tab mounts). During that time the person sees the old view or an empty pane. Between Send and the first tool line, the only feedback for ~5 s is "Working 0s" (`chat-working-early-desk-dark.png`), which is acceptable.
- **Fix:**
  - Prefetch the chat snapshot on sidebar hover/focus and render the cached transcript at once.
  - Prefetch `api.diff` whenever `hasChanges` flips (ChatView already calls it at `ChatView.tsx:2062`; share that result with DiffView).
  - Show the `Skeleton` rows from `ui.tsx` for the first Changes paint.

### 7. Fitts's Law: needs work
*Big targets, close to where the user already is, with space between them.*
- **Evidence:**
  - **Allow** is the most consequential tap in the journey, yet it is only 68 px wide. That is smaller than Keep (170) and Don't allow (~105) (`chat-asking-live-desk-dark.png`).
  - The attach button is 32x32 on desktop.
  - Phone starter chips are 36 px tall (`WorkspacesView.tsx:270`, `h-9`), below DESIGN's 44 px touch rule.
  - In an **empty project**, the heading "What should Claude build?" sits at y≈255 while the composer is at y≈817, 560 px away (`new-project-chat-desk-dark.png`).
  - The "Saved" toast lands on top of Send (`keep-after-desk-dark.png`, `App.tsx:98-106`).
- **Fix:**
  - Give Allow a min-width equal to Don't allow (or `px-6`).
  - Use `min-h-[var(--control-h)]` / pointer-coarse 44 px on starter chips.
  - In an empty chat, centre the composer under the heading the way Home does; it moves to the bottom after the first message.
  - Raise the toaster offset on desktop above the composer (or position it `top-center`).

### 8. Flow: needs work
*Match challenge to skill, give feedback on what was done, remove friction.*
- **Evidence:**
  - Two different entry flows compete. Home starts with "describe it"; the sidebar's **New project** asks for a *name* first, then shows an empty chat with no starters (`new-desk-dark.png`, `new-project-chat-*`). Naming before describing breaks flow for a first-time builder.
  - The dialog's "More options" uses the native ▶ disclosure (`WorkspacesView.tsx:172`), not the Phosphor caret.
- **Fix:**
  - Make "New project" route to Home's composer: describe first, and Claude or the server names the project. The name dialog stays only behind "More options" (from a folder or a link).
  - Show the starter chips in an empty project too.

### 9. Goal-Gradient Effect: needs work
*People speed up near the goal, so show progress.*
- **Evidence:** the working line shows the current step and elapsed time, and Claude's todo list renders as a checklist when Claude makes one (`ChatView.tsx:165`). The full journey (describe → build → check → keep → share) has no sense of "almost there": after Keep nothing points to the last step (sharing).
- **Fix:** after Keep, add one quiet next-step line under the kept note: "Want to show someone? Copy link" (see Peak-End). When the checklist exists, show "2 of 5" in the working line ("Writing menu.html · 2 of 5").

### 10. Hick's Law: needs work
*Fewer, clearer choices when speed matters; reveal features progressively.*
- **Evidence:** Home is excellent: one field, four starters, one AI chip (`home-empty-*`). The chat composer shows three chips (AI, model, mode) whose meaning a beginner has to learn on the first message. The model chip has 13 options (see Choice Overload). The project menu has 7 options, two of them for developers.
- **Fix:**
  - Collapse the model chip as in item 2.
  - On phones it is already merged into "Claude · Default"; consider the same merge on desktop until the person changes something.
  - Trim the project menu to Rename, New chat, Conversations, Download, Delete (5).

### 11. Jakob's Law: needs work
*Users expect your product to work like the ones they already use.*
- **Evidence:** it matches ChatGPT/Claude desktop well: sidebar, centred "What should we build?", pill composer, bubble right, plain reply left, Stop replaces Send. It diverges in four ways:
  - ChatGPT's "New chat" opens an empty composer instantly, while Kohlab's opens a naming dialog.
  - In an empty chat the composer is pinned to the bottom rather than centred.
  - Copy under a reply is a bare 12 px glyph with no hover-revealed row of actions.
  - Toasts carry a 1px border, which DESIGN forbids ("fills not borders"; `App.tsx:105`).
- **Fix:**
  - New project → empty composer.
  - Centred composer in an empty chat.
  - Remove the toast border and use `surface-overlay` + shadow like the menus.

### 12. Law of Common Region: good
*A shared boundary or background groups elements.*
- **Evidence:** the Ask card is one tonal region (`chat-asking-live-*`); the composer box holds text and chips; menus sit on overlay surfaces. The ready block ("Changed 2 files" + buttons) has **no** region, so on phone it reads as part of Claude's reply (`chat-ready-phone-dark.png`).
- **Fix:** give the ready block the same `rounded-card bg-surface-raised` fill as the Ask card. It is the second "needs you" moment and should look like one.

### 13. Law of Proximity: good
*Things near each other read as related.*
- **Evidence:** a user-message ⋯ sits right under its bubble; Allow/Don't allow are 12 px apart; tool summaries sit inside the reply. On phone, "Undo all since last keep" wraps to its own row under Keep/Preview (`chat-ready-phone-dark.png`), which is fine.
- **Fix:** none needed. Keep the ready block's spacing when it gains a fill.

### 14. Law of Prägnanz: good
*People read complex visuals as the simplest form.*
- **Evidence:** single-column chat, one pill composer, flat sidebar rows, no chrome (`chat-ready-desk-dark.png`).
- **Fix:** none needed. Guard it: the preview-open header (`preview-desk-dark.png`) is the one place where shapes overlap and break the simple read.

### 15. Law of Similarity: needs work
*Things that look alike are read as the same kind of thing.*
- **Evidence:**
  - "Needs you" and "Ready to check" are the **same** 7 px dot in the sidebar (`home-projects-desk-dark.png`). The difference exists only in aria-labels and the palette text, so sighted users can't tell a question from a finished result.
  - The same action has three names: "Keep this version" (button), "Saved" (toast, `ChatView.tsx:2079`), "ready for review" (tab title and notification, `App.tsx:76`, `useSync.ts:85-91`).
  - Undo has three names: "Undo all since last keep" (chat), "Undo" (Changes, `DiffView.tsx:546`), "Changes undone" (toast).
- **Fix:**
  - Keep one dot shape but vary it within DESIGN (filled = needs you, ring = ready to check) and say which is which in the row's tooltip.
  - Use one vocabulary everywhere: "Keep" / "Kept", "Undo" / "Undone", "Ready to check".

### 16. Law of Uniform Connectedness: good
*Visually connected elements read as related.*
- **Evidence:** "You allowed Claude to create index.html" with a check sits in the flow it unlocked; the Preview button is pressed (`surface-active`) while its pane is open.
- **Fix:** none needed beyond the ordering fix in item 3.

### 17. Mental Model: needs work
*Users bring a model of how things work from elsewhere; match it.*
- **Evidence:**
  - Builders think in "my page" and "save" or "publish", but Kohlab speaks of files ("Changed 2 files", `index.html`, "Show the code").
  - After a server restart a pending question becomes "Kohlab restarted before you answered, so Claude stopped here" plus "Ask Claude again". The original question and its options disappear (`chat-asking-desk-dark.png`, `ChatView.tsx:2204`), yet the sidebar and Home still say the project "needs you" (`home-projects-*`). So the person is told they are needed, but the question is gone.
- **Fix:**
  - Keep rendering the stale question (dimmed) above the restart note so the person remembers what was asked, or clear `waiting` when it can no longer be answered.
  - Lead the ready block with what changed in page terms ("Your page changed") and keep file names inside "Changed 2 files ›".

### 18. Miller's Law: good
*About 7±2 items in working memory; chunk content.*
- **Evidence:** every menu except the model menu (13) and the project menu (7, borderline) is ≤5. The palette shows 8 entries in 3 labelled groups.
- **Fix:** the model collapse (item 2).

### 19. Occam's Razor: needs work
*Remove every element that isn't needed.*
- **Evidence:**
  - Preview appears twice on the ready screen: the header button and the ready-block button.
  - "Changes" has a whole tab that repeats the chat's Keep/Undo with a different Undo label (`changes-desk-dark.png`).
  - The empty project still offers Preview and Changes when there is nothing to preview or change (`new-project-chat-desk-dark.png`).
- **Fix:**
  - Hide the header Preview until `index.html` exists (or disable it with "Nothing to preview yet").
  - Hide the Changes segment when the count is 0 for a chat project.

### 20. Paradox of the Active User: good
*People don't read docs, so help must sit in context.*
- **Evidence:**
  - Home's placeholder "Describe it in a sentence or two" and starter chips.
  - The empty-chat subtitle "Claude will ask before changing anything important".
  - One-line descriptions in the mode menu.
  - The composer placeholder "Claude is waiting for your answer above" while asking (`chat-asking-live-desk-dark.png`), which is very good.
- **Fix:** add the same in-context hint to the ready block the first time it appears ("Look at it with Preview, then Keep it or Undo it").

### 21. Pareto Principle: needs work
*Spend effort where most users get most value.*
- **Evidence:** the 80% path is describe → ask → preview → keep. Its weakest links are the ending (no record, toast over Send) and the question card after a restart. Meanwhile 7 of the 13 model entries, two terminal entries and "Download project" serve the rare case.
- **Fix:** prioritise the P0 items below, all on the core path.

### 22. Parkinson's Law: good
*Make tasks take no longer than expected; autofill helps.*
- **Evidence:** a starter chip fills the composer in one tap; Home creates and sends in one step; a Haiku turn finished in 7.9 s. The New project dialog adds a naming step that Home doesn't need.
- **Fix:** the New-project-to-composer change in item 8.

### 23. Peak-End Rule: violated
*Experiences are remembered by their peak and their end.*
- **Evidence:** the peak is the first preview. Today it lives behind a secondary button, and Claude's reply even told the person to "open it in your browser" (`chat-done-live-desk-dark.png`). The **end** is pressing Keep, and what happens then is:
  - the ready block vanishes,
  - **nothing is added to the conversation** (no "Kept" note; Keep emits no event, verified in the transcript file),
  - a 1px-bordered "Saved" toast appears for ~4 s *on top of the Send button* (`keep-150ms-desk-dark.png`, `keep-after-desk-dark.png`, `ChatView.tsx:2074-2085`),
  - Claude's last reply still says "then **Keep this version** if you like it", which is now stale.

  There is no moment of completion and no pointer to sharing.
- **Fix:** on Keep, append a `note` event "Kept this version" (the note style already exists and reads well in `chat-kept-desk-light.png`). Under it, show a quiet line "Show someone: Copy link · Open in a new tab", using the existing share-link logic in `PreviewPanel.tsx:248-256`. Drop the toast for Keep and Undo; the note *is* the feedback. Do the same for Undo ("Undid the changes").

### 24. Postel's Law: good
*Be liberal in what you accept.*
- **Evidence:**
  - Free-text describe, with no format required.
  - Attachments by clip, paste or drop.
  - Typing while Claude works is queued ("Waiting to send"), never refused.
  - Ctrl/Cmd+Enter forces a send.
  - "/" works on phones without the chip.
- **Fix:** none needed.

### 25. Selective Attention: needs work
*Guide attention to what matters; watch for banner and change blindness.*
- **Evidence:**
  - The "needs you" signal on Home is a single muted quiet-button line (`WorkspacesView.tsx:496-502`) that looks like footer text (`home-projects-*`). It mentions only the first project that needs an answer and never ready-to-check work.
  - On phone the sidebar dots are hidden in the drawer, so Home is the *only* signal.
  - Keep's success happens in the bottom-right corner, far from the eye, which is at the ready block (change blindness).
- **Fix:**
  - On Home, show up to two tonal rows (not a muted line): "Birthday RSVP page has a question" and "Lemonade stand is ready to check". Each is a full-width row in the Home column, still no badge.
  - Put feedback where the action was (the note in item 23).

### 26. Serial Position Effect: good
*First and last items are remembered best.*
- **Evidence:** the sidebar puts New project first and Account last; the composer puts attach first and Send last; Delete is last in menus; Home's last chip is "Something else". In the model menu, the first item, "Default (recommended)", is correct.
- **Fix:** none needed.

### 27. Tesler's Law: needs work
*Irreducible complexity must be absorbed by the system, not the user.*
- **Evidence:**
  - The person must choose a model and a permission mode, and must know that "Undo all since last keep" covers several turns.
  - Seven model versions push complexity onto them.
  - The restart case makes the person re-ask instead of the system resuming.
- **Fix:**
  - Default the model sensibly and hide versions (item 2).
  - After a restart, have "Ask Claude again" resend the original question context automatically. It already sends "Please carry on…", so render the old question so the person knows what they are being asked.

### 28. Von Restorff Effect: good (one leak)
*Make the key action distinct, sparingly, and not by colour alone.*
- **Evidence:** exactly one filled primary per view in every capture (Send, Keep, Allow, Create project). Red appears only on Delete. The leak is the toast, a second bordered, shadowed element that competes with the composer at the very moment of completion.
- **Fix:** remove the Keep/Undo toasts (item 23).

### 29. Working Memory: needs work
*Show what's needed; recognition over recall; the system remembers.*
- **Evidence:**
  - After a restart the question text and options are gone (item 17), so the person must recall what Claude asked.
  - Desktop notifications and screen-reader announcements name the project by its **id slug** ("rosie-s-bakery-website-rosie-s-bakery-website finished, ready for review", `useSync.ts:85`), not the name the person typed. The id itself duplicates the slug (`/w/rosie-s-bakery-website-rosie-s-bakery-website`).
- **Fix:**
  - Announce and notify with the project title (as `projectTitle()` does).
  - Make the new id `<slug>` or `<slug>-<n>` instead of `<slug>-<slug>`.

### 30. Zeigarnik Effect: needs work
*Unfinished tasks stick in memory, so make open work visible.*
- **Evidence:**
  - Unfinished work is tracked well (`waiting`, `needs-review` status, dots, tab title "kohlab, 1 ready for review").
  - Coming back later, Home surfaces only the first needs-you project, and ready-to-check work is invisible on Home and on phone.
  - The browser tab title uses "ready for review", a reviewer's phrase, lower-case.
  - The sidebar sorts ready-to-check projects by recency, so a fresh empty project outranks finished work waiting to be kept (`sidebarOrder.ts`, `drawer-phone-dark.png`).
- **Fix:**
  - Home rows for both states (item 25).
  - Title: "Kohlab · 1 ready to check".
  - Rank ready-to-check right after needs-you in `sidebarOrder`, which PRODUCT principle 2 asks for ("questions first, then work ready to check").

## Top 15 improvements, prioritised

| # | P | Improvement | Laws | Effort | Files |
|---|---|---|---|---|---|
| 1 | P0 | **Give Keep a real ending:** append a "Kept this version" note (and "Undid the changes" for Undo), drop the Keep/Undo toasts, and show one quiet "Show someone: Copy link" line under the note | Peak-End, Goal-gradient, Von Restorff, Selective attention | M | `server.ts` (commit/discard handlers emit a `note` via chat.ts), `chat.ts`, `web/src/components/ChatView.tsx:2074-2100`, reuse copy-link from `PreviewPanel.tsx:248` |
| 2 | P0 | **Fix the preview-open header collision:** the title is overlapped by the segmented switch at 1280 px | Aesthetic-usability, Prägnanz | S | `web/src/components/WorkspaceDetail.tsx:668+` |
| 3 | P0 | **Keep the question visible after a restart** (dimmed card above "Kohlab restarted…"), or clear the needs-you dot when it can't be answered | Working memory, Mental model, Zeigarnik | S | `web/src/components/ChatView.tsx:2195-2210`, `chat.ts:1893` (`restoreWaiting`) |
| 4 | P0 | **Preview is primary until previewed, then Keep;** stop nudging people to keep unseen work | Cognitive bias, Peak-End | S | `web/src/components/ChatView.tsx:2377-2398` |
| 5 | P0 | **Remove developer words from the chat-project menu** ("Open terminal", "Continue in Claude's terminal" only when power tools are on) | Cognitive load, Hick, Mental model | S | `web/src/components/WorkspaceDetail.tsx:541-565` |
| 6 | P1 | **Collapse the model menu to 4 plain choices** plus an "Older models" submenu | Choice overload, Hick, Miller, Tesler | M | `web/src/components/ChatView.tsx:1150-1200, 2267+` |
| 7 | P1 | **Home shows both "has a question" and "ready to check"** as tonal rows (max 2), not one muted line | Selective attention, Zeigarnik, Serial position | S | `web/src/components/WorkspacesView.tsx:496-502` |
| 8 | P1 | **"New project" = describe first:** route the sidebar pencil to Home's composer, keep the name dialog for "from a folder/link" only; show starters in empty projects | Flow, Jakob, Parkinson | M | `web/src/components/WorkspacesView.tsx:120-180, 268-300`, `Sidebar.tsx`, `App.tsx:150` |
| 9 | P1 | **Toasts follow DESIGN:** no border, overlay fill + shadow, offset above the composer on desktop | Jakob, Fitts, Von Restorff | S | `web/src/App.tsx:98-110` |
| 10 | P1 | **Prefetch to beat 400 ms:** cache the chat snapshot on sidebar hover/focus (1016 ms today), share the diff fetch between ChatView and DiffView, and add skeleton rows (1288 ms first Changes) | Doherty | M | `web/src/components/Sidebar.tsx`, `ChatView.tsx:2060`, `DiffView.tsx`, `store.ts` |
| 11 | P1 | **One vocabulary:** Keep/Kept, Undo/Undone, "Ready to check" in the tab title and notifications; notify by project title, not id slug | Similarity, Working memory | S | `web/src/App.tsx:76`, `lib/useSync.ts:85-91`, `DiffView.tsx:546`, `ChatView.tsx:2394` |
| 12 | P1 | **Ready block as a tonal card** like the Ask card, with a first-time hint line | Common region, Paradox of active user | S | `web/src/components/ChatView.tsx:2377` |
| 13 | P2 | **Target sizes:** Allow min-width = Don't allow; starter chips 44 px on touch; attach 40 px on desktop; centre the composer in an empty chat | Fitts, Jakob | S | `ChatView.tsx:2220-2235`, `WorkspacesView.tsx:270`, `Composer.tsx`, ChatView empty state |
| 14 | P2 | **Hide what can't be used yet:** header Preview until there is a page, Changes segment when 0 in chat projects; show "Your page" instead of `127.0.0.1:7799/p/…` in the preview bar | Occam, Cognitive load | S | `WorkspaceDetail.tsx`, `PreviewPanel.tsx:200-215` |
| 15 | P2 | **Order and phrasing of turn lines:** "You allowed…" before the tool summary it unlocked; add "Press Preview, never 'open it in your browser'; don't name files unless asked" to the system prompt; rank ready-to-check after needs-you in the sidebar; slug ids not doubled | Chunking, Mental model, Zeigarnik | M | `ChatView.tsx:1610-1625`, `chat.ts:54` (`CHAT_SYSTEM_PROMPT`), `lib/sidebarOrder.ts`, `lib.ts` (workspace id) |
