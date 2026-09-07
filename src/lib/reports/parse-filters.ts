import type { DocumentScope, ManagerReportFilters } from "@/lib/reports/types";

export function parseManagerReportFilters(searchParams: URLSearchParams): ManagerReportFilters {
  const scope = searchParams.get("scope")?.trim() as DocumentScope | undefined;
  return {
    propertyId: searchParams.get("propertyId")?.trim() || undefined,
    from: searchParams.get("from")?.trim() || undefined,
    to: searchParams.get("to")?.trim() || undefined,
    daysAhead: searchParams.get("daysAhead") ? Number(searchParams.get("daysAhead")) : undefined,
    taxYear: searchParams.get("taxYear") ? Number(searchParams.get("taxYear")) : undefined,
    vendorId: searchParams.get("vendorId")?.trim() || undefined,
    scope: scope && ["portfolio", "property", "tenant", "room"].includes(scope) ? scope : undefined,
    residentEmail: searchParams.get("residentEmail")?.trim() || undefined,
    roomLabel: searchParams.get("roomLabel")?.trim() || undefined,
    groupBy: searchParams.get("groupBy")?.trim() || undefined,
  };
}

export function resolveDocumentScope(filters: ManagerReportFilters): DocumentScope {
  if (filters.scope) return filters.scope;
  if (filters.roomLabel?.trim()) return "room";
  if (filters.residentEmail?.trim()) return "tenant";
  if (filters.propertyId?.trim()) return "property";
  return "portfolio";
}
