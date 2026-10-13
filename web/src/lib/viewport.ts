/** Phone: below 768px. Matches the `max-md:` Tailwind variant and the phone rules in index.css. */
export const PHONE_QUERY = "(max-width: 47.9375rem)";

export function isPhone(): boolean {
  return window.matchMedia(PHONE_QUERY).matches;
}
