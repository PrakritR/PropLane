export const THEME_STORAGE_KEY = "axis:theme";

export type Theme = "light" | "dark";

/**
 * Captain 2026-09-25: dark mode is off across the product for now — the
 * Appearance control is hidden (portal-top-bar.tsx, resident-profile-panel.tsx,
 * portal-profile-client.tsx, portal-settings-extras.tsx) and the app always
 * renders light, regardless of a stored preference, `SurfaceThemeDefault`, or
 * a stray `setTheme("dark")` call. Flip this one constant back to `true` to
 * restore it — the dark CSS tokens and every gated call site stay in place.
 */
export const DARK_MODE_ENABLED = false;

/**
 * Routes where users may persist and toggle light/dark (signed-in surfaces).
 * Pure route matching, unconditional — nothing currently calls this to
 * decide whether to render a control (that gate lives at each Appearance
 * row's call site instead), so it is left alone rather than doubly gated.
 */
export function isThemeToggleRoute(pathname: string): boolean {
  return /^\/(portal|resident|admin|vendor|auth)(\/|$)/.test(pathname);
}

export function readStoredTheme(fallback: Theme = "light"): Theme {
  if (!DARK_MODE_ENABLED) return "light";
  if (typeof window === "undefined") return fallback;
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return fallback;
}

export function applyDocumentTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", DARK_MODE_ENABLED ? theme : "light");
}
