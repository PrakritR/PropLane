/**
 * What the resident's Lease tab should say about their current lease, and what
 * the button on it should do.
 *
 * Before this, the only way to extend or renew was to open a signed lease's
 * detail page and find "Renew" in the footer — the Lease LIST, which is where a
 * resident actually lands, said nothing at all about a lease that was two weeks
 * from ending. This computes the one line that belongs at the top of that list.
 *
 * Pure and date-injectable so the wording can be tested without freezing time.
 */
import { hasBothLeaseSignatures, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { listingRollsOverToMonthToMonth } from "@/lib/rental-application/data";
import { parseFlexibleLocalDate } from "@/lib/rental-application/lease-dates";

export type ResidentLeaseRenewalStatus =
  /** Nothing signed yet, or no lease at all — the list's own empty/pending states cover it. */
  | { kind: "none" }
  /** A renewal is out for signature; the resident's job is to sign, not to ask again. */
  | { kind: "awaiting_signature"; fact: string }
  /** Open-ended already. */
  | { kind: "month_to_month"; fact: string; cta: string }
  /** Fixed term that CONTINUES month-to-month at the end, because the listing says so. */
  | { kind: "rolls_over"; fact: string; cta: string; daysRemaining: number }
  /** Fixed term that ends. `soon` drives the urgent styling. */
  | { kind: "ending"; fact: string; cta: string; daysRemaining: number; soon: boolean };

/** Calendar days from `today` to `iso`, negative once it has passed. */
export function daysUntil(iso: string, today: Date): number {
  const end = parseFlexibleLocalDate(iso);
  if (!end) return Number.NaN;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

function endLabel(iso: string): string {
  const d = parseFlexibleLocalDate(iso);
  if (!d) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** The renewal line for the resident's Lease tab. `today` is injected for tests. */
export function residentLeaseRenewalStatus(
  row: LeasePipelineRow | null | undefined,
  today: Date = new Date(),
): ResidentLeaseRenewalStatus {
  if (!row) return { kind: "none" };

  // A renewal already out for signature outranks everything else: telling the
  // resident their lease is ending while the replacement sits in their own
  // signature queue would send them to start a second one.
  if (row.pendingRenewal && !hasBothLeaseSignatures(row)) {
    return {
      kind: "awaiting_signature",
      fact: row.bucket === "resident" ? "Renewal ready to sign" : "Renewal being prepared",
    };
  }

  if (!hasBothLeaseSignatures(row)) return { kind: "none" };

  const leaseEnd = row.application?.leaseEnd?.trim() ?? "";
  const term = row.application?.leaseTerm?.trim() ?? "";
  if (!leaseEnd || term === "Month-to-Month") {
    return {
      kind: "month_to_month",
      fact: "Month-to-month",
      cta: "Change lease term",
    };
  }

  const days = daysUntil(leaseEnd, today);
  if (Number.isNaN(days)) return { kind: "none" };
  const when = endLabel(leaseEnd);

  const propertyId = row.propertyId ?? row.application?.propertyId ?? "";
  if (propertyId && listingRollsOverToMonthToMonth(propertyId)) {
    return {
      kind: "rolls_over",
      fact: `Continues month-to-month after ${when}`,
      cta: "Choose a new term",
      daysRemaining: days,
    };
  }

  return {
    kind: "ending",
    fact: `Ends ${when}`,
    cta: "Extend",
    daysRemaining: days,
    soon: days <= 60,
  };
}
