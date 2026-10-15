/** Mac shows ⌘ where other platforms say Ctrl. */
export const isApple = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
