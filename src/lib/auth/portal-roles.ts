export type AuthRole = "resident" | "manager" | "admin" | "vendor";

function isAuthRole(value: string): value is AuthRole {
  return value === "resident" || value === "manager" || value === "admin" || value === "vendor";
}

function mapLegacyPortalRole(role: string | null | undefined): AuthRole | null {
  const value = String(role ?? "").toLowerCase();
  if (value === "owner") return "manager";
  return isAuthRole(value) ? value : null;
}

/** Merge profile_roles with legacy profiles.role (owner → manager). Client-safe. */
export function normalizePortalRoles(
  rows: { role: string }[] | null | undefined,
  fallbackRole: string | null | undefined,
): AuthRole[] {
  const fromTable = (rows ?? [])
    .map((r) => (r.role === "owner" ? "manager" : r.role))
    .filter((r): r is AuthRole => isAuthRole(r));
  const unique = [...new Set(fromTable)];
  if (unique.length > 0) return unique;
  const mappedFallback = mapLegacyPortalRole(fallbackRole);
  if (mappedFallback) return [mappedFallback];
  return [];
}

/** Default dashboard route after sign-in / create-account. */
export function portalDashboardPath(role: AuthRole): string {
  if (role === "resident") return "/resident";
  if (role === "manager") return "/portal/dashboard";
  if (role === "vendor") return "/vendor/dashboard";
  return "/admin/dashboard";
}

export function parseAuthRole(value: string | null): AuthRole {
  if (value === "resident" || value === "manager" || value === "admin" || value === "vendor") return value;
  return "resident";
}
