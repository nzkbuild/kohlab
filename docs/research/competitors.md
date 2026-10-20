# Competitors: chat-to-build tools vs Kohlab (2026-10-20)

Scope: what a non-technical builder sees in each tool, then compared with Kohlab's real code on `feat/conversation-layer` (v2.1.0).

**Where the facts come from, and how far to trust them**
- **Lovable** and **Bolt**: the official help-centre markdown (`docs.lovable.dev/*.md`, `support.bolt.new/*.md`), fetched directly. Bolt's docs include annotated screenshots of the builder. High confidence.
- **Google AI Studio Build**: the official doc (`ai.google.dev/gemini-api/docs/aistudio-build-mode`). High confidence.
- **T3 Code**: its local source (`/root/projects/t3code/docs/user/*.md`, `apps/web/src/components`). High confidence.
- **v0, Replit, Base44, Same, Cursor web, Claude.ai, ChatGPT**: their sites and docs sit behind Vercel, Cloudflare or Google checks, which I did not try to get past. Facts come from search results quoting their docs, their changelogs and third-party reviews. Entries marked "(rep.)" are reported but not checked against the vendor's own docs. Medium confidence.
- **Screenshots** are in `/tmp/comp/` (not committed). Pages that only returned a bot check were deleted. Kept:
  - `bolt-visual-edits-overview.png`: the Bolt builder with Select mode, a style toolbar and a batch of visual edits.
  - `bolt-version-history-button.png`: Bolt's Version history panel.
  - `bolt-publish-menu-security-audit.png`: Bolt's Publish popover.
  - `bolt-home.png`, `base44-home.png`: first-run home screens.
  - `lovable-draft-switcher.png`, `lovable-create-draft.png`: Lovable drafts.
  - `lovable-message-cost.png`: Lovable's per-reply "Worked for / Credits used".
  - `bolt-preview-controls_.png`, `bolt-publish-public.png`, `bolt-restore-chat.png`, `claude-artifacts.png`.

---

## 1. Per-competitor notes

### Lovable (lovable.dev), the closest match
- **Layout**: chat on the left, live preview on the right. The top bar has the project name with a draft switcher, a **History** toggle, and "Hide chat" (Cmd+B). The project toolbar has tabs: Preview · Files · Code · More. The More panel holds Analytics, Cloud (DB, users, storage, secrets, logs), Payments, Security, SEO and Settings. Top right: comments, collaborator avatars, **Share**, **Publish**. Cmd+K opens a palette.
- **First run**: a big prompt box. You can attach files, Figma `.fig` files and screenshots to the first prompt, or start from design templates or "Remix" another project. For open-ended visual work, Lovable first asks question cards about colour, type and layout.
- **Progress**:
  - "Activity cards" for each action. Clicking one opens a **Details view** in place of the preview, with the full timeline of steps and file changes.
  - Big jobs show a task list.
  - Follow-ups sent while it works are picked up at the next stopping point and shown greyed out until then.
- **Review and undo**:
  - Every change is a version. History panel actions: snapshot view, "View code changes", "Go to message in chat", **Revert**, **Bookmark**, and a **Published** badge on the live version.
  - Under each reply: **Undo latest edit** (no confirmation) or **Revert to this version**. "Edit message → Revert and resend".
  - **Drafts** are parallel branches, each with its own chat and preview URL, plus an Accept button (see `lovable-draft-switcher.png`). Status icons per draft: working, idle, question, error.
- **Preview**:
  - Toggle between Desktop, Tablet and Mobile. A page selector also shows social-card and search-result previews.
  - Shift+Refresh restarts the environment. The preview pauses after inactivity ("Still building? → Keep building").
  - **Preview toolbar** (floating, docked bottom-centre, draggable) with four modes: **Select elements (S)**, **Edit text inline (T, free)**, **Draw annotation (D)** and **Comment (C)**.
- **Publish**:
  - A Publish dialog suggests `*.lovable.app` and runs a security scan, then shows the live link. Later changes go out with "Publish changes". You can also say "publish my app" in chat.
  - Custom domains: buy one in-app or connect your own.
  - Build errors block publishing and offer **Try to fix**.
