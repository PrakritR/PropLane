/**
 * Primary PropLane admin (ops) identity — keep in sync with
 * scripts/ensure-admin-account.mjs and scripts/purge-extra-portal-accounts.mjs.
 *
 * Admin access itself is role-based (any `admin`-role account; see admin-role.ts);
 * this email is an always-admin fallback and the self-registration/provisioning
 * gate.
 *
 * Captain 2026-09-16: `founders@axis-seattle-housing.com` is the admin account.
 * `prakritramachandran@gmail.com` is a manager only — it must not match this
 * value. `filterAdminUserIds` grants admin on `profiles.email` matching this
 * address, and that column carries no unique constraint, so it must never be
 * set to an address a stranger could self-register.
 */
export const PRIMARY_ADMIN_EMAIL = "founders@axis-seattle-housing.com";

export function normalizeAdminEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

export function isPrimaryAdminEmail(email: string | null | undefined): boolean {
  return normalizeAdminEmail(email) === PRIMARY_ADMIN_EMAIL;
}

/**
 * The primary admin's verified mobile (captain, Nov 12). It is the number PropLane texts the primary admin on; it is NOT an
 * identity check, because profiles may share a number (`profiles.phone` has no unique constraint), so a phone match alone
 * never makes anyone the primary admin. `userIsPrimaryAdmin` (admin-team) decides on the confirmed sign-in email.
 */
export const PRIMARY_ADMIN_PHONE_E164 = "+15103098345";
