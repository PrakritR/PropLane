/**
 * The resident Forms section's addresses: `/resident/forms` (Pending), `/resident/forms/completed`, and
 * `/resident/forms/<formId>` (one form: fill it out, or read it once submitted).
 */
export const RESIDENT_FORMS_BUCKETS = ["pending", "completed"] as const;
export type ResidentFormsBucket = (typeof RESIDENT_FORMS_BUCKETS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isResidentFormId(raw: string | undefined | null): raw is string {
  return UUID.test(raw ?? "");
}

export function parseResidentFormsBucket(raw: string | undefined | null): ResidentFormsBucket | null {
  return raw && (RESIDENT_FORMS_BUCKETS as readonly string[]).includes(raw) ? (raw as ResidentFormsBucket) : null;
}

export function residentFormsListHref(basePath: string, bucket: ResidentFormsBucket = "pending"): string {
  return bucket === "pending" ? `${basePath}/forms` : `${basePath}/forms/${bucket}`;
}

/** One form's direct link; with no id (or a malformed one) the list. */
export function residentFormHref(basePath: string, formId?: string | null): string {
  return isResidentFormId(formId) ? `${basePath}/forms/${formId}` : residentFormsListHref(basePath);
}