- **Collaboration**: invite with roles, live avatars, comments pinned to elements, preview links (expire after 7 days; password option on Business plans).
- **Integrations**: Lovable Cloud (Postgres, auth, storage, edge functions, secrets, email), Supabase, Stripe and Paddle, two-way GitHub/GitLab sync, connectors (MCP), Figma plugin.
- **Attachments**: up to 10 files per message (images, PDF, Office, audio, zip). You can draw on an attached image. "Take a screenshot" uses screen capture. "Add to chat" works on any image in the conversation. Lovable can generate images.
- **Error recovery**: a **Try to fix** button on the activity card when a build error appears. 10 fixes are free and refill daily. Preview error screens each have **Try again**.
- **Pricing visibility**: a credit bar in the workspace switcher. Each reply's ⋯ menu shows "Worked for 1m 5s / Credits used 1.40" (`lovable-message-cost.png`).
- **Delights**:
  - Bookmark from the activity card.
  - Answers typed into question cards survive a page reload.
  - "Runs after the current task" label.
  - SEO cards that offer "Ask Lovable to edit".

### Bolt.new
- **Layout** (`bolt-visual-edits-overview.png`):
  - Top bar, left to right: logo · workspace · project name · history clock · panel toggle, then a segmented control (Preview / Code `</>` / Database / Publish-plane / Settings).
  - Centre: an address bar with a path field plus reload, open-external, responsive and fullscreen icons.
  - Right: GitHub, help, **Share**, **Publish** (blue primary).
  - Chat on the left. Its composer has `+`, an agent picker ("Standard"), a **Select** cursor icon, **Plan**, a mic, and a round send button.
- **First run** (`bolt-home.png`): "What will you build today?", a prompt box (+, theme picker, Plan, mic, **Build now**), type tiles (Website, Slides, App, Prototype), and "or start from **Figma** · **GitHub** · Team template". Also a template marketplace with Preview / Use template, Google Stitch import, and **Enhance prompt** (asks clarifying questions, then writes a better prompt).
- **Progress**: a checklist streams in the chat ("Create … edge function ✓", "Plan completed").
- **Review and undo** (`bolt-version-history-button.png`):
  - A Version history panel: "Review changes, revert to a version", search, **Bookmarked versions**, and **All versions** as cards (AI title plus date).
  - Click a version to preview it, then "Restore this version" (confirmed). Versions can be renamed and bookmarked.
  - You can also restore from a message in the chat.
- **Preview**: reload, Responsive mode, light/dark/system preview theme, new window, full screen. On mobile, a preview card in the chat after each build.
- **Visual edits** (free until saved):
  - Turn on Select, hover to highlight, and use ↑/↓ to walk to the parent or child element.
  - A floating toolbar (drag grip, colour, alignment, swatches, **Add changes**) shows only the properties that element has. Double-click edits text.
  - Edits collect as a batch card above the composer ("3 visual changes · Save changes"), each shown as "Link · text colour #904375 → #672051". Markers stay on the edited elements.
- **Publish** (`bolt-publish-menu-security-audit.png`): a popover "Publish your project · App is not published yet · Public ▾ · [Run security audit] · [Publish]". Hosted on `*.bolt.host`; Private publishing on paid plans; buy or connect a domain; hosting analytics; Netlify as an alternative host.
- **Collaboration**: roles, real-time co-editing, comments on the preview that can be "sent to Bolt".
- **Integrations**: Bolt Cloud DB (tables, auth, storage, server functions, secrets, logs), Supabase, Stripe, GitHub, Figma, Expo (mobile apps), Google SSO.
- **Error recovery**: the docs mostly say "prompt Bolt"; for a white screen they suggest copying console errors in by hand. A plan-mode "Implement plan" button.
- **Pricing**: tokens. An optional "Display token usage in chat" shows the remaining tokens above the chatbox.
- **Delights**: dictation (hold Ctrl+Shift+D, or right-click and hold), a queue of up to 20 prompts that can be reordered and edited, a security audit inside the Publish menu.

### v0 (v0.app, Vercel)
- **Layout**: chat on the left, Preview/Code on the right. Since the Feb 2026 rebuild it runs in a sandbox with a code editor and a **Git panel** (a branch per chat, open a PR, deploy on merge) (InfoWorld).
- **Visual edits**: **Design mode** (Option+D). Select elements in the preview and adjust them in a design panel or in words. Edits stay pending until **Apply**, which creates a new chat version. June 2026 (rep.) added Layers, a Properties panel and annotations.
- **Versions**: each generation is a numbered version you can switch between. Chats can be forked. Community templates can be forked (rep.).
- **Publish**: "Publish → Publish to Production" (30-60 s), then "Publish Changes". Custom domains from Publish or settings. Vercel hosting.
- **Integrations**: Vercel env vars, Snowflake, AWS DBs, one-click Neon/Supabase/Upstash/Blob (rep.), GitHub import, Figma (Premium).
- **Error recovery**: a "Fix with v0"-style button on preview errors is widely reported but I could not verify it.
- **Pricing**: token-based credits.

