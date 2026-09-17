# Accessibility & Platform Baseline for Kohlab — September 2026

Constraints on a dark-only, dense, keyboard-driven agent-monitoring UI (terminals, log tails, file tree, tabbed workspace, command palette). Sources: W3C/WAI, WHATWG, MDN only. Labels: **[NORMATIVE]** = W3C Recommendation, creates conformance requirements; **[INFORMATIVE]** = W3C supporting doc, explains but does not require; **[DRAFT]** = unfinished, not a conformance target; **[VENDOR-DOC]** = MDN/WHATWG platform behaviour, not a WCAG requirement.

## 1. WCAG status in 2026

**Current normative version: WCAG 2.2.** Published 5 October 2023; updated 12 December 2024. Latest: <https://www.w3.org/TR/WCAG22/>; frozen dated version <https://www.w3.org/TR/2024/REC-WCAG22-20241212/>. Source: <https://www.w3.org/WAI/standards-guidelines/wcag/>.

- 2.2 does not deprecate 2.1: "WCAG 2.2 does not deprecate or supersede WCAG 2.1, and WCAG 2.1 does not deprecate or supersede WCAG 2.0." Content meeting 2.2 meets 2.1 and 2.0.
- WCAG 2.2 = ISO/IEC 40500:2025, identical to the Oct 2023 text. **EN 301 549 still uses WCAG 2.1.**
- **No WCAG 2.3 will exist**: "The Accessibility Guidelines Working Group (AG WG) is not planning to do another version of WCAG 2, that is, not do WCAG 2.3." <https://www.w3.org/WAI/standards-guidelines/wcag/faq/>
- Only the standard is normative: "**Only the WCAG technical standard includes requirements**… The supporting materials are informative; they are not normative"; the Techniques and Understanding docs "do not set or change requirements for WCAG" and "are not required for conformance". <https://www.w3.org/WAI/standards-guidelines/wcag/faq/> — *Techniques for WCAG 2* is not a checklist; the success criteria are.

**The 9 criteria added in 2.2.** "WCAG 2.2 provides 9 additional success criteria since WCAG 2.1… with one exception: **4.1.1 Parsing is obsolete and removed** from WCAG 2.2." <https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/>

| SC | Name | Level | SC | Name | Level |
|---|---|---|---|---|---|
| 2.4.11 | Focus Not Obscured (Minimum) | AA | 2.5.8 | Target Size (Minimum) | AA |
| 2.4.12 | Focus Not Obscured (Enhanced) | AAA | 3.2.6 | Consistent Help | A |
| 2.4.13 | Focus Appearance | AAA | 3.3.7 | Redundant Entry | A |
| 2.5.7 | Dragging Movements | AA | 3.3.8 | Accessible Authentication (Minimum) | AA |
|  |  |  | 3.3.9 | Accessible Authentication (Enhanced) | AAA |

Which bite a dense dark developer UI, in order: **2.5.8** (icon-only toolbars, 28px sidebar buttons), **2.4.11** (sticky headers/footers and non-modal overlays over a focused row — it names this failure mode explicitly), **2.5.7** (drag-to-reorder panes/tabs, drag-to-resize splits), **3.3.7** (re-asking for a repo/agent path), **3.3.8** (only if a login ships). 2.4.12/2.4.13/3.3.9 are AAA — design guidance, not an AA obligation.

