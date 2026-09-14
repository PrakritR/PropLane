/**
 * Who the "Block dates" sheet can hold a room for.
 *
 * The list is every person on the manager's lease pipeline — the same rows the
 * calendar already draws stays from — grouped by identity with the rule the
 * Residents, Tours, and Payments lists share (`clusterRowsByResident`), so a
 * person on two leases is one row here too. Voided leases are skipped: the
 * person may well be gone, and if not they are on a live row as well.
 */

import { clusterRowsByResident } from "@/lib/resident-row-clustering";
import { parseRoomChoiceValue } from "@/lib/rental-application/data";

export type BlockDatesResidentOption = {
  /** Identity key (`email:` / `name:` / `id:`), the select's value. */
  key: string;
  name: string;
  email: string;
  /** "Room 3 · 4709A 8th Ave NE" — where they are, for telling two Alexes apart. */
  meta: string;
};

/** Structural subset of `LeasePipelineRow` this module reads. */
export type BlockDatesResidentSourceRow = {
  id: string;
  residentName?: string | null;
  residentEmail?: string | null;
  propertyId?: string | null;
  roomChoice?: string | null;
  voidedAt?: string | null;
};

export function blockDatesResidentOptions(
  rows: readonly BlockDatesResidentSourceRow[],
  opts: {
    propertyLabelForId: (propertyId: string) => string;
    roomLabelForId: (propertyId: string, roomId: string) => string;
  },
): BlockDatesResidentOption[] {
  const live = rows.filter((row) => !row.voidedAt && (row.residentName?.trim() || row.residentEmail?.trim()));
  const clusters = clusterRowsByResident(live);
  const out: BlockDatesResidentOption[] = [];
  for (const cluster of clusters) {
    const first = cluster.rows[0]!;
    const propertyId = first.propertyId?.trim() ?? "";
    const roomId = parseRoomChoiceValue(first.roomChoice ?? "").listingRoomId ?? "";
    const meta = [
      propertyId && roomId ? opts.roomLabelForId(propertyId, roomId) : "",
      propertyId ? opts.propertyLabelForId(propertyId) : "",
    ]
      .filter(Boolean)
      .join(" · ");
    out.push({
      key: cluster.key,
      name: cluster.residentLabel,
      email: cluster.residentEmail?.toLowerCase() ?? "",
      meta,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
