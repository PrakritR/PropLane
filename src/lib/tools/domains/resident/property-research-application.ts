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

/** Match the resident placement precedence before the original application choice. */
export function applicationPropertyIds(application: ApplicationRecord): string[] {
  const row = record(application.row_data);
  const nested = record(row?.application);
  return [...new Set([
    application.assigned_property_id,
    row?.assignedPropertyId,
    application.property_id,
    row?.propertyId,
    nested?.propertyId,
  ].map(id).filter((value): value is string => Boolean(value)))];
}
