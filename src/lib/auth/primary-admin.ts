/**
 * Primary PropLane admin (ops) identity — keep in sync with
 * scripts/ensure-admin-account.mjs and scripts/purge-extra-portal-accounts.mjs.
 *
 * Admin access itself is role-based (any `admin`-role account; see admin-role.ts);
 * this email is an always-admin fallback and the self-registration/provisioning
 * gate.
 *
 * Moved off founders@axis-seattle-housing.com on the captain's instruction: this
 * is now the ONLY admin account. Note the consequence — `filterAdminUserIds`
 * grants admin on `profiles.email` matching this value, and that column carries
 * no unique constraint, so changing it changes who is admin. It must never be
 * set to an address a stranger could self-register.
 */
export const PRIMARY_ADMIN_EMAIL = "prakritramachandran@gmail.com";

export function normalizeAdminEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

export function isPrimaryAdminEmail(email: string | null | undefined): boolean {
  return normalizeAdminEmail(email) === PRIMARY_ADMIN_EMAIL;
}