**WCAG 3.0 is not a conformance target.** Current publication is a **Working Draft dated 10 September 2026** (<https://www.w3.org/TR/2026/WD-wcag-3.0-20260910/>, `specStatus: WD`) — not a Candidate Recommendation, not a Recommendation. Its own Status of This Document: "Publication as a Working Draft **does not imply endorsement** by W3C and its Members… This is a draft document and may be updated, replaced, or obsoleted by other documents at any time. **It is inappropriate to cite this document as other than a work in progress.**" <https://www.w3.org/TR/wcag-3.0/>

Only *Developing*-stage requirements appear in the WD; the maturity ladder is Placeholder → Exploratory → Developing → Refining → Mature. W3C's own text: "WCAG 3 is currently an **incomplete draft that will change**… The final requirements in WCAG 3 will be different from this draft. Guidelines and requirements will be edited, added, combined, and removed. The conformance model will be refined." <https://www.w3.org/WAI/standards-guidelines/wcag/wcag3-intro/> It adds: "**WCAG 3 is years away from being completed**" and "**The best way to prepare for WCAG 3 in the future, is to meet WCAG 2.2 success criteria now.**" (<https://www.w3.org/WAI/standards-guidelines/wcag/faq/>, same intro page). Its conformance model is itself still being redesigned (tags + tiers replacing A/AA/AAA) and is open for comment. **Target WCAG 2.2 Level AA.**

## 2. Contrast

### WCAG 2.x — the only conformance-relevant measure

- **1.4.3 Contrast (Minimum), AA** — <https://www.w3.org/TR/WCAG22/#contrast-minimum>: text and images of text "has a contrast ratio of at least 4.5:1, except… **Large Text** — Large-scale text and images of large-scale text have a contrast ratio of at least 3:1; **Incidental** — Text or images of text that are part of an inactive user interface component, that are pure decoration, that are not visible to anyone, or that are part of a picture that contains significant other visual content, have no contrast requirement. **Logotypes** — Text that is part of a logo or brand name has no contrast requirement."
- **1.4.6 Contrast (Enhanced), AAA**: 7:1 normal, 4.5:1 large.
- **1.4.11 Non-text Contrast, AA** — <https://www.w3.org/TR/WCAG22/#non-text-contrast>: "The visual presentation of the following have a contrast ratio of at least 3:1 against adjacent color(s): **User Interface Components** — Visual information required to identify user interface components and states, except for inactive components or where the appearance of the component is determined by the user agent and not modified by the author; **Graphical Objects** — Parts of graphics required to understand the content, except when a particular presentation of graphics is essential to the information being conveyed."
- **"Large text" = large scale (text)**: "with at least **18 point or 14 point bold**" <https://www.w3.org/TR/WCAG22/#dfn-large-scale>. Understanding converts: "the ratio between sizes in points and CSS pixels is **1pt = 1.333px**, therefore 14pt and 18pt are equivalent to approximately **18.5px and 24px**." <https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html>
- Thresholds are **not rounded**: "the computed values should not be rounded (e.g., **4.499:1 would not meet the 4.5:1** threshold)"; for 1.4.11, "**2.999:1 would not meet the 3:1** threshold." <https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html>, <https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html>
- Formulas (normative glossary): "**(L1 + 0.05) / (L2 + 0.05)**, where L1 is the relative luminance of the lighter of the colors, and L2 is the relative luminance of the darker of the colors" (<https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio>); "L = 0.2126 * R + 0.7152 * G + 0.0722 * B where R, G and B are defined as: if RsRGB <= 0.04045 then R = RsRGB/12.92 else R = ((RsRGB+0.055)/1.055) ^ 2.4", with "RsRGB = R8bit/255" (<https://www.w3.org/TR/WCAG22/#dfn-relative-luminance>).
- 1.4.11 does not require a visible boundary where content already identifies the control, but the focus indicator is still covered: "Even when a control does not need to have a visual boundary indicating its hit area, it will still need to have a sufficiently contrasting focus indication." <https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html>

### APCA — real, but not normative anywhere

**APCA is named in no W3C Recommendation, Candidate Recommendation, or Working Draft.** Verified by direct retrieval: the string "APCA" occurs **0 times** in <https://www.w3.org/TR/WCAG22/>, **0 times** in <https://www.w3.org/TR/WCAG21/>, **0 times** in <https://www.w3.org/TR/wcag-3.0/> (the 10 Sep 2026 WD), and 0 times in the Understanding pages for contrast-minimum, non-text-contrast, target-size-minimum, focus-appearance, and focus-not-obscured-minimum.

- The WCAG 3.0 draft's contrast requirement is explicitly unfinished: "The default visual presentation of text meets **@@[contrast measure to be determined]**", with the editor's note "**The contrast algorithm used in WCAG 3 is yet to be determined.** For this draft, the requirement assumes the algorithm will include a size/weight factor." <https://www.w3.org/TR/wcag-3.0/> (§2.2.1.3, §2.2.1.10)
- APCA's documentation is the algorithm author's, not W3C's, and disclaims itself: it describes APCA as "**the candidate for WCAG 3**… still in development" and closes "**NOTICE: Personal opinions expressed are the author's and may or may not reflect those of the W3 or AGWG.**" <https://git.apcacontrast.com/documentation/APCAeasyIntro>
- APCA's proposed thresholds (Lc scale, Arial/Helvetica reference): **Lc 75** minimum body text (≥18px/400); Lc 90 preferred body (≥14px/400); **Lc 60** content text (≥24px/400 or 16px/700); Lc 45 large/heavy text and fine-detail pictograms; Lc 30 absolute minimum text; **Lc 15** absolute minimum non-text. "For AAA, simply increase the contrast values by Lc 15." Same source.
- **Contested — do not pick a side silently.** APCA's author asserts WCAG 2.x "far overstates contrast for dark colors" and that "The WCAG 4.5:1 ratio can be functionally unreadable when a color is near black", arguing 2.x "cannot provide useful guidance when designing dark mode" (same source). W3C has not adopted this; the 2.x formulas remain the only published conformance measure. Treat the dark-mode criticism as a design argument worth heeding and the 2.x ratio as the audit requirement.

**What to use today:** (1) WCAG 2.x ratios for conformance and CI gates — the only measurement supporting a conformance, procurement, or legal statement; (2) APCA Lc as a design-time check for dark surfaces, where the 2.x weakness shows — practical combination: pass 4.5:1 / 3:1 **and** land at Lc ≥ 75 for body text, preferring the stricter demand where they disagree; (3) never put an APCA number in a conformance claim.

## 3. Target size and focus criteria

**Naming correction:** 2.4.11 is **Focus Not Obscured (Minimum)**, not a focus-*appearance* criterion; focus appearance is 2.4.13 (AAA). Only 2.4.11 is AA.

### 2.5.8 Target Size (Minimum) — AA

> The size of the target for pointer inputs is at least **24 by 24 CSS pixels**, except when: **Spacing** — Undersized targets (those less than 24 by 24 CSS pixels) are positioned so that if a **24 CSS pixel diameter circle** is centered on the bounding box of each, the circles do not intersect another target or the circle for another undersized target; **Equivalent** — The function can be achieved through a different control on the same page that meets this criterion; **Inline** — The target is in a sentence or its size is otherwise constrained by the line-height of non-target text; **User agent control** — The size of the target is determined by the user agent and is not modified by the author; **Essential** — A particular presentation of the target is essential or is legally required for the information being conveyed.
> <https://www.w3.org/TR/WCAG22/#target-size-minimum>

- Test method: "For a target to be 'at least 24 by 24 CSS pixels', it must be conceptually possible to draw a solid 24 by 24 CSS pixel square, **aligned to the horizontal and vertical axis**, such that the square is completely within the target." <https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html>
- **28px icon-only sidebar buttons pass 2.5.8**: 28 ≥ 24 on both axes, so neither the size test nor the Spacing exception is engaged. This is a hard, checkable pass.
- Spacing is a **centre-to-centre** test, not a gap test: 24px-diameter circles (radius 12) centred on each undersized target must not intersect, i.e. centre-to-centre ≥ 24px. Only if buttons shrink below 24px does this exception become load-bearing.
- 28px is below the **AAA** bar: **2.5.5 Target Size (Enhanced)** requires "at least **44 by 44 CSS pixels**" (<https://www.w3.org/TR/WCAG22/#target-size-enhanced>) — 44×44 is also what touch ergonomics wants, so mobile layouts should grow targets rather than rely on the AA floor.
- Where a target cannot be grown, the **Equivalent** exception wants *another control on the same page* achieving the function at ≥24×24. A palette command is not a pointer control; a visible ≥24px equivalent is.

### 2.4.11 Focus Not Obscured (Minimum) — AA

> When a user interface component receives keyboard focus, the component is **not entirely hidden** due to author-created content.
> <https://www.w3.org/TR/WCAG22/#focus-not-obscured-minimum>

The Understanding doc names Kohlab's exact failure mode: "Typical types of content that can overlap focused items are **sticky footers, sticky headers, and non-modal dialogs**. As a user tabs through the page, these layers of content can obscure the item receiving focus, along with its focus indicator." It adds that the check excludes the indicator itself: "The component itself does not include the focus indicator when checking that 'the component is not entirely hidden'". <https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html>

### 2.4.13 Focus Appearance — AAA

> When the keyboard focus indicator is visible, an area of the focus indicator meets all the following: is at least as large as the area of a **2 CSS pixel thick perimeter** of the unfocused component or sub-component, and has a **contrast ratio of at least 3:1** between the same pixels in the focused and unfocused states. Exceptions: The focus indicator is determined by the user agent and cannot be adjusted by the author, or the focus indicator and the indicator's background color are not modified by the author.
> <https://www.w3.org/TR/WCAG22/#focus-appearance>

- **perimeter** (new in 2.2): "continuous line forming the boundary of a shape **not including shared pixels, or the minimum bounding box, whichever is shortest**." Example: "4h+4w, where h is the height and w is the width" for a rectangle; "4𝜋r" for a circle. <https://www.w3.org/TR/WCAG22/#dfn-perimeter>
- It is a minimum *area*, not a shape mandate: "This only specifies a minimum area for the focus indicator. It does not require that the focus indicator literally be a 2 CSS pixel thick outline." <https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html>
- The AA obligation is **2.4.7 Focus Visible** — "Any keyboard operable user interface has a mode of operation where the keyboard focus indicator is visible" (<https://www.w3.org/TR/WCAG22/#focus-visible>) — plus 1.4.11's 3:1 for the indicator. Meeting 2.4.13's area + contrast rule is the safe way to satisfy both on a dark palette.
- For a 28px icon button, a **2px outline offset outside** the button is the cheapest way to clear the 2px-perimeter rule; an inset indicator does not.

## 4. APG patterns vs native HTML

### Status of the APG

**ARIA 1.2 is a W3C Recommendation (06 June 2023)** — that is the normative source (<https://www.w3.org/TR/wai-aria-1.2/>). The APG is **informative** and self-describes as illustrating the spec: "Because the purpose of this guide is to **illustrate appropriate use of ARIA 1.2 as defined in the ARIA specification**…" (<https://www.w3.org/WAI/ARIA/apg/practices/read-me-first/>). Two APG rules govern every custom widget:

> **No ARIA is better than Bad ARIA.** Incorrect ARIA misrepresents visual experiences, with potentially devastating effects on their corresponding non-visual experiences. Unlike HTML input elements, **ARIA roles do not cause browsers to provide keyboard behaviors or styling**. <https://www.w3.org/WAI/ARIA/apg/practices/read-me-first/>

> Unlike native HTML form elements, **browsers do not provide keyboard support** for graphical user interface (GUI) components that are made accessible with ARIA; **authors have to provide the keyboard support in their code**. <https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/>

The APG does not cover touch: "Currently, this guide does not indicate which examples are compatible with mobile browsers or touch interfaces… there is not yet a standardized approach for providing touch interactions that work across mobile browsers." <https://www.w3.org/WAI/ARIA/apg/practices/read-me-first/>

### Combobox / listbox — command palette

<https://www.w3.org/WAI/ARIA/apg/patterns/combobox/>

- Input `role="combobox"`; popup is `listbox` (or `grid`/`tree`/`dialog`); `aria-controls` → popup; `aria-expanded` false/true; `aria-autocomplete` = `none|list|both`; `aria-selected="true"` on the visually selected option.
- **DOM focus stays on the combobox**: "When a descendant of a listbox, grid, or tree popup is focused, **DOM focus remains on the combobox** and the combobox has `aria-activedescendant` set to a value that refers to the focused element within the popup." This is the most commonly botched part of a hand-rolled palette.
- `aria-activedescendant` has hard DOM requirements — critical under React portals: "One of the following three conditions must be met. 1. The element referenced as active is a DOM descendant of the focused referencing element. 2. The focused referencing element has a value specified for `aria-owns`… 3. The focused referencing element has role of `combobox`, `textbox`, or `searchbox` and has `aria-controls` property referring to an element with a role that supports `aria-activedescendant`…" <https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/>
- Keys: `Down Arrow` (into popup), `Escape` (dismiss), `Enter` (accept), printable characters (filter); listbox popup adds `Up Arrow`, optionally `Home`/`End`/`Backspace`/`Delete`. The popup and its descendants stay out of the page `Tab` sequence.
- Do not intercept text editing: "**IMPORTANT:** Ensure JavaScript does not interfere with browser-provided text editing functions by capturing key events for the keys used to perform them." (combobox page)
- A listbox is not a list of controls: "…it does not provide an accessible way to present a list of interactive elements, such as links, buttons, or checkboxes." <https://www.w3.org/WAI/ARIA/apg/patterns/listbox/>

### Tablist — tabbed workspace views

<https://www.w3.org/WAI/ARIA/apg/patterns/tabs/>

- `tablist` / `tab` / `tabpanel`; `aria-selected="true"` only on the active tab; `tab` → `aria-controls` → panel; `tabpanel` → `aria-labelledby` → tab; the tablist has a visible label or `aria-label`.
- Roving focus among tabs: `Left`/`Right Arrow` (wrapping), `Space`/`Enter` when activation is manual, optionally `Home`/`End`, optionally `Delete` for closable tabs, `Shift`+`F10` for a tab context menu.
- **The trap for a horizontal tab strip:** "If the tab list is horizontal, it does not listen for `Down Arrow` or `Up Arrow` so those keys can provide their normal browser scrolling functions even when focus is inside the tab list."
- Auto-activation only if panels are cheap: "It is recommended that tabs activate automatically when they receive focus **as long as their associated tab panels are displayed without noticeable latency**." Kohlab tabs mount terminals/editors, so this argues for **manual activation** or preloaded panels.
- "When the tabpanel does not contain any focusable elements or the first element with content is not focusable, the tabpanel should set `tabindex="0"` to include it in the tab sequence of the page."

### Dialog — modal confirm

<https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>

- Container `role="dialog"`, `aria-modal="true"`, `aria-labelledby` → visible title, optionally `aria-describedby` (omit it when the content has semantic structure that must be navigated).
- Focus moves inside on open; `Tab`/`Shift`+`Tab` cycle **within** the dialog ("modal dialogs contain their tab sequence"); `Escape` closes. Restoration: "When a dialog closes, **focus returns to the element that invoked the dialog**" unless the invoker no longer exists.
- `aria-modal` is conditional and getting it wrong is severe: "mark a dialog modal **only when both:** 1. Application code prevents all users from interacting in any way with content outside of it. 2. Visual styling obscures the content outside of it."
- "It is strongly recommended that the tab sequence of all dialogs include a visible element with `role="button"` that closes the dialog."

### Disclosure — collapsible nodes, panels, tool blocks

<https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/> — `role="button"` + `aria-expanded` true/false; `Enter` and `Space` toggle. That is the entire requirement, so a native `<button aria-expanded>` (or `<details>`/`<summary>`) satisfies it with no custom key handling.

### Tree view — the file tree

<https://www.w3.org/WAI/ARIA/apg/patterns/treeview/>

- `tree` / `treeitem` / `group`; `aria-expanded` **only on parent nodes** — "End nodes do not have the `aria-expanded` attribute because, if they were to have it, they would be incorrectly described to assistive technologies as parent nodes"; indicate selection with `aria-selected` or `aria-checked`, never both.
- Lazy loading: "If the complete set of available nodes is not present in the DOM due to dynamic loading as the user moves focus in or scrolls the tree, each node has `aria-level`, `aria-setsize`, and `aria-posinset` specified." A virtualised file tree must emit these.
- Keys: `Right` (open / into first child), `Left` (close / to parent), `Up`/`Down` (without opening or closing a node), `Home`/`End`, `Enter`, type-ahead ("recommended for all trees, especially for trees with more than 7 root nodes"), optionally `*`.
- Focus is distinct from selection: "The visual focus indicator must always be visible. The selected state must be visually distinct from the focus indicator." <https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/>

### Prefer native `<dialog>` and popover

- **Modal — use `<dialog>` + `showModal()`.** WHATWG: it "displays in the top layer, along with a `::backdrop` pseudo-element. Interaction outside the dialog is blocked and the content outside it is rendered inert"; spec-level blocking: "While *document* is so blocked, every node that is connected to *document*, with the exception of the *subject* element and its flat tree descendants, must become inert." <https://html.spec.whatwg.org/multipage/interactive-elements.html>
- MDN: `<dialog>` opened with `showModal()` "**implicitly** have `aria-modal="true"`"; a modal dialog dismisses on `Escape` by default and a non-modal one does not; "When multiple modal dialogs are open, pressing the Esc key should close only the last shown dialog. When using `<dialog>`, this behavior is provided by the browser." Focus: "focus is set on the first nested focusable element. Explicitly indicating the initial focus placement by using the `autofocus` attribute will help ensure initial focus is set on the element deemed the best initial focus placement." Spec prohibition: "**The `tabindex` attribute must not be specified on `<dialog>` elements.**" <https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog>, <https://html.spec.whatwg.org/multipage/interactive-elements.html>
- **Verdict:** a hand-rolled `aria-modal` div duplicates the top layer, backdrop, inertness, focus trap, `Escape` handling, and `aria-modal` wiring — and typically gets the conditional-modal rule wrong. Use `<dialog>`.
- **Non-modal** panels (peek inspectors, non-trapping menus): use the Popover API. "**Popovers created using the Popover API are always non-modal.** If you want to create a modal popover, a `<dialog>` element is the right way to go." `popover="auto"` = light dismiss + closes other autos; `popover="manual"` = "cannot be 'light dismissed' and are not automatically closed"; `popover="hint"` closes hints but not autos. Popovers enter the top layer, unaffected by ancestor `overflow`/`position`. <https://developer.mozilla.org/en-US/docs/Web/API/Popover_API>, <https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/popover>
- **Inertness** for hand-managed layers: "An inert element, along with its descendants, gets removed from the **tab order and accessibility tree**" — but it is not a modal trap. <https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inert>
- **Rule of thumb:** `<dialog>` for confirm/blocking; `popover` for dismissible non-modal chrome; native `<button aria-expanded>` for disclosure; `listbox`/`tree` roles only where no native element exists.

## 5. Live regions and streaming output

### The contract

- `aria-live` values `off` (**default**), `polite`, `assertive`. "When set to `assertive`, assistive technologies immediately notify the user, **potentially clearing the speech queue** of previous updates." And: "**Warning:** … **don't use the `assertive` value unless the interruption is imperative.**" <https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-live>
- The region must exist before it is updated: "Start with an empty live region, then allow time for it to be exposed to assistive technologies before updating its content. If you establish the region with JavaScript… **defer the content update to a later event-loop task**, for example using `setTimeout()`… The most reliable way to ensure that live regions are registered is to include them in the initial markup." <https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/Live_regions>
- `aria-atomic` default **`false`** ("present only the changed node or nodes"); `aria-relevant` default **`additions text`**, because "generally text modifications and node additions are relevant, but node removals are not". "The values of `removals` and `all` should be used sparingly… Assistive technologies only need to be informed of content removal when its removal represents an important change." <https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-atomic>, <https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-relevant>
- `aria-busy="true"` while a multi-part update assembles: "This prevents assistive technologies from announcing changes before updates are done." <https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-busy>
- Role shortcuts: `role="log"` has implicit `aria-live` **polite** and implicit `aria-atomic` **false**, and "a log is sequentially ordered and new information is only added to the end of the log" (<https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/log_role>). `role="status"` has implicit polite + `aria-atomic="true"`, and "**Do not give focus to the status when its content updates.**" (<https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/status_role>). `role="alert"` is "equivalent to setting `aria-live="assertive"` and `aria-atomic="true"`" and "**must be used sparingly**" (<https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/alert_role>).
- AA obligation: **4.1.3 Status Messages** — "status messages can be programmatically determined through role or properties such that they can be presented to the user by assistive technologies **without receiving focus**." <https://www.w3.org/TR/WCAG22/#status-messages>

### The terminal / log-tail problem

MDN states the governing pattern for continuously-updating widgets: "**you likely do not want to inform the user every time it updates**, but do want to inform them the widget *does* get updated. Here, you would set `aria-live="off"`. In these scenarios **there is no reason to inform the user of updates unless they are focused on the live region**." <https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-live>

- **2.2.2 Pause, Stop, Hide (A)** covers an auto-scrolling tail: for "auto-updating information that (1) starts automatically and (2) is presented in parallel with other content, there is a mechanism for the user to **pause, stop, or hide it or to control the frequency of the update**"; likewise for moving/blinking/scrolling information that "starts automatically, lasts more than five seconds, and is presented in parallel with other content". <https://www.w3.org/TR/WCAG22/#pause-stop-hide>
- Live regions are a lossy channel: "Live regions are typically announced as plain text, so links, buttons, and other semantics in the updated content may not be conveyed in the announcement itself." <https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/Live_regions>
- **Recommended pattern.** (1) The terminal/log scrollback carries **no** live region — default `aria-live="off"`, remaining ordinary focusable content an AT user reads deliberately. (2) One small, **permanently-present** announcer (`role="status"`, or `aria-live="polite"` + `aria-atomic="true"`) carries *discrete coalesced state transitions* — "build-7 finished", "lint-3 failed: 2 errors", "3 agents blocked" — never raw output lines. (3) **Coalesce and throttle**: at most one announcement per state change, with a minimum interval between announcements. (4) Ship an explicit **pause announcements** control; that is the 2.2.2 mechanism and the only humane way to survive a noisy agent. (5) Set `aria-busy="true"` on the announcer while a burst assembles and `false` when settled, so AT does not narrate fragments. (6) Reserve `assertive`/`role="alert"` for genuine failure of the watched process.
- **Forward-looking, not usable yet:** `Document.ariaNotify()` offers real advantages — "Live region announcements involve reading out the updated content of the changed DOM node, whereas `ariaNotify()` announcement content can be defined independently of DOM content" — but MDN flags availability: "**This feature is not Baseline because it does not work in some of the most widely-used browsers.**" <https://developer.mozilla.org/en-US/docs/Web/API/Document/ariaNotify> Feature-detect it; keep live regions as the fallback.

## 6. Motion

- **2.3.3 Animation from Interactions — AAA**: "Motion animation triggered by interaction can be disabled, unless the animation is essential to the functionality or the information being conveyed." <https://www.w3.org/TR/WCAG22/#animation-from-interactions> **No AA criterion requires honouring `prefers-reduced-motion`**; it remains the platform contract and should be honoured unconditionally.
- **2.2.2 Pause, Stop, Hide — A** is the AA-level motion-adjacent requirement (§5).
- `prefers-reduced-motion` "is used to detect if a user has enabled a setting on their device to **minimize the amount of non-essential motion**… Such animations can trigger discomfort for those with vestibular motion disorders. **Animations such as scaling or panning large objects can be vestibular motion triggers.**" Values are `no-preference` (evaluates false) and `reduce`, where `@media (prefers-reduced-motion)` ≡ `reduce`. <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion> MDN's example *tones down* animation; for a developer tool, removing non-essential motion entirely (keeping only opacity fades) is the safer default.
- `prefers-reduced-transparency` is **limited availability, not Baseline**: MDN carries an Experimental banner — "Check the Browser compatibility table carefully before using this in production." <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-transparency>
- MDN's `scroll-behavior` page documents **no** `prefers-reduced-motion` interaction, and "User agents are allowed to ignore this property." <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scroll-behavior> So `scroll-behavior: smooth` is not a reduced-motion-safe way to auto-scroll a log tail.

## 7. Keyboard

### Requirements that apply

| SC | Level | Requirement (verbatim) |
|---|---|---|
| 2.1.1 Keyboard | A | "All functionality of the content is operable through a keyboard interface without requiring specific timings for individual keystrokes" |
| 2.1.2 No Keyboard Trap | A | "focus can be moved away from that component using only a keyboard interface" |
| 2.4.1 Bypass Blocks | A | "A mechanism is available to bypass blocks of content that are repeated on multiple web pages." |
| 2.4.3 Focus Order | A | focus "in an order that preserves meaning and operability" |
| 2.4.7 Focus Visible | AA | "the keyboard focus indicator is visible" |
| 2.4.11 Focus Not Obscured (Minimum) | AA | not entirely hidden by author content |
| 2.5.7 Dragging Movements | AA | dragging needs a non-dragging single-pointer equivalent |

<https://www.w3.org/TR/WCAG22/#keyboard>, <https://www.w3.org/TR/WCAG22/#no-keyboard-trap>, <https://www.w3.org/TR/WCAG22/#bypass-blocks>, <https://www.w3.org/TR/WCAG22/#focus-order>, <https://www.w3.org/TR/WCAG22/#focus-visible>, <https://www.w3.org/TR/WCAG22/#dragging-movements>

Glossary: **dragging movement** — "an operation where the pointer engages with an element on the down-event and the element (or a representation of its position) follows the pointer until an up-event"; **single pointer** — "an input modality that only targets a single point on the page/screen at a time – such as a mouse, single finger on a touch screen, or stylus." <https://www.w3.org/TR/WCAG22/#dfn-dragging-movements>, <https://www.w3.org/TR/WCAG22/#dfn-single-pointer>

### Focus management for overlays

- **On open**, move focus into the overlay (APG modal dialog; `<dialog showModal()` does this and honours `autofocus`). **Trap within** a modal: "`Tab` and `Shift` + `Tab` do not move focus outside the dialog" — free with native `<dialog>`, hand-written otherwise.
- **`Escape` closes**; with nested dialogs "pressing the Esc key should close only the last shown dialog. When using `<dialog>`, this behavior is provided by the browser."
- **On close, restore**: "focus returns to the element that invoked the dialog unless… The invoking element no longer exists. Then, focus is set on another element that provides logical work flow." A React unmount can destroy the invoker, so keep an explicit fallback target rather than letting focus fall to `<body>`.
- Non-modal overlays (popover, peek panel) must **not** trap: mark them non-modal, and apply `inert` to background chrome only when it is genuinely unavailable.

### Roving tabindex vs `aria-activedescendant`

- **Roving tabindex** — for tab strips, toolbars, DOM-focus trees, settings rows: "the element that is to be included in the tab sequence has `tabindex="0"` and **all other focusable elements contained in the composite have `tabindex="-1"`**." On arrow navigation set `-1` on the old element, `0` on the new, then call `element.focus()`. Documented advantage: "the user agent will **scroll the newly focused element into view**." <https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/>
- **`aria-activedescendant`** — for combobox popups, listbox, tree, grid (§4): "only the container element needs to be included in the tab sequence"; on change, "assistive technologies will receive focus change events equivalent to those received when DOM focus actually moves." Requires one of the three DOM-relationship conditions — the failure mode for a portaled command palette.
- One tab stop per composite: "the tab sequence should include only one focusable element of a composite UI component."
- `tabindex`: "You are recommended to **only use `0` and `-1`**… Avoid using `tabindex` values greater than `0`"; WHATWG: "Developers should use caution when using values other than 0 or −1", and "the `tabindex` attribute cannot be used to make an element non-focusable. The only way a page author can do that is by… making it `inert`." <https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/tabindex>
- Focusable-but-disabled items inside composites use `aria-disabled="true"`, not `disabled`, which removes the element from the tab sequence. <https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/>

### Skip links

**2.4.1** requires a mechanism to bypass repeated blocks; the Understanding doc treats skip links as the canonical mechanism and adds: "A link above the list enables users to skip the filters and get to the product results quickly." <https://www.w3.org/WAI/WCAG22/Understanding/bypass-blocks.html> For Kohlab: a skip target for the main pane, and a keyboard route past the sidebar into the primary workspace.

### Hover-revealed affordances (per-row actions)

**1.4.13 Content on Hover or Focus, AA** applies:

> Where receiving and then removing pointer hover or keyboard focus triggers additional content to become visible and then hidden, the following are true: **Dismissible** — A mechanism is available to dismiss the additional content without moving pointer hover or keyboard focus, unless the additional content communicates an input error or does not obscure or replace other content; **Hoverable** — If pointer hover can trigger the additional content, then the pointer can be moved over the additional content without the additional content disappearing; **Persistent** — The additional content remains visible until the hover or focus trigger is removed, the user dismisses it, or its information is no longer valid.
> <https://www.w3.org/TR/WCAG22/#content-on-hover-or-focus>

The keyboard obligation is explicit in the Understanding doc: "**Content which can be triggered via pointer hover should also be able to be triggered by keyboard focus.**" <https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html> Combined with **2.1.1**, per-row hover actions must (1) become visible on `:focus-within`, not only `:hover`; (2) stay in the tab order (visibility/opacity with `pointer-events`, not `display:none`); (3) have `Escape`-dismissible, hoverable, persistent tooltips rather than `title=` as the only label; (4) never be the only path — the palette should expose the same action, which also supplies 2.5.8's equivalent-control path.

## 8. Forced colors, high contrast, reduced transparency

### `forced-colors: active`

<https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/forced-colors>

- Author values are discarded and replaced at paint time for: `color`, `background-color`, `text-decoration-color`, `text-emphasis-color`, `border-color`, `outline-color`, `column-rule-color`, `-webkit-tap-highlight-color`, and the SVG `fill` and `stroke` attributes.
- Special behaviour: "`box-shadow` is forced to `'none'`", "`text-shadow` is forced to `'none'`", "`background-image` is forced to `'none'` for values that are **not url-based**", "`color-scheme` is forced to `'light dark'`", "`scrollbar-color` is forced to `'auto'`".
- **ARIA does not influence the palette:** "User agents choose system colors based on **native element semantics, not** on added ARIA roles. As an example, adding `role="button"` to a `div` will **not** cause an element's color to be forced to `ButtonText`." A styled `<div role="button">` therefore loses its author colours and gains nothing — a strong argument for native `<button>`. Browsers also draw text backplates, "particularly important for preserving contrast when text is placed on top of images."
- Use system colour keywords for properties not in the override list: `Canvas`, `CanvasText`, `ButtonFace`, `ButtonText`, `ButtonBorder`, `Field`, `FieldText`, `GrayText`, `Highlight`, `HighlightText`, `SelectedItem`, `SelectedItemText`, `LinkText`, `VisitedText`, `ActiveText`, `AccentColor`, `AccentColorText`, `Mark`, `MarkText`. <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/system-color>
- Escape hatch, use rarely: `forced-color-adjust: none` — "The element's colors are not automatically adjusted by the user agent in forced colors mode", and it also "disable[s] the backplate for text". MDN warns it "should only be used to make changes that will support a user's color and contrast requirements… **It should not be used to prevent user choices being respected.**" <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/forced-color-adjust>
- Do not build a parallel design: "In general, web authors should **not** be using the `forced-colors` media feature to create a separate design for users with this feature enabled. Instead, its intended usage is to make small tweaks to improve usability or legibility."

### What this does to a dark agent-monitoring UI

This is the highest-risk area, because a monitoring UI encodes state in colour.

- Run states (running / ok / failed / blocked), diff add/remove lines, and syntax colours all lose hue. **1.4.1 Use of Color (A)** already forbids colour as the only means: "Color is not used as the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element." <https://www.w3.org/TR/WCAG22/#use-of-color> Forced colors merely makes an existing violation visible. Every state needs a glyph, text label, or shape in addition.
- `box-shadow`-based depth, shadow-drawn focus rings, and `linear-gradient` borders vanish. Anything load-bearing must use `border` or `outline`, which survive.
- `background-image` survives only for URL-based values, so a gradient is stripped but an inline-SVG data-URI is not. Do not rely on that distinction — use borders.
- `color-scheme: dark` is forced to `light dark`, so the UA may present light chrome; assume neither scheme is guaranteed.
- Focus indicators must not depend on shadow or an author background colour; use `outline-color`, which the UA repaints.

### `prefers-contrast`, `color-scheme`, reduced transparency

- `prefers-contrast` values `no-preference | more | less | custom`; "`custom`… will match the color palette specified by users of `forced-colors: active`." <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-contrast>
- `color-scheme` drives UA scrollbar and form-control colours, so declare `color-scheme: dark` on `:root` to avoid light scrollbars over a dark canvas (it is forced to `light dark` under forced colors). <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/color-scheme>
- `prefers-reduced-transparency` is Experimental (§6): ship an in-app toggle instead.

## Implications for Kohlab

1. **[MUST]** Target **WCAG 2.2 Level AA** as the conformance baseline and cite <https://www.w3.org/TR/WCAG22/>. Never cite WCAG 3.0 or APCA in a conformance, procurement, or compliance statement — WCAG 3.0's own text says "It is inappropriate to cite this document as other than a work in progress." ([WCAG22](https://www.w3.org/TR/WCAG22/), [WCAG 3.0 WD](https://www.w3.org/TR/2026/WD-wcag-3.0-20260910/))
2. **[MUST]** Gate CI on **1.4.3** (4.5:1 normal text; 3:1 large text, i.e. ≥18pt/24px or 14pt/18.5px bold) and **1.4.11** (3:1 for component boundaries, states, icons, and focus indicators), computing `(L1+0.05)/(L2+0.05)` from WCAG relative luminance with **no rounding** — 4.499:1 fails, 2.999:1 fails. ([1.4.3](https://www.w3.org/TR/WCAG22/#contrast-minimum), [1.4.11](https://www.w3.org/TR/WCAG22/#non-text-contrast))
3. **[SHOULD]** Additionally sanity-check dark-surface text against **APCA Lc ≥ 75 for body text and Lc ≥ 60 for secondary text**, since WCAG 2.x is known to overstate contrast near black; where the two disagree, satisfy the stricter. Label these a design heuristic — APCA is named in **no** W3C document. ([APCA](https://git.apcacontrast.com/documentation/APCAeasyIntro))
4. **[MUST]** Give every colour-encoded agent state (running / ok / failed / blocked / stale) a non-colour cue — glyph, text label, or shape — so it survives `forced-colors: active` and satisfies **1.4.1 Use of Color**. ([1.4.1](https://www.w3.org/TR/WCAG22/#use-of-color))
5. **[MUST]** Draw every load-bearing boundary, divider, and focus indicator with `border`/`outline`/`outline-color`, never `box-shadow` or a non-URL `background-image`, because forced colors forces those to `none`. ([forced-colors](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/forced-colors))
6. **[MUST]** Use native interactive elements (`<button>`, `<a>`, `<input>`) rather than styled `<div role="button">`, and apply system colour keywords (`Canvas`, `CanvasText`, `ButtonFace`, `ButtonText`, `ButtonBorder`, `Field`, `FieldText`, `GrayText`, `Highlight`, `HighlightText`, `SelectedItem`, `SelectedItemText`, `AccentColor`, `AccentColorText`) under `@media (forced-colors: active)` for any property not in the override list; scope any `forced-color-adjust: none` narrowly and document why — UA system-colour mapping follows native semantics, not ARIA roles. ([system-color](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/system-color), [forced-color-adjust](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/forced-color-adjust))
7. **[MUST]** Keep **28px** sidebar icon buttons at ≥24×24 CSS px on every breakpoint — they pass **2.5.8 AA** by size — and raise them to ~44×44 on touch layouts instead of leaning on the Spacing exception; if any target shrinks below 24px, centres must be ≥24px apart. ([2.5.8](https://www.w3.org/TR/WCAG22/#target-size-minimum))
8. **[MUST]** Implement focus indicators as a **≥2px `outline` with `outline-offset`** meeting 3:1 against the adjacent colour and offset outside the component so they satisfy the 2px-perimeter area rule; never ship `outline: none` without a replacement. ([2.4.13](https://www.w3.org/TR/WCAG22/#focus-appearance), [2.4.7](https://www.w3.org/TR/WCAG22/#focus-visible))
9. **[MUST]** Guarantee **2.4.11**: when a row, tab, or tree node receives focus, no sticky header, sticky footer, or non-modal overlay fully covers it — scroll it clear of author-created chrome, and where a fixed toolbar must overlap content, reserve space or make the toolbar collapsible. ([2.4.11](https://www.w3.org/TR/WCAG22/#focus-not-obscured-minimum))
10. **[MUST]** Build the command palette on a native `<dialog>` (modal) plus an `input[role=combobox]` with `aria-expanded`, `aria-controls`, and `aria-activedescendant`, keeping **DOM focus on the input**; if the popup renders through a React portal, satisfy one of the APG's three DOM-relationship conditions (descendant, `aria-owns`, or role `combobox` + `aria-controls`), and never capture the browser's own text-editing keys. ([combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/), [keyboard-interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/))
11. **[MUST]** Use `<dialog showModal()` with `autofocus` for all modal confirms so the top layer, backdrop, inertness, focus trap, and single-`Escape`-closes-topmost-dialog behaviour come from the browser, and always restore focus to the invoking element on close — falling back to a logical landmark, never `<body>`, when the invoker unmounted. ([dialog-modal](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [WHATWG](https://html.spec.whatwg.org/multipage/interactive-elements.html))
12. **[MUST]** Keep the terminal scrollback and log tail **out of the live-region system** (default `aria-live="off"`) and route announcements through one small, permanently-present `role="status"`/`aria-atomic="true"` announcer emitting coalesced discrete state transitions — never one per output line — with a user-visible **pause announcements** control satisfying **2.2.2**; reserve `assertive`/`role="alert"` for genuine process failure, and feature-detect `Document.ariaNotify()` as a future path while keeping live regions as the fallback. ([aria-live](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-live), [2.2.2](https://www.w3.org/TR/WCAG22/#pause-stop-hide), [ariaNotify](https://developer.mozilla.org/en-US/docs/Web/API/Document/ariaNotify))
13. **[MUST]** Reveal per-row hover actions on **`:focus-within` as well as `:hover`**, keep them in the tab order (visibility/opacity with `pointer-events`, not `display:none`), make tooltips `Escape`-dismissible, hoverable, and persistent while the trigger holds hover/focus, and expose the same actions in the palette so hover is never the only path. ([1.4.13](https://www.w3.org/TR/WCAG22/#content-on-hover-or-focus), [2.1.1](https://www.w3.org/TR/WCAG22/#keyboard))
14. **[SHOULD]** For drag interactions (pane resize, tab reorder, file move) ship a keyboard or single-pointer non-dragging equivalent — arrow-key nudge on a focused splitter, "move left/right" commands, or click-then-click-target — to satisfy **2.5.7 AA**. ([2.5.7](https://www.w3.org/TR/WCAG22/#dragging-movements))
15. **[SHOULD]** Wrap all non-essential animation in `@media (prefers-reduced-motion: reduce)` to remove motion rather than slow it; never use `scroll-behavior: smooth` to auto-scroll a log tail (MDN documents no reduced-motion interaction for that property); ship in-app toggles for reduced transparency/blur and high contrast rather than depending on `prefers-reduced-transparency`, which MDN flags Experimental and not Baseline; and declare `color-scheme: dark` on `:root` so UA scrollbars and form controls match the dark canvas. ([prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion), [prefers-reduced-transparency](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-transparency), [color-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/color-scheme))