### Replit Agent
- **Layout**: an Agent chat panel next to the workspace with Preview (webview), files, shell and a Publish/Deploy tab.
- **Review and undo**: **checkpoints** made automatically at milestones. They snapshot files, conversation, agent memory **and database contents**. The History panel has "Rollback here" and "Changes", and a confirmation lists what will be restored. To revert a published app, roll back and publish again.
- **Visual edits**: an **Element Selector**: select, describe, and the agent finds the component.
- **App Testing**: the agent drives a browser through the app like a user. "Begin take over" lets you click into the testing preview (for example to log in), then hand back. On in Economy/Power modes, off in Lite.
- **Publish**: `*.replit.app` plus a custom domain (Add Domain, DNS records, auto HTTPS) (rep.). Built-in DB, auth, secrets and Stripe (general knowledge, not checked).

### Base44
- **First run** (`base44-home.png`): a prompt box ("I want to build an app where clients check their project"), a **Build ▾** mode picker, a mic, an orange arrow button, and type chips (App · Dashboard · Website · Mobile app · Online store) over a strip of real example apps.
- Builder chat plus Discussion mode, instant visual Edit mode (type, colour, spacing), code view (editing on paid plans), version history with revert (rep.).
- **All-in-one backend** on every plan: database, auth, storage, email, Stripe payments, OAuth connectors, custom OpenAPI integrations. Custom domain on paid tiers.
- **Pricing**: separate pools of *message credits* and *integration credits*. Using the preview is free.

### Google AI Studio, Build mode
- Chat with the live preview on the right and a Code tab.
- **First run**: a prompt box, **AI Chips** to add capabilities (image generation, Maps), speech-to-text, **I'm Feeling Lucky** (generates an idea), an **App Gallery** with "Copy App", import from GitHub.
- **Annotation mode**: highlight part of the UI and describe the change.
- **Deploy** to Cloud Run. Two-way GitHub sync with AI commit messages and a side-by-side **Resolve conflicts** dialog. The `GEMINI_API_KEY` secret stays on the server. It warns before sharing anything that could cost money. No real-time collaboration.

### Claude.ai (artifacts, projects)
- The artifact opens in a side panel next to the chat, with a version switcher per artifact (the arrows go back through edits).
- **Publish** gives a public link; visitors need no account (AI-powered artifacts ask them to sign in). **Remix** copies someone's artifact into your chat. An Artifacts section in the sidebar.
- Projects hold knowledge files and custom instructions shared across chats.
- No hosting, domains, database or element selection.

### ChatGPT (canvas, projects)
- Canvas side panel with version arrows, **Show changes** (additions and deletions), React/HTML rendered in a sandbox, share a canvas, export with the right file extension. Projects have files and instructions.
- No hosting, domains or database.

### T3 Code (local source)
- **Layout**: thread sidebar · chat · a **right panel with tabs: Browser · Terminal · Files · Diff · Device**.
- **Browser panel** (`components/preview/*`):
  - Discovers local servers ("Local servers", "Recently used").
  - Screenshot to clipboard or path; Shift-click to **record** a video.
  - **"Annotate elements, regions, and drawings"**, with a pick tool ("Could not capture the picked element") and a device toolbar for viewport size.
  - Can **float the preview over the chat** as a mini-player, or pop it out to its own window.
  - An agent cursor overlay shows where the agent clicks.
- **Undo**: fork from a response, "Revert changes" / "Revert and keep changes", restore a prompt. Per-turn diffs show only that turn's own work.
- **Other**:
  - Visual replies (sandboxed HTML pages in the thread).
  - MCP apps inside the thread.
  - SnapShots (a hotkey captures a window plus its accessibility text).
  - Dictation-free composer that turns a paste of 32 KiB or more into an attached file.
  - Usage with estimated cost, prompt links, pairing over Tailscale with a QR code, mobile push with Live Activities, an iOS/Android device panel.
- A developer tool: branches and PRs everywhere.

### Cursor (web and mobile agents)
- `cursor.com/agents` is a progressive web app with push notifications. You start agents on a GitHub repo. Each run produces a **PR with videos, screenshots and logs** so the work can be checked without checking out the branch. Slack trigger. "Open in Cursor" for the desktop app. Developer-only: no preview of a running site and no publishing.

### Same.new (rep.)
- Paste a URL and it clones the design (extracts design tokens, writes React + Tailwind). Deploys to a Netlify subdomain, remix, GitHub, download. Neon/Supabase/Clerk.

---

## 2. Feature matrix

Key: **Y** has it · **P** partial · **–** missing · **?** unverified. Kohlab cells cite the code.

