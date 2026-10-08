import type { ActiveViewAs } from "@/lib/auth/view-as.server";

/**
 * Structural check (no runtime import, nothing to mock) for the synthetic user
 * `createSupabaseServerClient().auth.getUser()` returns while a verified "View
 * as" session is open. A route that must read the viewed account's rows with
 * the service role, because the session client's RLS would answer for the
 * operator, asks this.
 */
export function viewAsOfUser(user: unknown): ActiveViewAs | null {
  if (!user || typeof user !== "object") return null;
  return (user as { __viewAs?: ActiveViewAs }).__viewAs ?? null;
}
