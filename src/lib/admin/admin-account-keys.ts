/**
 * Client-safe helpers for an admin account's URL key (`<kind>-<id>`), its
 * record-page rail sections and the existing per-kind admin API routes.
 */
export type AdminAccountRowKind = "manager" | "resident" | "vendor";

export const ADMIN_ACCOUNT_ROW_KINDS: readonly AdminAccountRowKind[] = ["manager", "resident", "vendor"];

/** The existing enable / disable / delete routes, one per kind. */
export const ADMIN_ACCOUNT_API_PATH: Record<AdminAccountRowKind, string> = {
  manager: "/api/admin/managers",
  resident: "/api/admin/residents",
  vendor: "/api/admin/vendors",
};

export const ADMIN_ACCOUNT_ROLE_LABEL: Record<AdminAccountRowKind, string> = {
  manager: "Manager",
  resident: "Resident",
  vendor: "Vendor",
};

/** `<kind>-<id>` — also the record page's URL segment. */
export function adminAccountKey(kind: AdminAccountRowKind, id: string): string {
  return `${kind}-${id}`;
}

/** The inverse of {@link adminAccountKey}. `kind` never contains a hyphen, so the first one splits. */
export function parseAdminAccountKey(key: string): { kind: AdminAccountRowKind; id: string } | null {
  const idx = key.indexOf("-");
  if (idx <= 0) return null;
  const kind = key.slice(0, idx);
  const id = key.slice(idx + 1);
  if (!id || !(ADMIN_ACCOUNT_ROW_KINDS as readonly string[]).includes(kind)) return null;
  return { kind: kind as AdminAccountRowKind, id };
}

/** The list tab (`?category=`) an account kind lives under. Managers keep their historical `management` slug. */
export function adminAccountCategory(kind: AdminAccountRowKind): "management" | "resident" | "vendor" {
  return kind === "manager" ? "management" : kind;
}

export const ADMIN_ACCOUNT_SECTION_IDS = [
  "overview",
  "workspaces",
  "billing",
  "payments",
  "communication",
  "audit",
  "support",
] as const;
export type AdminAccountSectionId = (typeof ADMIN_ACCOUNT_SECTION_IDS)[number];

export type AdminAccountRailGroup = { label: string; ids: AdminAccountSectionId[] };

/** Account · Money · Activity. Money (plan and payouts) is a manager's; residents and vendors have no such rail group. */
export function adminAccountRail(kind: AdminAccountRowKind): {
  groups: AdminAccountRailGroup[];
  labels: Record<AdminAccountSectionId, string>;
} {
  const labels: Record<AdminAccountSectionId, string> = {
    overview: "Overview",
    workspaces: "Workspaces & roles",
    billing: "Billing & plan",
    payments: "Payments",
    communication: "Communication log",
    audit: "Audit trail",
    support: "Support",
  };
  const groups: AdminAccountRailGroup[] = [{ label: "Account", ids: ["overview", "workspaces"] }];
  if (kind === "manager") groups.push({ label: "Money", ids: ["billing", "payments"] });
  groups.push({ label: "Activity", ids: ["communication", "audit", "support"] });
  return { groups, labels };
}

/** `?section=` / the second path segment, clamped to a section this kind actually has. */
export function adminAccountSectionFromParam(raw: string | null | undefined, kind: AdminAccountRowKind): AdminAccountSectionId {
  const allowed = adminAccountRail(kind).groups.flatMap((g) => g.ids);
  return (allowed as string[]).includes(raw ?? "") ? (raw as AdminAccountSectionId) : "overview";
}

export function adminAccountSectionHref(kind: AdminAccountRowKind, id: string, section: AdminAccountSectionId): string {
  const base = `/admin/axis-users/${encodeURIComponent(adminAccountKey(kind, id))}`;
  return section === "overview" ? base : `${base}/${section}`;
}