| Capability | Lovable | Bolt | v0 | Replit | Base44 | AI Studio | Claude.ai | ChatGPT | T3 Code | Cursor web | **Kohlab** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Chat + live preview side by side | Y | Y | Y | Y | Y | Y | Y (artifact) | Y (canvas) | Y | – | **Y**: `PreviewPanel.tsx`, a real shared Chrome in `browser.ts` |
| Prompt starters / templates | Y templates, remix | Y tiles, marketplace | Y community | Y | Y type chips + gallery | Y gallery, Lucky | Remix | – | – | – | **P**: 3 text chips (`WorkspacesView.tsx:269 STARTERS`), no gallery |
| Import from Figma / screenshot / URL | Y .fig, screenshot | Y Figma, Stitch | Y Figma | ? | – | GitHub | – | – | SnapShots | – | **P**: paste or attach images (`TerminalView.tsx`, `ChatView.tsx:2580`), no Figma or URL clone |
| Clarifying questions before the build | Y design questions | Y Enhance prompt | ? | Y plan | – | – | – | – | Y | – | **P**: "Plan first" mode and question cards (v2.0.0), no "help me describe it" on Home |
| Live progress / step list | Y | Y | Y | Y | Y | Y | – | – | Y | Y | **Y**: working line, checklist, activity summary (`ChatView.tsx`) |
| Send while working / queue | Y | Y (20) | ? | ? | ? | ? | – | – | Y | – | **Y**: "Waiting to send" (`Composer.tsx`, `chat.ts`) |
| Per-message undo / go back | Y | Y | Y | Y | ? | ? | Y | Y | Y | – | **Y**: "Go back to here", "What this changed" (`checkpoints.ts`, `chat.ts:2024`) |
| Version list with restore | Y | Y | Y | Y | Y | – | Y | Y | Y | – | **P**: "Earlier versions" list with "Go back to this one" (`DiffView.tsx:513`, `versions.ts`). Lives inside the Changes tab, no preview of a version, no names or bookmarks |
| Preview a version before restoring | Y snapshot | Y | Y | ? | ? | – | Y | Y | – | – | **–** |
| Keep/accept gate (draft vs main) | Y drafts | – | Y branches | – | – | – | – | – | Y worktrees | Y PR | **Y**: Keep this version / Undo all since last keep, one worktree per project |
| Device size toggle | Y | Y | Y | ? | ? | – | – | – | Y | – | **–**: viewport just follows the pane (`BrowserView.tsx:229`, `browser.ts:181`) |
| Select an element to change | Y | Y | Y | Y | Y | Y annotate | – | – | Y | – | **–**: nothing in `BrowserView.tsx` |
| Direct visual edit (text, colour) without the AI | Y text | Y batch | Y | – | Y | – | – | – | – | – | **–** |
| Draw / annotate on preview or image | Y | – | Y (rep.) | – | – | Y | – | – | Y | – | **–** |
| Agent tests the app in a browser | Y | – | – | Y App Testing | – | – | – | – | Y | Y video | **Y**: the agent and the person share one browser (`browser.ts`, v1.45.0); no "Test it for me" button |
| Errors noticed automatically + "Try to fix" | Y | P | ? | P | ? | – | – | – | – | – | **–**: dev server failure is silent (`devserver.ts:72,106`); the console is readable by the agent only (`browser.ts:247`) |
| Shareable preview link | Y expiring | Y | Y | Y | Y | Y | Y | Y | – | – | **P**: "Copy link" to `/p/<token>/` (`PreviewPanel.tsx:248`, `server.ts:245`). Static files only, live working copy, and only reachable if the server is |
| One-click publish to a public URL | Y | Y | Y | Y | Y | Y Cloud Run | Y | – | – | – | **–** |
| Custom domain | Y | Y | Y | Y | Y | – | – | – | – | – | **–** |
| Built-in database / auth | Y Cloud | Y | Y via Vercel | Y | Y | – | – | – | – | – | **–** (no matches for supabase, stripe or database) |
| Payments (Stripe) | Y | Y | ? | ? | Y | – | – | – | – | – | **–** |
| Secrets / API keys UI | Y | Y | Y | Y | Y | Y | – | – | Y | – | **–**: the dev server gets only `SAFE_ENV_KEYS` (`devserver.ts:15`) |
| GitHub sync | Y two-way | Y | Y | Y | – | Y two-way | – | – | Y | Y | **P**: clone from GitHub (`server.ts:1053`), no sync |
| Project instructions / knowledge | Y | Y skills | ? | ? | ? | – | Y | Y | Y | Y | **–** for chat projects: `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` (`chat.ts:1120`) |
| Collaboration (invite, roles) | Y | Y | P | Y | Y | P | P | Y | P | – | **Y**: invites, owner/member/viewer roles, per-user OS accounts (`lib.ts`) |
| Comments on the preview | Y | Y | – | – | – | – | – | – | – | – | **–** |
| Attachments | Y docs, audio | Y | Y | Y | Y | P | Y | Y | Y | – | **Y**: any file, big paste becomes a file (`lib/attach.ts`, v2.1.0) |
| Usage / cost visibility | Y bar + per reply | Y tokens | Y | Y | Y | Y warns | – | – | Y | – | **P**: Usage dialog and context chip (`UsageDialog.tsx`), no per-reply cost or time |
| Phone experience | Y app | Y | – | Y app | – | – | Y | Y | Y | Y PWA | **Y**: drawer, one-row composer, push (`push.ts`, `PushToggle.tsx`) |
| Push when done | – | – | – | Y | – | – | – | – | Y | Y | **Y**: `push.ts` |
| Visual replies (charts, mockups in chat) | – | – | – | – | – | – | Y | Y | Y | – | **Y**: `picture.ts` |
| Choose / switch AI | – | 2 agents | models | – | – | – | – | – | Y | Y | **Y**: Claude, Hermes, omp, Codex (`acp.ts`, `codex.ts`) |
| Download / export project | Y | Y | Y | Y | ? | Y zip | Y | Y | – | – | **–** for chat projects (no zip route) |
| Dictation | – | Y | – | – | Y | Y | Y | Y | – | – | **–** (phone keyboards dictate already) |
| Security check before publishing | Y | Y | – | – | – | – | – | – | – | – | **–** |
| Self-hosted / own server | – | – | – | – | – | – | – | – | Y | – | **Y**: the whole point |
| Work survives disconnects | Y cloud | Y | Y | Y | Y | Y | Y | Y | Y | Y | **Y**: PTY daemon (`pty-daemon.cjs`) |

