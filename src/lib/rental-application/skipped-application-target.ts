/**
 * A row `GET /api/manager-applications` left out because opening it threw.
 * Only the fields that identify WHICH application it was — never identity.
 */
export type SkippedApplicationTarget = {
  id: string;
  /** House column, or the raw application, when either was readable. */
  propertyId?: string;
  /** `application` on the stored row was an object, so room / bundle / term were readable. */
  applicationRead?: boolean;
  rentalType?: string;
  roomChoice1?: string;
  bundleId?: string;
};

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Hints from a stored record that failed to open. Does not copy the application body. */
export function skippedApplicationTargetFromRecord(record: {
  id: string;
  row_data?: unknown;
  property_id?: string | null;
  assigned_property_id?: string | null;
}): SkippedApplicationTarget {
  const row =
    record.row_data && typeof record.row_data === "object" && !Array.isArray(record.row_data)
      ? (record.row_data as Record<string, unknown>)
      : null;
  const application =
    row?.application && typeof row.application === "object" && !Array.isArray(row.application)
      ? (row.application as Record<string, unknown>)
      : null;
  const propertyId =
    str(record.property_id) || str(record.assigned_property_id) || str(row?.propertyId) || str(application?.propertyId);
  const target: SkippedApplicationTarget = { id: record.id };
  if (propertyId) target.propertyId = propertyId;
  if (application) {
    target.applicationRead = true;
    const rentalType = str(application.rentalType);
    if (rentalType) target.rentalType = rentalType;
    const roomChoice1 = str(application.roomChoice1);
    if (roomChoice1) target.roomChoice1 = roomChoice1;
    const bundleId = str(application.bundleId);
    if (bundleId) target.bundleId = bundleId;
  }
  return target;
}

/** Client parse of `skippedRows`. Drops anything that is not a target hint. */
export function parseSkippedApplicationTargets(raw: unknown): SkippedApplicationTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: SkippedApplicationTarget[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = str(record.id);
    if (!id) continue;
    const target: SkippedApplicationTarget = { id };
    const propertyId = str(record.propertyId);
    if (propertyId) target.propertyId = propertyId;
    if (record.applicationRead === true) target.applicationRead = true;
    const rentalType = str(record.rentalType);
    if (rentalType) target.rentalType = rentalType;
    const roomChoice1 = str(record.roomChoice1);
    if (roomChoice1) target.roomChoice1 = roomChoice1;
    const bundleId = str(record.bundleId);
    if (bundleId) target.bundleId = bundleId;
    out.push(target);
  }
  return out;
}
