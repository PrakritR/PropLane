/**
 * The resident portal's two sections (captain, Oct 3): LONG TERM (today's flow)
 * and SHORT TERM (a short-stay application -> lease -> payments run through the
 * same process). One pure decision of "which section is this record in" so the
 * Application, Lease and Payments lists can never disagree about it.
 *
 * The term of a record is the application's `rentalType`: `short_term` is a
 * short stay, anything else (including absent) is long term. A charge carries
 * its application's id, so it follows that application; a `stay_total` charge
 * is a short stay by definition.
 */

export type ResidentTerm = "long_term" | "short_term";

export const RESIDENT_TERM_ORDER: readonly ResidentTerm[] = ["long_term", "short_term"];

export const RESIDENT_TERM_LABELS: Record<ResidentTerm, string> = {
  long_term: "Long term",
  short_term: "Short term",
};

export function residentTermOfRentalType(rentalType: string | null | undefined): ResidentTerm {
  return rentalType === "short_term" ? "short_term" : "long_term";
}

type WithRentalType = {
  rentalType?: string | null;
  application?: { rentalType?: string | null } | null;
};

/** An application row, or a lease pipeline row (its own `rentalType`, else its application's). */
export function residentTermOfRecord(record: WithRentalType | null | undefined): ResidentTerm {
  if (!record) return "long_term";
  return residentTermOfRentalType(record.application?.rentalType ?? record.rentalType);
}

function applicationKey(id: string | null | undefined): string {
  return (id ?? "").trim().toUpperCase();
}

/** application id -> term, for charges to look their section up by `applicationId`. */
export function residentTermByApplicationId(
  rows: ReadonlyArray<WithRentalType & { id?: string | null }>,
): Map<string, ResidentTerm> {
  const map = new Map<string, ResidentTerm>();
  for (const row of rows) {
    const key = applicationKey(row.id);
    if (key) map.set(key, residentTermOfRecord(row));
  }
  return map;
}

export function residentTermOfCharge(
  charge: { kind?: string | null; applicationId?: string | null },
  termByApplicationId: ReadonlyMap<string, ResidentTerm>,
): ResidentTerm {
  if (charge.kind === "stay_total") return "short_term";
  return termByApplicationId.get(applicationKey(charge.applicationId)) ?? "long_term";
}

export function countByResidentTerm<T>(
  items: readonly T[],
  termOf: (item: T) => ResidentTerm,
): Record<ResidentTerm, number> {
  const counts: Record<ResidentTerm, number> = { long_term: 0, short_term: 0 };
  for (const item of items) counts[termOf(item)] += 1;
  return counts;
}

/** `?term=short` / `short_term` / `long` / `long_term`. */
export function parseResidentTermParam(raw: string | null | undefined): ResidentTerm | undefined {
  const value = (raw ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (value === "short" || value === "short_term") return "short_term";
  if (value === "long" || value === "long_term") return "long_term";
  return undefined;
}

/**
 * The section a list opens on: the one the resident asked for, else long term
 * (today's flow) - unless long term is empty and short term is not, so a guest
 * with only a short stay never lands on an empty list.
 */
export function defaultResidentTerm(
  counts: Record<ResidentTerm, number>,
  preferred?: ResidentTerm,
): ResidentTerm {
  if (preferred) return preferred;
  if (counts.long_term === 0 && counts.short_term > 0) return "short_term";
  return "long_term";
}

/** Short-term tabs appear on Lease and Payments only once the resident has a short stay there. */
export function residentHasShortTermRecords(counts: Record<ResidentTerm, number>): boolean {
  return counts.short_term > 0;
}
