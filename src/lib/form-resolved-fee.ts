/**
 * The fee a form (an application or a lease) charges, READ from Pricing - never typed on the form.
 *
 * Each stay type carries its own application fee and lease fee in the property's Pricing, and
 * `listing-placement-standard-fees.ts` is the ONE resolver of them (the quote, the fee charged, the lease
 * document and the amount charged at signing all read it). A form view shows that answer read-only with a
 * link to Pricing, so there is no second fee field to drift from the first.
 *
 * Fees can differ by room, so a stay type's answer is a range across the listing's rooms (or its entire-home
 * row): `$25` when every placement agrees, `$25-$45` when they do not.
 */
import { formatPlacementMoneyField, placementFeeOptionsFor, resolvePlacementStandardFees } from "@/lib/listing-placement-standard-fees";
import type { ManagerListingSubmissionV1, ManagerRoomSubmission } from "@/lib/manager-listing-submission";

export type FormFeeKind = "application" | "lease";

export type FormResolvedFee = {
  term: string;
  minCents: number;
  maxCents: number;
  /**
   * True when Pricing (or the listing) names an amount. False for an application fee nothing sets: the
   * account's Application system fee then applies at checkout, which the property cannot show here.
   */
  set: boolean;
  /** What the form shows: `$45`, `$25-$45`, `None`, or `Account default`. */
  display: string;
};

function dollars(cents: number): string {
  return `$${formatPlacementMoneyField(String(cents / 100)) || "0"}`;
}

/** The placements a listing's fees are read for: each room, else the entire home. */
function placementsOf(sub: ManagerListingSubmissionV1): { room: ManagerRoomSubmission | null; wholeHouse: boolean }[] {
  const out: { room: ManagerRoomSubmission | null; wholeHouse: boolean }[] = (sub.rooms ?? []).map((room) => ({
    room,
    wholeHouse: false,
  }));
  if (sub.entireHomeOffered || out.length === 0) out.push({ room: null, wholeHouse: true });
  return out;
}

export function resolvedFormFeeForTerm(
  sub: ManagerListingSubmissionV1,
  kind: FormFeeKind,
  term: string,
): FormResolvedFee {
  const amounts: number[] = [];
  let set = false;
  for (const placement of placementsOf(sub)) {
    const fees = resolvePlacementStandardFees(
      sub,
      placementFeeOptionsFor(sub, { room: placement.room, wholeHouse: placement.wholeHouse, leaseTerm: term }),
    );
    if (kind === "lease") {
      amounts.push(Math.round(fees.leaseFee * 100));
      set = set || fees.leaseFeeExplicit;
    } else {
      amounts.push(Math.round(fees.applicationFee * 100));
      set = set || fees.applicationFeeExplicit || fees.applicationFee > 0;
    }
  }
  const minCents = Math.min(...amounts);
  const maxCents = Math.max(...amounts);
  let display: string;
  if (kind === "application" && !set) display = "Account default";
  else if (maxCents <= 0) display = "None";
  else if (minCents === maxCents) display = dollars(minCents);
  else display = `${dollars(minCents)}-${dollars(maxCents)}`;
  return { term, minCents, maxCents, set, display };
}

/** One row per stay type the form serves, in the order given. */
export function resolvedFormFees(
  sub: ManagerListingSubmissionV1,
  kind: FormFeeKind,
  terms: readonly string[],
): FormResolvedFee[] {
  return terms.map((term) => resolvedFormFeeForTerm(sub, kind, term));
}
