import type { ManagerReportFilters } from "@/lib/reports/types";

/**
 * PostgREST's `in.()` for an empty list is not portable, so a scope that holds
 * no houses matches this sentinel instead — it can never be a real record id.
 */
const NO_WORKSPACE_PROPERTY = "__no-workspace-property__";

/**
 * The houses a manager report may read: the active workspace (resolved on the
 * server, see `@/lib/workspaces/scope.server`) narrowed further by an explicit
 * property filter. `null` means no narrowing at all; an EMPTY ARRAY means the
 * workspace holds no houses, so the report covers nothing.
 */
export function reportPropertyScope(
  filters: ManagerReportFilters,
  propertyId?: string,
): string[] | null {
  const explicit = (propertyId ?? filters.propertyId)?.trim() || undefined;
  const workspace = filters.workspacePropertyIds ?? null;
  if (!workspace) return explicit ? [explicit] : null;
  if (!explicit) return workspace;
  return workspace.includes(explicit) ? [explicit] : [];
}

/** Narrow a PostgREST query to the report's property scope. Never widens it. */
export function applyReportPropertyScope<Q extends { in(column: string, values: string[]): Q }>(
  query: Q,
  filters: ManagerReportFilters,
  propertyId?: string,
  column = "property_id",
): Q {
  const scope = reportPropertyScope(filters, propertyId);
  if (!scope) return query;
  return query.in(column, scope.length > 0 ? scope : [NO_WORKSPACE_PROPERTY]);
}

/** True when the scope covers no house at all, so the caller can skip the read. */
export function reportScopeIsEmpty(filters: ManagerReportFilters, propertyId?: string): boolean {
  const scope = reportPropertyScope(filters, propertyId);
  return scope !== null && scope.length === 0;
}

/** The same test for rows already in memory, including rows with no house. */
export function reportRowInScope(
  filters: ManagerReportFilters,
  rowPropertyId: string | null | undefined,
  propertyId?: string,
): boolean {
  const scope = reportPropertyScope(filters, propertyId);
  if (!scope) return true;
  const id = rowPropertyId?.trim();
  return Boolean(id) && scope.includes(id!);
}

/**
 * Narrow one property scope by another. Both sides already follow the same
 * "`null` = no narrowing, empty array = covers nothing" contract (the active
 * workspace's houses, and a co-manager's per-property module grant), so
 * combining them is a plain set intersection — order doesn't matter. Used to
 * fold a co-manager's `financials` grant (`resolveManagerReportScope`) into
 * the workspace scope before it reaches `filters.workspacePropertyIds`, so a
 * report query can never read a house the grant does not cover, no matter how
 * many scopes are narrowing it at once.
 */
export function intersectPropertyScopes(a: string[] | null, b: string[] | null): string[] | null {
  if (!a) return b;
  if (!b) return a;
  const bSet = new Set(b);
  return a.filter((id) => bSet.has(id));
}
