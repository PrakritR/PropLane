/**
 * Who may read the staff-only Internal section of a house (pantry, lockbox and mailbox codes, notes).
 *
 * Decision (captain, Oct 28): managers with Properties access and PropLane staff/admin. Never a
 * resident, guest, owner viewer, vendor, the public page, a printable, or any outbound message,
 * post or agent tool. The section is removed from the DATA a non-staff reader is sent
 * (`houseInfoWithoutInternal`); hiding it in the markup is not a control.
 *
 * Pure (no server imports) so the property-records route and its test share one rule.
 */
import { HOUSE_INTERNAL_SECTION_ID } from "@/lib/house-info";

type Json = Record<string, unknown>;

function asJson(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function submissionWithoutInternal(sub: unknown): unknown {
  const record = asJson(sub);
  const info = asJson(record?.houseInfo);
  if (!record || !info || !(HOUSE_INTERNAL_SECTION_ID in info)) return sub;
  const { [HOUSE_INTERNAL_SECTION_ID]: _dropped, ...rest } = info;
  void _dropped;
  return { ...record, houseInfo: rest };
}

function containerWithoutInternal(container: unknown): unknown {
  const record = asJson(container);
  if (!record) return container;
  let next: Json | null = null;
  for (const key of ["submission", "listingSubmission"] as const) {
    if (!(key in record)) continue;
    const cleaned = submissionWithoutInternal(record[key]);
    if (cleaned !== record[key]) {
      next = next ?? { ...record };
      next[key] = cleaned;
    }
  }
  return next ?? container;
}

/**
 * A stored property record with the Internal section taken out of both places a listing submission
 * lives (`row_data.submission`, `property_data.listingSubmission`). Same object back when there is
 * nothing to remove.
 */
export function propertyRecordWithoutInternal<T extends { row_data?: unknown; property_data?: unknown }>(row: T): T {
  const rowData = containerWithoutInternal(row.row_data);
  const propertyData = containerWithoutInternal(row.property_data);
  if (rowData === row.row_data && propertyData === row.property_data) return row;
  return { ...row, row_data: rowData, property_data: propertyData };
}
