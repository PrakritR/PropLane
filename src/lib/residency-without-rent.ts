/**
 * A signed lease whose resident has never been billed rent: the owner alert for "$0 paid, $0 charged".
 *
 * Rent follows the lease (`charges-follow-the-lease`): the monthly schedule is generated only once the lease is
 * executed, so a signed lease with NO rent charge at all - paid, pending, or cancelled - is not "waiting", it is a
 * residency nobody is billing (a generator that could not price the room, a lease signed outside PropLane, a deleted
 * schedule). Money silently not flowing is the loud kind of problem, so this feeds the manager's Needs-attention queue
 * as a danger row instead of leaving it to be noticed on a bank statement.
 *
 * Pure and client-safe. The grace period exists because generation runs on the manager's next portal load after a
 * signature, so a lease signed minutes ago legitimately has no charges yet.
 */

/** Kinds that are the resident's rent (any status counts: a paid, pending or cancelled rent charge proves billing happened). */
const RENT_KINDS: ReadonlySet<string> = new Set([
  "rent",
  "first_month_rent",
  "prorated_rent",
  "prorated_last_month_rent",
  "stay_total",
]);

/** Signed this long ago with still no rent charge is an alert, not a race with the generator. */
export const RESIDENCY_WITHOUT_RENT_GRACE_DAYS = 3;

export type ResidencyLease = {
  id: string;
  status?: string | null;
  residentEmail?: string | null;
  propertyId?: string | null;
  fullySignedAt?: string | null;
  voidedAt?: string | null;
};

export type ResidencyCharge = {
  residentEmail?: string | null;
  propertyId?: string | null;
  kind?: string | null;
};

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

/** Ids of the executed leases whose resident has no rent charge of any status on that property. */
export function leasesWithoutRentCharges(input: {
  leases: ReadonlyArray<ResidencyLease>;
  charges: ReadonlyArray<ResidencyCharge>;
  now?: Date;
  graceDays?: number;
}): string[] {
  const now = (input.now ?? new Date()).getTime();
  const graceMs = (input.graceDays ?? RESIDENCY_WITHOUT_RENT_GRACE_DAYS) * 24 * 60 * 60 * 1000;
  const rentCharges = input.charges.filter((charge) => RENT_KINDS.has(norm(charge.kind)));
  const out: string[] = [];
  for (const lease of input.leases) {
    if (lease.status !== "Fully Signed" || lease.voidedAt) continue;
    const email = norm(lease.residentEmail);
    if (!email) continue;
    const signedAt = Date.parse(String(lease.fullySignedAt ?? ""));
    // Without a signing time there is no way to tell a fresh signature from a stale one: say nothing.
    if (!Number.isFinite(signedAt) || now - signedAt < graceMs) continue;
    const propertyId = norm(lease.propertyId);
    const billed = rentCharges.some(
      (charge) =>
        norm(charge.residentEmail) === email && (!propertyId || !norm(charge.propertyId) || norm(charge.propertyId) === propertyId),
    );
    if (!billed) out.push(lease.id);
  }
  return out;
}
