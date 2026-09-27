type ApplicationRecord = {
  property_id?: unknown;
  assigned_property_id?: unknown;
  row_data?: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function id(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A placement has one effective property. Stale original choices are not grants. */
export function applicationPropertyId(application: ApplicationRecord): string | null {
  const row = record(application.row_data);
  const nested = record(row?.application);
  return id(application.assigned_property_id)
    ?? id(application.property_id)
    ?? id(row?.assignedPropertyId)
    ?? id(row?.propertyId)
    ?? id(nested?.propertyId);
}
