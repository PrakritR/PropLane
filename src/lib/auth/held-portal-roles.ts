/**
 * The portals a login HOLDS, for the account-lifecycle paths that decide what a portal removal
 * leaves behind (`removePortalAccess`, `deleteOwnPortalAccount`, `canHardDeleteResident`).
 *
 * Stored `profile_roles` rows are the whole answer. The legacy singular `profiles.role` is never
 * added to them: it is the role the account was CREATED as and keeps forever, so unioning it in
 * invented a portal the account does not hold — an `admin`-only account whose legacy label still
 * read `resident` looked like it held the resident portal, which both let a resident delete be
 * authorized against it and left its login standing after its real portal was removed, against
 * `AGENTS.md` § "Deleting an account must leave the email reusable".
 *
 * An account with NO stored role at all is the one case the legacy column still answers: it
 * predates `profile_roles` (or its backfill never ran), and reading the stored rows alone reported
 * "no role to remove", so the data was purged and the login and its address survived. There the
 * legacy value SUBSTITUTES for the empty list rather than adding to it.
 */
export function heldPortalRoles(
  storedRoles: readonly { role?: unknown }[] | null | undefined,
  legacyRole: unknown,
): string[] {
  const stored = (storedRoles ?? [])
    .map((row) => String(row?.role ?? "").trim().toLowerCase())
    .filter(Boolean);
  if (stored.length > 0) return [...new Set(stored)];
  const legacy = String(legacyRole ?? "").trim().toLowerCase();
  return legacy ? [legacy] : [];
}
