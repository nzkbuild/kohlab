/**
 * Resolve a semantic token to a hex colour a third-party widget can parse.
 *
 * xterm and Monaco take JS colour values, and the tokens are OKLCH custom
 * properties: so the browser does the conversion (paint one pixel, read it back)
 * rather than a literal being pasted into a component. Rounded through 8-bit
 * RGB, which is all either widget can express anyway. `#rrggbbaa` when alpha < 1.
 */
export function tokenColor(el: Element, token: string, alpha = 1): string | undefined {
  const raw = getComputedStyle(el).getPropertyValue(token).trim();
  if (!raw) return undefined;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return undefined;
  ctx.fillStyle = raw;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}${alpha < 1 ? hex(Math.round(alpha * 255)) : ""}`;
}

/** The mono stack from the tokens, for widgets that take a font-family string. */
export function monoFont(el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue("--font-mono").trim() || "monospace";
}
