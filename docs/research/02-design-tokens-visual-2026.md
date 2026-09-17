# 02 — Design tokens, color, typography, CSS platform, layout, motion

Verified **2026-09-16**. Every status claim was read from a primary source fetched on that date. Baseline statuses come from MDN page badges and the canonical `web-features` dataset (v3.38.0, <https://github.com/web-platform-dx/web-features>) — the same data behind MDN's Baseline banners.

**Baseline vocabulary** (<https://developer.mozilla.org/en-US/docs/Glossary/Baseline/Compatibility>): **Widely available** = supported in all Baseline browsers 30+ months. **Newly available** = shipped in every Baseline browser but <30 months. **Limited availability** = interop gap in a widely used browser — **do not rely on it.**

Labels used below: **[SPEC]** normative requirement · **[STATUS]** baseline/support fact · **[VENDOR]** official vendor design guidance, not a standard · **[MEASURE]** performance threshold · **[OPINION]** practitioner convention with no normative backing.

---

## 1. Design tokens

### 1.1 DTCG format spec status — stable CG report, not a W3C standard

| Artefact | Status | URL |
|---|---|---|
| Design Tokens Format Module **2025.10** | **Final Community Group Report, 28 October 2025** — first stable version | <https://www.designtokens.org/TR/2025.10/format/> |
| `tr.designtokens.org/format/` | **Draft** CG Report, 08 September 2026 — rolling preview of unpublished changes | <https://tr.designtokens.org/format/> |

- **[SPEC]** The stable report says of itself: *"It is not a W3C Standard nor is it on the W3C Standards Track."* It is a Community Group report under the Community Final Specification Agreement. Headline: **stable as an interchange format, but never a W3C standard.** <https://www.designtokens.org/TR/2025.10/format/>
- **[SPEC]** The `tr.` URL is explicitly unshippable: *"This is a preview draft of in progress changes. Do not refer to this document directly, and do not implement anything in this document."* Roadmap only. <https://tr.designtokens.org/format/>
- **[VENDOR]** W3C CG announcement: *"In October 2025, we announced the first stable version of the Design Tokens specification"*, naming Figma, Penpot, Sketch, Tokens Studio, Style Dictionary and Terrazzo as supporting tools. <https://www.w3.org/community/design-tokens/>
- **[SPEC]** Syntax (normative in 2025.10): `$value` is the discriminator — *"An object with a `$value` property is a token… `$value` is a reserved word in our spec"*; optional `$type`, `$description`, `$extensions`, `$deprecated`; group-level `$extends`; reserved `$root`. Names **MUST NOT** begin with `$` nor contain `{`, `}`, `.`. <https://www.designtokens.org/TR/2025.10/format/>
- **[SPEC]** Types must be unambiguous: *"Tools MUST NOT attempt to guess the type of a token by inspecting the contents of its value."* A token with no `$type`, no reference, and no typed ancestor is **invalid**. Normative `$type`s: `color`, `dimension` (px/rem), `fontFamily`, `fontWeight`, `duration`, `cubicBezier`, `number`; composites `strokeStyle`, `border`, `transition`, `shadow`, `gradient`, `typography`. §8.8 "Additional types" is **non-normative** — font style, percentage/ratio and file types are *not yet specified*. <https://www.designtokens.org/TR/2025.10/format/>
- **[SPEC]** Interchange: media type `application/design-tokens+json` (tools **MUST** also accept `application/json`); extensions `.tokens` / `.tokens.json`. **Verdict: this is a file-export format for design-tool interop, not a runtime format. Nothing in it should shape Kohlab's CSS architecture.** <https://www.designtokens.org/TR/2025.10/format/>

### 1.2 Token tiers — real systems' naming, and why the chain matters

The primitive → semantic → component model is **documented vendor convention, not a spec mandate**; the spec supplies only the mechanism (aliases).

- **[SPEC]** Alias mechanism: `{ "semantic": { "primary": { "$value": "{colors.blue}", "$type": "color" } } }` — *"The curly brace syntax is specifically designed for referencing complete token values and always resolves to the `$value` property of the target token."* Reference cycles are errors tools must report. <https://tr.designtokens.org/format/>
- **[VENDOR]** Adobe Spectrum names the tiers **global → alias → component-specific**, with an explicit chain: *"A token named `drop-zone-background-color` is a component-specific token. This has an alias token named `accent-visual-color`. That has another alias token named `accent-color-800`. That is connected to `blue-800`, which is a global token."* <https://spectrum.adobe.com/page/design-tokens/>
- **[VENDOR]** Spectrum's usage rule — the load-bearing reason the tiers exist: *"When building Spectrum verified components, use component-specific tokens. This ensures that as a component's design evolves, you won't have to retrace any higher-level design decisions."* And: *"Only use global tokens when there are no available aliases for your use case."* <https://spectrum.adobe.com/page/design-tokens/>
- **[VENDOR]** IBM Carbon names two tiers, **Core Tokens** and **Component Tokens**: *"Core tokens are global colors that are used across components"*; component tokens *"are not global tokens like the core tokens and should never be used for anything other than their own component."* <https://carbondesignsystem.com/elements/color/tokens/>
- Tier *names* vary by system. Material 3 and Salesforce Lightning could **not** be verified — both serve JS-only shells with no body text to a non-browser fetch. Do not cite them.
- **Net rule:** components consume **semantic** tokens; semantic tokens alias **primitives**; nothing outside the primitive layer holds a raw colour literal. No spec forces this, but both vendors that document tiers state it, and the DTCG alias machinery exists to express exactly it.

### 1.3 CSS custom properties vs Tailwind v4 `@theme`

| | Plain CSS custom property (`:root`) | `@theme` variable |
|---|---|---|
| Emits a CSS variable | yes | yes — *"Tailwind also generates regular CSS variables for your theme variables"* |
| Generates utilities | **no** | yes — *"influence which utility classes exist in your project"* |
| May be nested / inside media queries | yes | **no** — *"Theme variables are also required to be defined top-level and not nested under other selectors or media queries"* |

- **[VENDOR]** The documented split: *"Use `@theme` when you want a design token to map directly to a utility class, and use `:root` for defining regular CSS variables that shouldn't have corresponding utility classes."* <https://tailwindcss.com/docs/theme>
- **[VENDOR]** Namespaces bind a prefix to a utility family: `--color-*` → `bg-*`/`text-*`/`border-*`; `--font-*` → `font-*`; `--text-*` → font-size; `--font-weight-*`; `--tracking-*`; `--leading-*`; `--breakpoint-*` → `sm:*`; `--container-*` → `@sm:*`; `--spacing-*`; `--radius-*`; `--shadow-*`; `--ease-*`; `--animate-*`. Names outside a known namespace produce no utilities. Override by redefining inside `@theme`; wipe one namespace with `--color-*: initial`, everything with `--*: initial`. <https://tailwindcss.com/docs/theme>

### 1.4 The `@theme inline` question — direct answer

**Use `@theme inline` for every token that references another variable, i.e. the entire shadcn-style `:root` + alias layer.**

- **[VENDOR]** Substitution semantics: *"Using the `inline` option, the utility class will use the theme variable **value** instead of referencing the actual theme variable."* `@theme inline { --font-sans: var(--font-inter) }` compiles to `.font-sans { font-family: var(--font-inter) }` — the utility body carries the *value*, not the token name. <https://tailwindcss.com/docs/theme>
- **[VENDOR]** Why plain `@theme` breaks aliases: *"Without using `inline`, your utility classes might resolve to unexpected values because of how variables are resolved in CSS."* The docs' example shows `--font-sans: var(--font-inter, sans-serif)` resolving to `sans-serif` at the point of use rather than `Inter`. <https://tailwindcss.com/docs/theme>
- **[VENDOR]** The colours page states the pattern for exactly Kohlab's case, including runtime retargeting via a data attribute: *"Use `@theme inline` when defining colors that reference other colors:"* followed by `:root { --acme-canvas-color: oklch(...) }` / `[data-theme="dark"] { --acme-canvas-color: oklch(...) }` / `@theme inline { --color-canvas: var(--acme-canvas-color) }`. <https://tailwindcss.com/docs/colors>
- **[VENDOR]** `theme()` is superseded by `var(--color-*)`; build-time helpers are `--alpha()` (compiles to `color-mix(in oklab, …)`) and `--spacing()`. <https://tailwindcss.com/docs/functions-and-directives>
- **[STATUS]** Tailwind's browser floor: *"Tailwind CSS v4.0 is designed for Safari 16.4+, Chrome 111+, and Firefox 128+."* <https://tailwindcss.com/docs/upgrade-guide> — that floor already implies OKLCH, `color-mix()`, `@property` and container queries, which is why most platform questions in §4 answer themselves.
- **Verdict:** the existing `web/src/index.css` pattern (`:root` raw tokens + `@theme inline` bridge) is the documented, correct one. Keep it; do not "simplify" it into plain `@theme` with `var()` aliases.

---

## 2. Color

### 2.1 Is OKLCH production-safe in 2026? Yes

- **[STATUS]** `oklch()` is **Baseline Widely available since May 2023**. <https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/oklch>
- **[STATUS]** Siblings landed together: `color()` **Widely available since May 2023** (<https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/color>); `color-mix()` baseline low date **2023-05-09** — Chrome 111 / Firefox 113 / Safari 16.2 (web-features v3.38.0, `color-mix`).
- **[VENDOR]** Strongest practical evidence: Tailwind v4's **entire default palette is authored in OKLCH** on a Safari 16.4+/Chrome 111+/Firefox 128+ floor. <https://tailwindcss.com/docs/colors>, <https://tailwindcss.com/docs/upgrade-guide>
- **[STATUS]** **Fallbacks/gating:** no `rgb()` fallback is needed inside Kohlab's support envelope. If a gate is ever wanted, `@supports (color: oklch(0 0 0))` is the correct query (Baseline Widely available since September 2015, <https://developer.mozilla.org/en-US/docs/Web/CSS/@supports>); `CSS.supports()` is the JS equivalent. Wide-gamut intent is expressed with `@media (color-gamut: p3)` — *"The user agent and the output device can support approximately the gamut specified by the Display P3 color space or more."* <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/color-gamut>

### 2.2 Gamut mapping — required by spec, algorithm still in flux

- **[SPEC]** CSS Color Module Level 4 is a **Candidate Recommendation Draft, 13 September 2026**, not a Recommendation. Abstract: *"It also describes how colors are interpolated, and how to gamut map colors."* <https://www.w3.org/TR/css-color-4/>
- **[SPEC]** Gamut mapping is **normative for display**, not bucket-clipping: *"For intermediate color calculations, these out of gamut values are preserved. However, if the destination is the display device (a screen, or a printer) then out of gamut values must be converted to an in-gamut color."* (§14.1) and *"They thus require to be css gamut mapped"* (§14.2), with the worked example *"Attempting to display the color `color(display-p3 1.1 0.4 0.2)` will trigger gamut mapping, because the red coordinate is outside the range 0 to 1; gamut mapping will produce a similar, but lower chroma, color."* <https://www.w3.org/TR/css-color-4/>
- **[SPEC]** §14 "Gamut Mapping", however, enumerates *competing* algorithms — §14.1.1 Clipping, §14.1.2 Closest Color (MINDE), §14.1.3 Chroma Reduction, §14.1.5 Chroma Reduction with Local Clipping, §14.2.1 Binary Search with Local MINDE, §14.2.3 EdgeSeeker, §14.2.5 Ray Trace. The requirement is settled; the algorithm choice is **not** — so out-of-sRGB OKLCH may render slightly differently across engines. <https://www.w3.org/TR/css-color-4/>
- **Practical rule:** treat high chroma as an enhancement. Never park a contrast-critical decision on a chroma value that exists only outside sRGB — verify the **sRGB** rendering of every text/background pair.

### 2.3 Why OKLCH for ramps, and what HSL breaks

- **[SPEC]** HSL hue is not perceptually uniform — normative text in CSS Color 4: *"The hue angle in HSL is not perceptually uniform; colors appear bunched up in some areas and widely spaced in others. For example, the pair of hues `hsl(220deg 100% 50%)` and `hsl(250deg 100% 50%)` have an HSL hue difference of 30 deg and look fairly similar, while another pair `hsl(50deg 100% 50%)` and `hsl(80deg 100% 50%)`, which also have a hue difference of 30 deg, look very different."* <https://www.w3.org/TR/css-color-4/>
- **[SPEC]** Oklab/Oklch is the perceptual space: *"Recently, Oklab, an improved Lab-like space has been developed… It was produced by numerical optimization of a large dataset of visually similar colors, and has improved hue linearity, hue uniformity, and chroma uniformity compared to CIE LCH."* (§9.2) and *"Because Oklab is more perceptually uniform than CIE Lab, the color difference is a straightforward distance in 3D space (root sum of squares)."* <https://www.w3.org/TR/css-color-4/>
- **What breaks if you keep HSL:** equal-`L` steps are not equal *perceived* lightness, so a same-`L` ramp across two hues (emerald vs amber) yields different contrast at each step — status chips of "the same lightness" will not read as the same weight, and a ramp tuned for one hue does not transfer to another. Kohlab currently encodes tokens as bare HSL triplets in `web/src/index.css`; that is precisely the shape that cannot be ramped perceptually.
- **[STATUS]** `color-mix()` is the ramp mechanism (**Widely available, low 2023-05-09**; Tailwind's own `--alpha()` compiles to `color-mix(in oklab, …)`, <https://tailwindcss.com/docs/functions-and-directives>). ⚠️ **Not Baseline:** `color-mix()` with **three or more** colours — Firefox-only in web-features v3.38.0. Stick to two-colour mixes.

### 2.4 `color-scheme` and `light-dark()`

- **[STATUS]** `color-scheme` is **Baseline Widely available since January 2022** (baseline low 2022-02-03). It changes UI chrome: *"The color of the canvas surface. The default colors of scrollbars and other interaction UI. The default colors of form controls. The default colors of other browser-provided UI."* <https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme>
- **[SPEC]** `<meta name="color-scheme">` in `<head>` before any CSS *"inform[s] user agents about the preferred color scheme, helping prevent unwanted screen flashes during the page load."* <https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme>
- **[STATUS]** `light-dark()` is **Baseline Newly available, low 2024-05-13** — Chrome 123 / Firefox 120 / Safari 17.5 (web-features v3.38.0; MDN badge: "Baseline 2024 Newly available"). It requires `color-scheme` to be set — MDN's example comments the `:root` declaration *"this has to be set to switch between light or dark"*. <https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/light-dark>
- **[SPEC]** MDN warns against forcing a scheme per section: *"Generally this should not be done… If the user has made a preference, you generally should not override their preferences."*
- **Architecture verdict for Kohlab (dark-only):** set `color-scheme: dark` on `:root` plus the matching `<meta>`, keep one token set. `light-dark()` buys nothing without a light theme — do not adopt it, and do not build two-mode token indirection "for later".
- **[SPEC]** Contrast conformance stays ratio-based. WCAG 2.2 SC 1.4.3: *"The visual presentation of text and images of text has a contrast ratio of at least 4.5:1"*, large-scale text *"at least 3:1"* — *"18 point text or 14 point bold text is judged to be large enough to require a lower contrast ratio."* <https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html> WCAG 2.2 defines ratios, not a perceptual model.

---

## 3. Typography

### 3.1 Type scale — no standard exists; say so

- **[OPINION]** **No W3C/WHATWG standard and no vendor standard defines a UI type scale.** Tailwind ships a `--text-*` namespace (<https://tailwindcss.com/docs/theme>) — a default, not a recommendation. A "modular scale" is practitioner convention.
- **Recommended shape:** a **fixed small step set in `rem`** (roughly 11/12/13/14/16/20/25 px) rather than a floating ratio, because dense consoles need repeatable close-packed steps, not geometric growth. Kohlab's current sizes (10–25 px) already form such a set — keep it, but define each as a token instead of literals scattered through `index.css`.
- **[SPEC]** Sizes must be `rem`-based, not `px`, to compose with user text scaling: SC 1.4.4 Resize Text (AA) requires content *"can be scaled up to 200% using at least one text scaling mechanism supported by user agents."* <https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html>

### 3.2 Variable-font mechanics

- **[STATUS]** `font-optical-sizing: auto` is **Baseline Widely available since March 2020**; it has an effect **only** for variable fonts carrying an `opsz` axis — a no-op otherwise. <https://developer.mozilla.org/en-US/docs/Web/CSS/font-optical-sizing>
- **[STATUS]** `font-feature-settings` is Baseline Widely available since April 2017, but MDN: *"Whenever possible, Web authors should instead use the `font-variant` shorthand property or an associated longhand property such as `font-variant-ligatures`, `font-variant-caps`…"* <https://developer.mozilla.org/en-US/docs/Web/CSS/font-feature-settings> So `font-feature-settings: "tnum"` is the wrong tool where a longhand exists.
- **[STATUS]** `font-variant-numeric` is **Baseline Widely available since January 2020**; `tabular-nums` *"activat[es] the set of figures where numbers are all of the same size, allowing them to be easily aligned like in tables. It corresponds to the OpenType values `tnum`."* <https://developer.mozilla.org/en-US/docs/Web/CSS/font-variant-numeric>
- **Use:** `font-variant-numeric: tabular-nums` on every live counter, duration, table column and log timestamp; `slashed-zero` for workspace IDs. **[OPINION]** For a monospaced face (Kohlab's `--font-mono`) digits already share an advance width, so this matters most for any proportional face in a data position.

### 3.3 Small text and WCAG limits

- **[SPEC]** WCAG 2.2 **sets no minimum font size**. It constrains contrast (1.4.3), resize (1.4.4), spacing tolerance (1.4.12) and reflow (1.4.10) instead. A 10 px uppercase label is not a violation by itself; a 10 px label at 3.9:1 is.
- **[SPEC]** SC 1.4.12 Text Spacing (AA) requires content to survive all of, applied together: *"Line height (line spacing) to at least 1.5 times the font size; Spacing following paragraphs to at least 2 times the font size; Letter spacing (tracking) to at least 0.12 times the font size; Word spacing to at least 0.16 times the font size."* <https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html> — therefore never put a fixed `height` on a text-bearing container (status chips, table rows, toolbar labels); use `min-height` + padding so the overrides cannot clip content.
- **[STATUS]** `clamp()` is Baseline Widely available since July 2020 (<https://developer.mozilla.org/en-US/docs/Web/CSS/clamp>), but web.dev warns directly against fluid type at the top of a scale: *"Limiting maximum font sizes using `max()` or `clamp()` can cause a WCAG failure under 1.4.4 Resize text (AA), because it might prevent users from scaling the text to 200% of its original size. Make sure to test the results with zoom."* <https://web.dev/articles/min-max-clamp> → **do not use `clamp()` for body/UI text**; at most for display headings.

### 3.4 Zero-cost system font stacks

- **[VENDOR]** Tailwind's default theme is already a system stack with no webfont cost, and Kohlab inherits it: `--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` and `--font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`. <https://tailwindcss.com/docs/theme>
- **[SPEC]** Generic families are the portable alternative: `system-ui`, `ui-sans-serif`, `ui-serif`, `ui-monospace`, `ui-rounded` — standard `font-family` keywords. <https://developer.mozilla.org/en-US/docs/Web/CSS/font-family>
- **[OPINION]** Cross-platform reality: macOS renders SF, Windows Segoe UI Variable, Android Roboto, Linux whatever the distro ships. Metrics differ, so pixel-parity requires shipping a webfont. For a self-hosted console the right trade is **zero network bytes, zero FOUT, vendor-specific metrics accepted.** Kohlab's stated `JetBrains Mono` preference is a webfont cost that must be justified or dropped for `ui-monospace`.

---

## 4. CSS platform features — status matrix

Statuses: web-features v3.38.0 + MDN page badges, both read 2026-09-16.

| Feature | Baseline status | Source | Practical use in Kohlab |
|---|---|---|---|
| `@container` + `container-type` + `cqi` | **Widely available** (low 2023-02-14; Chrome 105/FF 110/Safari 16) | <https://developer.mozilla.org/en-US/docs/Web/CSS/container-type> | Panels adapt to their pane, not the viewport: sidebar-collapsed vs expanded cockpit; `cqi` for type in a resizable pane. |
| `:has()` | **Widely available** (low 2023-12-19) | <https://developer.mozilla.org/en-US/docs/Web/CSS/:has> | Parent-state styling without JS: `.panel:has(.field-input:focus)`, `.row:has(.status-running)`. |
| `@layer` | **Widely available** (low 2022-03-14) | <https://developer.mozilla.org/en-US/docs/Web/CSS/@layer> | Tailwind already emits `@layer theme, base, components, utilities`; put app overrides in a later layer instead of escalating specificity. |
| CSS nesting | **Widely available** (low 2023-12-11) | web-features `nesting`; <https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_nesting/Using_CSS_nesting> | Readable component CSS in `index.css`; note `&` specificity behaves like `:is()`. |
| `subgrid` | **Widely available** (low 2023-09-15) | <https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout/Subgrid> | Align card internals to a shared row rhythm across the KPI strip. |
| `text-wrap: balance` | **Newly available** (low 2024-05-13) | web-features `text-wrap-balance` | Empty-state and modal headings only — it is capped to short runs. |
| `text-wrap: pretty` | ⚠️ **NOT Baseline** (Chrome 117, Safari 26; **no Firefox**) | web-features `text-wrap-pretty` | Optional enhancement on descriptions; must degrade silently. |
| `field-sizing: content` | ⚠️ **New** — low **2026-06-16** (Chrome 123/FF 152/Safari 26.2) | <https://developer.mozilla.org/en-US/docs/Web/CSS/field-sizing> | Auto-growing textareas in the onboarding wizard; pair with `min-height`/`max-height`. Brand-new. |
| View Transitions, **same-document** (`document.startViewTransition`) | **Newly available** (low 2025-10-14; Chrome 111/FF 144/Safari 18) | <https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition> | Tab/view morphs in the SPA; feature-detect — the method is `undefined` where unsupported. |
| View Transitions, **cross-document** (`@view-transition`) | ⚠️ **NOT Baseline** (Chrome 126/Safari 18.2; **no Firefox**) — MDN: *"Limited availability"* | <https://developer.mozilla.org/en-US/docs/Web/CSS/@view-transition> | Irrelevant — Kohlab is an SPA with a persistent shell. Skip. |
| `popover` attribute | **Newly available** (low 2025-01-27; Chrome 116/FF 125/Safari 17/iOS 18.3) | <https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/popover> | Lightweight menus without a JS stack. MDN's badge reads 2024; the dataset's 2025-01-27 reflects iOS Safari 18.3 — a reminder to check *mobile* support, not desktop. |
| `<dialog>` + `showModal()` + `::backdrop` | **Widely available** (low 2022-03-14) | <https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog>, <https://developer.mozilla.org/en-US/docs/Web/CSS/::backdrop> | Native focus trap and inertness; Kohlab hand-rolls `.modal-overlay`/`.modal` in `index.css`. |
| CSS anchor positioning | ⚠️ **CONTESTED.** MDN's `anchor()` page: *"Baseline 2026 Newly available… Since January 2026"* (<https://developer.mozilla.org/en-US/docs/Web/CSS/anchor>); the `anchor-positioning` **feature** in web-features v3.38.0 is **not baseline**, as are `-animations`, `-transforms`, `-position-visibility-plurals`. | <https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_anchor_positioning/Using> | **Do not adopt** — Radix already solves tooltip/dropdown placement. |
| Scroll-driven animations (`animation-timeline`, `scroll()`, `view()`) | ⚠️ **NOT Baseline** (Chrome 115/Safari 26; **no Firefox**) — MDN: *"Limited availability"* | <https://developer.mozilla.org/en-US/docs/Web/CSS/animation-timeline> | Do not use; a monitoring console has no case for scroll-linked motion. |
| `interpolate-size: allow-keywords` / `calc-size()` | ⚠️ **NOT Baseline** (Chrome 129+; MDN marks `calc-size()` *"Experimental"*) | <https://developer.mozilla.org/en-US/docs/Web/CSS/interpolate-size>, <https://developer.mozilla.org/en-US/docs/Web/CSS/calc-size> | Do not animate to/from `auto` heights; fix the height or accept a discrete toggle. |
| `light-dark()` | **Newly available** (low 2024-05-13) | <https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/light-dark> | Not applicable — dark-only. See §2.4. |
| `@scope` | ⚠️ **New** — low **2026-03-24** (Chrome 143/FF 146/Safari 26.4) | <https://developer.mozilla.org/en-US/docs/Web/CSS/@scope> | Genuinely new; must not become load-bearing for component styling. |
| `backdrop-filter` | **Newly available** (low 2024-09-16) | web-features `backdrop-filter` | Real frosted topbar instead of the faux `hsl(... / 0.88)` translucency currently used. |

**Safe in 2026 without ceremony:** container queries, `:has()`, `@layer`, nesting, `subgrid`, `text-wrap: balance`, `<dialog>` + `::backdrop`, `popover`, same-document View Transitions, `dvh` units, logical properties, two-colour `color-mix()`, OKLCH. **Needs a fallback or should be skipped:** `text-wrap: pretty`, `field-sizing`, anchor positioning, scroll-driven animations, `interpolate-size`/`calc-size`, cross-document View Transitions, `@scope`.

---

## 5. Layout

- **Logical properties** — **[STATUS] Baseline Widely available, low 2021-09-20.** Use where intent is flow-relative: sidebar `border-inline-end`, content `padding-block`, `inset-inline-start` — that is what flips for free in RTL. Physical properties remain correct where intent is *device*-relative, notably `padding-left: env(safe-area-inset-left)`, since safe-area insets are physical. <https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_logical_properties_and_values>
- **`dvh` vs `vh` on mobile** — **[STATUS]** Viewport-unit variants are **Widely available, low 2022-12-05** (Chrome 108/FF 101/Safari 15.4). MDN: *"Currently, all default viewport units (`vh`, `vw`, etc.) are equivalent to their large viewport counterparts (`lvh`, `lvw`, etc.)."* <https://developer.mozilla.org/en-US/docs/Web/CSS/length#viewport_percentage_units> — which is exactly why `100vh` bleeds behind mobile browser chrome: *"elements sized to be `100vh` tall will bleed out of the viewport."* <https://web.dev/blog/viewport-units> **Recommendation:** `height: 100vh;` then `height: 100dvh;` on the app shell (later declaration wins where supported), shell `overflow: hidden`, scrolling inside panes. Accept the documented trade-off — dynamic units *"do not update at 60fps"* and are throttled/debounced, while MDN notes `sv*` are *"safer"* but would leave a visible gap in an internal-scroll shell. <https://web.dev/blog/viewport-units>
- **Safe areas** — **[STATUS] Baseline Widely available, low 2020-01-15** (web-features `safe-area-inset`). Requires `viewport-fit=cover` in the viewport meta tag, else insets are always `0`. Always pass a fallback — MDN's own example uses `env(safe-area-inset-top, 50px)`. <https://developer.mozilla.org/en-US/docs/Web/CSS/env> Apply to the fixed sidebar/topbar and any bottom-docked terminal bar. `env(keyboard-inset-*)` was **not** verified here — treat as unproven.
- **Intrinsic layout over breakpoints** — build with `repeat(auto-fit, minmax(280px, 1fr))`, `min()`/`max()`/`clamp()` and container queries so components size themselves; reserve media queries for genuine IA changes (sidebar collapse, tab strip → drawer). <https://web.dev/articles/min-max-clamp>, <https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries>
- **Touch targets** — **[SPEC]** WCAG 2.2 SC 2.5.8 Target Size (Minimum), **Level AA**: *"The size of the target for pointer inputs is at least 24 by 24 CSS pixels"*, with a spacing exception for undersized targets a 24 px-diameter circle can be centred on without intersecting another. <https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html> Vendor HIGs recommend larger (~44 pt / 48 dp) — **not verified in this brief.**
- **Reflow** — **[SPEC]** SC 1.4.10 (AA): *"Vertical scrolling content at a width equivalent to 320 CSS pixels"* with no two-dimensional scrolling. <https://www.w3.org/WAI/WCAG22/Understanding/reflow.html> The cockpit toolbar, tab strip and workspace table are the failure candidates; horizontal scrolling must be confined to the element, never the page.

---

## 6. Motion and perceived performance

### 6.1 Durations and easing — vendor guidance only

- **[SPEC]** **No W3C recommendation, CSS specification, or WCAG success criterion prescribes any duration for a UI transition.** WCAG mandates *mechanisms* (§6.2), not timings. Every number below is vendor guidance.
- **[VENDOR]** IBM Carbon publishes a six-token duration scale: *"Micro-interactions such as button and toggle 70ms"* (`duration-fast-01`), *"Micro-interactions such as fade 110ms"* (`fast-02`), *"small expansion, short distance movements 150ms"* (`moderate-01`), *"Expansion, system communication, toast 240ms"* (`moderate-02`), *"Large expansion, important system notifications 400ms"* (`slow-01`), *"Background dimming 700ms"* (`slow-02`). <https://carbondesignsystem.com/elements/motion/overview/>
- **[VENDOR]** Carbon easing with direction semantics: *"Strictly linear movement appears unnatural to the human eye. Elements on the screen should speed up quickly and slow down smoothly… Do not use easing curves that suggest bounce, stretch, or sudden stops."* Standard `cubic-bezier(0.2, 0, 0.38, 0.9)`; entrance `cubic-bezier(0, 0, 0.38, 0.9)`; exit `cubic-bezier(0.2, 0, 1, 0.9)`. <https://carbondesignsystem.com/elements/motion/overview/>
- **[VENDOR]** Material 3 tokens span 50–1000 ms; `short` is *"used for small utility-focused transitions"*, extra-long *"usually used for ambient transitions that don't involve user input"*; documented pairings are 200 ms exit, 250–300 ms on-screen, 400 ms enter, 500 ms emphasised. <https://m3.material.io/styles/motion/easing-and-duration/tokens-specs>, <https://m3.material.io/styles/motion/easing-and-duration/applying-easing-and-duration> *(both are JS-rendered SPAs — content read via a reader proxy over those URLs; vendor guidance, not spec.)*
- **[VENDOR]** Apple: *"Aim for brevity and precision in feedback animations… In apps, generally avoid adding motion to UI interactions that occur frequently."* No ms values given. <https://developer.apple.com/design/human-interface-guidelines/motion>
- **Synthesis:** 70–150 ms for hover/active/toggle feedback; 240 ms for panel and toast entry; 400 ms only for a genuinely large expansion; nothing interactive above ~500 ms. Two curves suffice (one standard, one decelerate-on-enter). Kohlab's current 120–150 ms transitions sit correctly in this band.

### 6.2 Accessibility obligations — these *are* requirements

- **[SPEC]** SC 2.3.3 Animation from Interactions, **Level AAA**: *"Motion animation triggered by interaction can be disabled, unless the animation is essential to the functionality or the information being conveyed."* Parallax is the named example. <https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html>
- **[SPEC]** SC 2.2.2 Pause, Stop, Hide, **Level A**: for *"any moving, blinking or scrolling information that (1) starts automatically, (2) lasts more than five seconds, and (3) is presented in parallel with other content, there is a mechanism for the user to pause, stop, or hide it"*. <https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html> → a perpetually pulsing "running" indicator is a Level A problem unless it can be stopped.
- **[STATUS]** `prefers-reduced-motion` is **Baseline Widely available since January 2020**. <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion>
- **Reduce ≠ none.** Chrome: *"a preference for 'reduced motion' doesn't mean the user wants no motion. Instead of the preceding snippet, you could choose a more subtle animation."* (<https://developer.chrome.com/docs/web-platform/view-transitions/same-document>) MDN's example swaps a scaling pulse for a *"dissolve animation, which is a more muted animation that is not a vestibular motion trigger"*. Implement opacity/crossfade-only.
- **[SPEC]** SC 2.3.1 (Level A): nothing *"flashes more than three times in any one second period"*. <https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html>

### 6.3 Which animations cost you

- **[VENDOR]** Animate only `transform`/`opacity`: *"Before using any CSS property for animation (other than `transform` and `opacity`), determine the property's impact on the rendering pipeline. Avoid any property that triggers layout or paint unless it's absolutely necessary… If you must use a property that triggers layout or paint, you probably won't be able to keep the animation smooth or high-performing."* <https://web.dev/articles/animations-guide> Layout-triggering properties (`width`, `height`, `top`, `left`, `margin`) force reflow plus repaint. <https://web.dev/articles/animations-and-performance>
- **[MEASURE]** The budget: *"For a rate of 60 frames per second, the browser has 16.7 milliseconds to execute scripts, recalculate styles and layout if needed, and repaint."* <https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/Animation_performance_and_frame_rate>
- **[MEASURE]** Thresholds that catch motion mistakes: **CLS ≤ 0.1** for "good", at the 75th percentile <https://web.dev/articles/cls>; **INP ≤ 200 ms** good, *"above 200 milliseconds and below or at 500 milliseconds means a page's responsiveness needs improvement"* <https://web.dev/articles/inp>. Transform/opacity entry animations do not score as layout shift; main-thread work during data refresh shows up as input delay.
- **[VENDOR]** `will-change` is a last resort: *"Use the `will-change` property as a last resort to try to deal with existing performance problems. Don't use it to anticipate performance problems."* It applies to the whole subtree, *"so applying a non-`auto` value on a large section, such as the `<body>`, can actually be bad for a page's performance."* <https://developer.mozilla.org/en-US/docs/Web/CSS/will-change>
- **[STATUS]** `contain` is **Baseline Widely available since March 2022** — *"Containment enables isolating a subsection of the DOM, providing performance benefits by limiting calculations of layout, style, paint, size… to a DOM subtree rather than the entire page."* <https://developer.mozilla.org/en-US/docs/Web/CSS/contain>
- **Not verified:** any quantified claim about skeleton-flash or spinner duration. No W3C/MDN/web.dev page in this pass states a number; treat such claims as folklore absent a primary source.

---

## Implications for Kohlab

1. **[MUST]** Keep the two-layer scheme — raw tokens as custom properties in `:root`, bridged into utilities **only** via `@theme inline`. No `var(...)` alias may sit in a plain `@theme` block. Verified by grep. (<https://tailwindcss.com/docs/theme>)
2. **[MUST]** Set `color-scheme: dark` on `:root` **and** add `<meta name="color-scheme" content="dark">` to `web/index.html` before any stylesheet link, so native scrollbars and form controls render dark with no white flash on load. (<https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme>)
3. **[MUST]** Convert token values from bare HSL triplets to OKLCH so ramps are perceptually uniform, and generate hover/active/selected states with **two-colour** `color-mix(in oklch, …)` (three-or-more-colour `color-mix()` is not Baseline). Every text/background pair must still measure ≥4.5:1 normal / ≥3:1 large in **sRGB**. (<https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/oklch>, <https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html>)
4. **[MUST]** Enforce the tier rule: components consume semantic tokens, semantic tokens alias primitives, nothing outside the primitive layer holds a raw palette literal. Checkable by grepping component code for hex values and primitive token names. (<https://spectrum.adobe.com/page/design-tokens/>)
5. **[MUST]** Restrict every transition and animation to `transform`, `opacity`, `background-color`, `color`, `border-color`. No animation of `width`, `height`, `top`, `left` or `margin`. (<https://web.dev/articles/animations-guide>)
6. **[MUST]** Gate all non-essential motion behind `@media (prefers-reduced-motion: no-preference)`, providing a *reduced* opacity/crossfade alternative rather than `animation: none`, and make the status-dot pulse stoppable or bounded under SC 2.2.2's five-second rule. (<https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion>, <https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html>)
7. **[SHOULD]** Adopt a Carbon-shaped duration scale as tokens — `--duration-fast-01: 70ms`, `--duration-fast-02: 110ms`, `--duration-moderate-01: 150ms`, `--duration-moderate-02: 240ms` — plus two easing tokens (`cubic-bezier(0.2, 0, 0.38, 0.9)` standard, `cubic-bezier(0, 0, 0.38, 0.9)` entrance); no interactive transition above 500 ms. (<https://carbondesignsystem.com/elements/motion/overview/>)
8. **[MUST]** Size the app shell with `height: 100vh` followed by `height: 100dvh` — never `100vh` alone — keeping `overflow: hidden` on the shell and scrolling inside panes, and add `viewport-fit=cover` to the viewport meta tag plus `env(safe-area-inset-*, 0px)` padding on the fixed sidebar/topbar and any bottom bar. (<https://developer.mozilla.org/en-US/docs/Web/CSS/length#viewport_percentage_units>, <https://developer.mozilla.org/en-US/docs/Web/CSS/env>)
9. **[MUST]** Ensure every interactive target is at least 24×24 CSS px at a 320 px viewport — especially icon-only cockpit and collapsed-sidebar buttons — and that page-level horizontal scrolling never appears at 320 px (internal scroll containers only). (<https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html>, <https://www.w3.org/WAI/WCAG22/Understanding/reflow.html>)
10. **[MUST]** Give text-bearing containers `min-height` + padding and no fixed `height`, so the SC 1.4.12 overrides (1.5× line-height, 2× paragraph spacing, 0.12em letter-spacing, 0.16em word-spacing) cannot clip status chips, table rows or toolbar labels. (<https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html>)
11. **[SHOULD]** Make panels responsive with `@container` + `cqi` rather than viewport breakpoints, so the cockpit pane and sidebar-adjacent panels adapt independently; keep media queries for IA changes only (sidebar collapse, tab strip → drawer). (<https://developer.mozilla.org/en-US/docs/Web/CSS/container-type>)
12. **[SHOULD]** Apply `contain: layout paint` to high-churn rows (activity feed, log lines, workspace table) to bound per-row update cost, and use `will-change` only after measuring a real problem — never preemptively, never on `body`. (<https://developer.mozilla.org/en-US/docs/Web/CSS/contain>, <https://developer.mozilla.org/en-US/docs/Web/CSS/will-change>)
13. **[MAY]** Adopt the safely-baseline platform wins where they delete code: native `<dialog>` + `::backdrop` instead of the hand-rolled `.modal-overlay`/`.modal`, the `popover` attribute for lightweight menus, `backdrop-filter` for a real frosted topbar, and same-document View Transitions (feature-detected via `document.startViewTransition`) for tab switches. (<https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog>, <https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition>)
14. **[MUST]** Do **not** ship as load-bearing behaviour any feature from the "needs a fallback or should be skipped" list in §4 — `text-wrap: pretty`, `field-sizing`, CSS anchor positioning, scroll-driven animations, `interpolate-size`/`calc-size`, `@scope`, cross-document View Transitions. If used as an enhancement it must degrade with no layout or content loss. (<https://developer.mozilla.org/en-US/docs/Web/CSS/interpolate-size>, <https://developer.mozilla.org/en-US/docs/Web/CSS/animation-timeline>, <https://developer.mozilla.org/en-US/docs/Web/CSS/@view-transition>)
15. **[MAY]** Export the token set as a DTCG `.tokens.json` file if a designer joins, using the stable **2025.10** module — not the preview draft — and treat it purely as an interchange artefact that never becomes the runtime source of truth. (<https://www.designtokens.org/TR/2025.10/format/>)

### Contested or unverified in this brief

- **CSS anchor positioning:** MDN's `anchor()` page claims Baseline 2026 newly available while the `anchor-positioning` feature in web-features v3.38.0 is not baseline. Both fetched 2026-09-16 → do not adopt; Radix covers current needs.
- **Gamut mapping** of out-of-sRGB OKLCH is specified in CSS Color 4 §14 across several candidate algorithms; exact rendering at high chroma is not guaranteed identical across engines. Verify in sRGB.
- **`popover` baseline date** differs between MDN's badge (2024) and web-features (2025-01-27, gated by iOS Safari 18.3).
- **Material 3 and Salesforce Lightning tier naming** could not be verified — JS-only docs sites return no body text to a non-browser fetch. Material/Apple motion quotes were read through a reader proxy over the same URLs, not a full browser render.
- **`env(keyboard-inset-*)`** not verified in this pass.
- **No primary source** quantifies skeleton-flash or spinner durations; any such claim is folklore.
- **APCA** is outside this brief's verified scope; WCAG 2.2 conformance is defined by the 4.5:1 / 3:1 ratio requirements cited above.
