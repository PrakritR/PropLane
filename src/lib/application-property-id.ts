/**
 * The ONE house an application row names, by precedence: the `assigned_property_id` column, then
 * the payload's `assignedPropertyId`, then the `property_id` column, then the payload's
 * `propertyId` and nested `application.propertyId`. The first non-empty wins; the rest are stale
 * copies of an earlier answer, not alternatives.
 *
 * That order is the SQL's, exactly: `insert_bound_move_in_form` and `bind_resident_setup_subject`
 * (`20261030144800_bind_move_in_form_subject.sql`) both coalesce
 * `assigned_property_id, row_data->>'assignedPropertyId', property_id, row_data->>'propertyId',
 * row_data#>>'{application,propertyId}'`, and `residencyFromRecord` reads the same five in the same
 * sequence. A reader that ranked the `property_id` column above `row_data.assignedPropertyId` would
 * answer house A for a legacy row the database binds to house B: the resident would be denied where
 * they are placed and admitted where they are not, while a legitimate send raised 23514.
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
  const data = (row.row_data ?? {}) as Record<string, unknown>;
  const nested = (data.application ?? {}) as Record<string, unknown>;
  return (
    String(row.assigned_property_id ?? "").trim() ||
    String(data.assignedPropertyId ?? "").trim() ||
    String(row.property_id ?? "").trim() ||
    String(data.propertyId ?? "").trim() ||
    String(nested.propertyId ?? "").trim()
  );
}
