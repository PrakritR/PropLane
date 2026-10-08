/** Matches the portal shell's `lg` breakpoint (1024px): below it the assistant is a full-screen sheet. */
export const ASSISTANT_SHEET_VIEWPORT_QUERY = "(max-width: 1023px)";

/**
 * One-shot, non-reactive read for imperative code (the assistant open store).
 * Without `matchMedia` (SSR, bare test DOMs) it answers "small", the one place
 * the assistant can always render.
 */
export function isAssistantSheetViewportNow(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(ASSISTANT_SHEET_VIEWPORT_QUERY).matches;
}