**Kohlab's real advantages**:
- self-hosted;
- one browser shared with the agent;
- a keep/undo gate;
- four AIs;
- invited members as real OS accounts;
- sessions that survive restarts;
- push notifications;
- visual replies.

**The gap**: the loop *after* "it works on my preview": seeing it on a phone, pointing at things, fixing errors without words, and **putting it online**.

---

## 3. MUST-HAVE features Kohlab lacks, ranked by value to a non-technical builder ÷ effort

Effort: S = about a day, M = a few days, L = a week or more. The design language follows DESIGN.md: one primary per view, tonal pills, no badges or spinners, plain words.

### 1. "Something's wrong with the page → Fix it" (M, highest value)
**Why**: a beginner can't read a console. Lovable, Bolt and v0 all turn errors into one button.

**How it looks**: when the preview hits a page error, a console error at load, or a dev server that fails to start, one quiet tonal card sits above the composer: "The page has a problem: *Cannot read properties of undefined…*" with **Ask Claude to fix it** (primary), **Show details** (quiet), and dismiss. No red except the word itself. While the AI works the card hides. If a fix is already in flight it says "Sends when Claude finishes", reusing the existing queue.

**Files**:
- `browser.ts`: poll agent-browser `console`/`errors` after each navigation and reload, keeping the last N errors per workspace.
- `devserver.ts`: keep the stderr tail. Turn the silent failure at `:72`/`:106` into a reason.
- `server.ts`: `GET /api/workspaces/:id/problems`, or push it on the sync stream.
- `PreviewPanel.tsx` / `BrowserView.tsx`: replace "Starting the preview…" with "The preview couldn't start" plus **Try again**.
- `ChatView.tsx`: the card, which sends a prefilled message containing the error text.

**Self-hosted constraint**: none. The shared Chrome is already on the box.

### 2. Phone · Tablet · Desktop toggle in Preview (S)
**Why**: "does it work on my phone" is a beginner's first question, and every builder has this.

**How it looks**: a 3-segment icon switch (DeviceMobile, DeviceTablet, Desktop, 16px Phosphor) in the preview toolbar left of ⋯, with `aria-pressed`. Phone sets the viewport to 390×844 and centres it on the `surface-raised` pane with a 16px radius. Desktop keeps today's follow-the-pane behaviour. Remembered per project.

**Files**:
- `PreviewPanel.tsx`: the toggle.
- `BrowserView.tsx`: send a fixed viewport instead of the pane rect, and letterbox. Check that `lib/browserCoords.ts` maps clicks correctly.
- `browser.ts:181`: already supports `viewport`, so no server change.

