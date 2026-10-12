import { ADMIN_OVERSIGHT_PARAM, ADMIN_OVERSIGHT_VALUE } from "@/lib/auth/admin-oversight-shared";

/**
 * Client half of admin oversight (`admin-oversight.server.ts`). Pages under `/admin` read every
 * owner's records, so their fetches carry `?oversight=admin`; the manager portal never does, which
 * keeps a platform admin's own workspace scoped like any manager's. The server still confirms the
 * admin role, so this is a request for the surface, never the authorization.
 */
export function isAdminPortalPath(): boolean {
  if (typeof window === "undefined") return false;
  const pathname = window.location?.pathname;
  return typeof pathname === "string" && (pathname === "/admin" || pathname.startsWith("/admin/"));
}

/** `url` with `oversight=admin` appended when called from an admin page; unchanged elsewhere. */
export function adminOversightUrl(url: string): string {
  if (!isAdminPortalPath()) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${ADMIN_OVERSIGHT_PARAM}=${ADMIN_OVERSIGHT_VALUE}`;
}
