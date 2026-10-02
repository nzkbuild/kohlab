/**
 * Copy text to the clipboard, including over plain http.
 *
 * `navigator.clipboard` only exists in a secure context (https or localhost).
 * A self-hosted box reached by IP or a LAN name is neither, so the async API is
 * undefined there and every copy used to fail silently. The fallback is the
 * legacy execCommand path, which still works from a user gesture.
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* permission denied or document not focused: try the fallback */
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  const active = document.activeElement as HTMLElement | null;
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  active?.focus();
  if (!ok) throw new Error("the browser refused to copy");
}