### 3. "Notes for Claude" per project (S)
**Why**: chat projects run with `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` (`chat.ts:1120`), so there is nowhere to say "my shop is called Bloom, use green, prices in euros". Lovable has Knowledge, Claude.ai and ChatGPT have project instructions, Bolt has skills.

**How it looks**: in the project ⌄ menu, "Notes for Claude…" opens a Dialog with one textarea: "Things Claude should always know about this project". Save is primary.

**Files**:
- `chat.ts`: append to the system prompt for every AI. The ACP/Codex start paths in `acp.ts` and `codex.ts` need the same.
- `server.ts`: a PATCH on the workspace.
- `WorkspaceDetail.tsx` or ChatView header menu, and `CommandPalette.tsx`.

### 4. "Add to chat" picture of the preview, with drawing (S–M)
**Why**: "show, don't describe". Lovable has "Take a screenshot" and drawing on images, AI Studio has annotate, T3 has a screenshot tool.

**How it looks**: in the preview toolbar, a Camera icon button "Add a picture of this page to the message". It attaches a PNG of the current viewport as a composer attachment chip. Clicking the chip opens a Dialog with a simple pen (one colour, undo) and **Done**.

**Files**:
- `browser.ts`: a `screenshot` action. The agent already has it (`:247`); expose it to the person.
- `server.ts`: store it under the uploads path (`lib.ts:1789`).
- `PreviewPanel.tsx`, `Composer.tsx`, and a small canvas annotator in `ui.tsx`-styled Dialog.

### 5. Point at it: select an element to change (M)
**Why**: the single most-copied pattern (Lovable S, Bolt Select, v0 Design mode, Replit Element Selector, T3 pick). It removes "the second button in the third box" prompts.

**How it looks**:
- A cursor icon button in the preview toolbar, "Point at something", or the `S` key.
- While it is on: an outline follows the hovered element (drawn by Kohlab over the streamed frame), ↑/↓ moves to the parent or child (as in Bolt), and a click selects.
- The composer gets a chip, "Heading ‘Watch your progress’ ×" (`ComposerChip`), and the placeholder becomes "What should change here?". Esc cancels.

**Files**:
- `browser.ts`: a new person action `pick {x,y}` that runs `eval` with `document.elementFromPoint`. It returns tag, text, a short selector, the bounding box and a cropped screenshot. Add `highlight` for hover.
- `server.ts` route, plus the audit (like other browser actions).
- `BrowserView.tsx`: the pick-mode overlay.
- `Composer.tsx` / `ChatView.tsx`: the chip becomes context text and image in the message.

**Constraint**: works for any page in the shared browser, including dev-server apps, because the browser is real.

### 6. Put it online: Publish (M for static sites, L for apps; highest absolute value)
**Why**: every builder ends with Publish. Kohlab ends at "Keep this version". Today's "Copy link" (`PreviewPanel.tsx:248`) shows the *working copy*: unfinished edits leak, static files only.

**How it looks**:
- A **Publish** pill in the project header, top right, beside Preview. It is secondary until there is a kept version, then primary.
- A popover like Bolt's: "Publish your site", "Not published yet" / "Live at …", a copy-link row, **Publish** / **Publish changes**, and "Take it offline" (quiet, danger-confirmed).
- It always publishes the **last kept version**, not the working copy, which fits the keep/undo gate.
- A "Published" note appears beside that row in Earlier versions.

**Files**:
- `server.ts`: a public `/s/<slug>/` route that reuses `handlePreview`'s sandbox headers.
- `preview.ts`: resolve from a git tree, not the worktree (`git show <sha>:path` or an exported dir).
- `devserver.ts`: run `npm run build` into an output dir for web apps.
- `lib.ts`: a `published: {sha, slug}` field on the workspace.
- New `PublishMenu` in `WorkspaceDetail.tsx` / `ChatView.tsx`.

**Self-hosted constraint**: a visitor must reach the box.
- On a public VPS, the slug URL works as-is.
- Behind NAT, offer setup help: detect `tailscale funnel` (cli.ts already reads `tailscale serve status`, `cli.ts:350`) or `cloudflared`, and show "To let anyone open it, turn on Tailscale Funnel" with the exact command for the owner.
- Never auto-expose the whole Kohlab: only `/s/*` should be funnelled, so add a separate listener or port for published sites.
- Server-side apps (APIs, databases) are out of scope at first. Say so plainly: "This project needs a server; publishing it is not supported yet."

### 7. Per-reply "Worked for · Plan used" (S)
**Why**: Lovable's ⋯ menu shows "Worked for 1m 5s / Credits used 1.40". It ends "why did my plan run out?".

