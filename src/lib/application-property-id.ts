/**
 * The ONE house an application row names, by precedence: the `assigned_property_id` column, then
 * `property_id`, then the payload's `assignedPropertyId`, `propertyId` and nested
 * `application.propertyId`. The first non-empty wins; the rest are stale copies of an earlier
 * answer, not alternatives.
 *
 * Every reader has to agree on that order. A reader that instead UNIONS the five locations accepts
 * any house the row has ever named: a residency whose authoritative column says house A but whose
 * nested intake payload still says house B would admit house B, widening a per-house scope check
 * (`residentSubjectHasHouse`) and a per-house subject binding (`boundResidentSubjectForManagerHouse`)
 * to a property the resident is not placed at.
 */
export type ApplicationPropertyRow = {
  property_id?: unknown;
  assigned_property_id?: unknown;
  row_data?: unknown;
};

export function applicationPropertyId(row: ApplicationPropertyRow): string {
  const fromColumns =
    String(row.assigned_property_id ?? "").trim() || String(row.property_id ?? "").trim();
  if (fromColumns) return fromColumns;
  const data = (row.row_data ?? {}) as Record<string, unknown>;
  const nested = (data.application ?? {}) as Record<string, unknown>;
  return (
    String(data.assignedPropertyId ?? "").trim() ||
    String(data.propertyId ?? "").trim() ||
    String(nested.propertyId ?? "").trim()
  );
}
