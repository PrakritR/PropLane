import { SIDEBAR_COLLAPSED_COOKIE } from "@/lib/portal-sidebar-cookie";

/**
 * One shared "is the desktop sidebar collapsed" value. The collapse control
 * lives in the top strip (left end) while the sidebar itself is a sibling
 * column, so the two read and write the same store instead of passing state
 * through the layout. The server's cookie value seeds both (`initial`), the
 * first toggle takes over, and every change is written back to the cookie and
 * to `<html data-portal-sidebar-collapsed>` exactly as the sidebar did before.
 */
type Listener = () => void;

let override: boolean | null = null;
const listeners = new Set<Listener>();

export function getPortalSidebarCollapsed(initial: boolean): boolean {
  return override ?? initial;
}

export function subscribePortalSidebarCollapsed(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function apply(next: boolean) {
  if (typeof document === "undefined") return;
  if (next) document.documentElement.setAttribute("data-portal-sidebar-collapsed", "");
  else document.documentElement.removeAttribute("data-portal-sidebar-collapsed");
}

/** Mirror the resolved value onto `<html>` (called by the sidebar on mount and on change). */
export function syncPortalSidebarCollapsedAttribute(value: boolean): void {
  apply(value);
}

export function setPortalSidebarCollapsed(next: boolean): void {
  override = next;
  apply(next);
  if (typeof document !== "undefined") {
    document.cookie = `${SIDEBAR_COLLAPSED_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  }
  for (const listener of listeners) listener();
}

export function togglePortalSidebarCollapsed(initial: boolean): void {
  setPortalSidebarCollapsed(!getPortalSidebarCollapsed(initial));
}

/** Test helper: forget the in-memory value. */
export function resetPortalSidebarCollapsedForTests(): void {
  override = null;
  listeners.clear();
}