**How it looks**: two muted rows at the bottom of the existing message ⋯ menu: "Worked for 1 min 5 s" and "Used about 3% of this week". Tabular numbers. Owner only for plan figures, like the Usage dialog.

**Files**: `chat.ts` (stamp turn start/end and the plan meter before and after, from the existing usage read at `:1459`), `ChatView.tsx` (menu rows).

### 8. Better start: richer starters + "Start from a picture" + "Ask me first" (S)
**Why**: Base44 and Bolt show type chips and real examples; Lovable and Bolt ask questions first.

**How it looks**:
- Keep the tonal chips, grow them to about 6 (shop page, RSVP, price calculator, menu, portfolio, booking form).
- A quiet line under them: "Or attach a screenshot of a site you like." This opens Attach.
- A composer toggle on Home only, "Ask me a few questions first", sends with Plan-first mode plus an instruction to ask up to 4 question cards. Both already exist from v2.0.0.

**Files**: `WorkspacesView.tsx` (STARTERS, hint), `Composer.tsx`, `chat.ts` (first-message instruction).

### 9. Keys and passwords for a project (M)
**Why**: needed for any form email, Stripe or API. Every builder has a secrets panel. Today the dev server gets only `SAFE_ENV_KEYS` (`devserver.ts:15`), and the AI has nowhere safe to put a key.

**How it looks**: in the project menu, "Keys and passwords…" opens a Dialog listing name and •••• rows, with Add (Field) and Remove (quiet). Copy: "Claude can use these, but never sees them in the chat." When the AI asks for a key, its question card links here.

**Files**:
- `lib.ts`: store `0600` in the member's private root, never in state.
- `server.ts`: CRUD that is write-only (values never returned).
- `devserver.ts`: inject into the dev-server env.
- `chat.ts`: inject into the run env, with names listed in the prompt.
- `Settings.tsx` patterns.

### 10. Preview a version before going back, and reach it from the header (M)
**Why**: Kohlab has the list (`DiffView.tsx:513`), but it is buried in Changes and is restore-only. Lovable and Bolt let you *look* first and bookmark good ones.

**How it looks**:
- A clock icon button "Earlier versions" in the project header (left of Preview) opens a side sheet like Bolt's panel: a list of "label · time", the current one marked "Now", and a ☆ to keep a favourite at the top.
- Clicking a row shows that version in the Preview pane with a slim top line, "Looking at Tue 4:52 pm", plus **Go back to this one** (primary) and **Back to now** (secondary).

**Files**:
- `versions.ts`: `git worktree add --detach` to a temp dir, or `git archive`.
- `preview.ts` / `server.ts`: `/p/<token>@<sha>/` for static projects.
- `DiffView.tsx`, `WorkspaceDetail.tsx`, `PreviewPanel.tsx`.

**Constraint**: dev-server apps would need a second dev server per looked-at version. Do static projects first.

### 11. "Check it works" button: the agent tests in the shared browser (S)
**Why**: Lovable browser testing, Replit App Testing and Cursor run videos. Kohlab already shares the browser with the agent; it only lacks the one-tap request.

**How it looks**: a secondary pill beside Keep this version, in the Ready-to-check row: **Check it works**. It sends "Open the page, try the main things a visitor would do, and tell me what's broken." The person watches it happen in Preview.

**Files**: `ChatView.tsx` only (a prefilled send). Optionally `chat.ts` for a fixed prompt per AI.

### 12. A preview link that works for every project, with expiry (M)
**Why**: "send it to my friend before it's live". Today `/p/<token>/` serves only static files from the worktree (`preview.ts`). React/Vite projects show nothing useful.

**How it looks**: the existing ⋯ → Copy link, plus "Link stops working after: 1 day / 7 days / never" in the "Make a new link" confirm dialog.

**Files**:
- `server.ts`: proxy `/p/<token>/*` to the workspace's dev server when one runs, keeping the sandbox CSP.
- `lib.ts`: `previewTokenExpires`.
- `PreviewPanel.tsx`.

**Constraint**: same reachability as Publish (#6). A proxied dev server exposes its HMR websocket, so proxy only HTTP plus the HMR path, read-only.

### 13. Make a copy to try an idea (M)
**Why**: Lovable Drafts and Remix, v0 forks, T3 fork. It lets a beginner experiment without fear, beyond Keep/Undo.

**How it looks**: in the project ⌄ menu, "Make a copy…" opens a name field (default "Shop page, copy"). The copy shows up in the sidebar as a normal project. Kohlab's language has no "drafts" or branches, so a copy is just another project.

**Files**: `lib.ts` (a new worktree and branch from the current kept commit, reusing workspace creation), `server.ts`, `Sidebar.tsx` menu, `CommandPalette.tsx`.

### 14. Download my project (S)
**Why**: ownership ("can I take this elsewhere?"). Every hosted tool offers it; it is cheap here.

**How it looks**: project ⌄ menu → "Download as a zip". Gives the last kept version.

**Files**: `server.ts` (`git archive --format=zip <sha>` streamed, read access), `WorkspaceDetail.tsx` menu.

### 15. A place for a small app's data (form answers) (L)
**Why**: the RSVP form in Kohlab's own starter chips has nowhere to send its answers. Lovable Cloud, Bolt Cloud and Base44 all ship a DB. Self-hosted Kohlab can do the simplest honest thing.

**How it looks**: none until an app uses it. Then an "Answers" segment appears in the project switch (Chat · Answers · Changes) as a plain table with Download as CSV. The AI is told: "to save form data, POST JSON to `/s/<slug>/_data/<collection>`".

**Files**:
- `server.ts`: a rate-limited, size-capped append-only JSONL per project collection under the private root.
- `lib.ts`, a new `AnswersView.tsx`, and an instruction in `chat.ts`.

**Constraint**: a public write endpoint on your own box needs a size cap, a rate limit and an owner-only read. It also needs Publish (#6). Supabase/Stripe can wait until Keys (#9) exist; the AI can wire them itself once it has keys.

**Deliberately left out**: custom domains (after Publish; on a VPS it is a reverse-proxy doc, `docs/reverse-proxy.md` exists), real-time comments and presence (small teams), two-way GitHub sync (developer path), dictation (phone keyboards already dictate, and the Web Speech API sends audio to Google, which clashes with self-hosting), direct no-AI visual style editing (Bolt-style toolbar; big, and only worth it after #5), and a security scan before publishing (worth adding inside the Publish popover once #6 exists).

---

## 4. Patterns to adopt for UI polish

1. **A "finished change" card per reply** (Lovable): a title in plain words ("Added the RSVP form") over Details · Preview. Kohlab's "Changed N files" row could lead with the AI's one-line summary instead of a count.
2. **Batch, then save** (Bolt visual edits): pending edits as one card above the composer ("3 changes · Save"), each row "Heading · text ‘A’ → ‘B’". Fits Kohlab's "Waiting to send" card.
3. **Floating preview tools, docked bottom-centre** (Lovable preview toolbar): a small tonal pill inside the preview holding Point · Picture · Phone/Desktop, instead of crowding the address bar. It can be dragged or hidden.
4. **Restart the preview** (Lovable Shift+Refresh, "Keep building"): one ⋯ item, "Restart the preview", for a stuck dev server, and a calm paused state after the 15-minute browser idle close ("Preview is asleep · Wake it up") instead of an empty frame.
5. **Status icons on project rows show *why*** (Lovable draft switcher: working / question / error). Kohlab already has a dot for Needs you and Ready to check; consider a distinct shape (not hue) for "something broke".
6. **Question-card answers survive reload** (Lovable): persist half-answered Ask cards like drafts (`lib/drafts.ts` already exists).
7. **"Runs after the current task"** label on messages that can't join a running turn: clearer than "Waiting to send" for fix requests.
8. **Hover-to-highlight with ↑/↓ to the parent** when pointing (Bolt): cheap, and it makes element selection forgiving.
9. **Agent cursor in the preview** (T3 `AgentBrowserCursor`): show where the AI is clicking in the shared browser. It turns "is it doing anything?" into something you can see, with no spinner (DESIGN.md-compatible).
10. **Social and search card preview** (Lovable page selector): once Publish exists, a "How it looks when shared" card with "Ask Claude to change it".
11. **Mobile: a preview card in the chat after each build** (Bolt mobile): on phones, a tappable thumbnail card instead of hunting for the Preview button.
12. **Clear plan-cost language** (AI Studio warns before costs; Base44 says previewing is free): add one line in the Usage dialog, "Looking at the preview never uses your plan."

Sources: docs.lovable.dev (editor, chat, preview, history, publish, security-view, credits); support.bolt.new (start-project, visual-edits, preview-controls, chat-tools, rollback-backup, hosting/publish, preview-issues, quickstart); ai.google.dev/gemini-api/docs/aistudio-build-mode; v0.app/docs/design-mode (via search); InfoWorld on the new v0; docs.replit.com checkpoints-and-rollbacks / element-selector / app-testing (via search); Base44 reviews (zite.com, hackceleration.com); support.claude.com publish-and-share-artifacts; help.openai.com canvas; docs.cursor.com web-and-mobile; Same.new reviews (knowara, everydev); local T3 Code source.
