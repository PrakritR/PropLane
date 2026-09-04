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
  | { kind: "awaiting_signature"; headline: string; body: string }
  /** Open-ended already. */
  | { kind: "month_to_month"; headline: string; body: string; cta: string }
  /** Fixed term that CONTINUES month-to-month at the end, because the listing says so. */
  | { kind: "rolls_over"; headline: string; body: string; cta: string; daysRemaining: number }
  /** Fixed term that ends. `soon` drives the urgent styling. */
  | { kind: "ending"; headline: string; body: string; cta: string; daysRemaining: number; soon: boolean };

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
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function remainingPhrase(days: number): string {
  if (days < 0) return "It has already passed its end date.";
  if (days === 0) return "That is today.";
  if (days === 1) return "That is tomorrow.";
  if (days < 45) return `That is ${days} days away.`;
  return "";
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
      headline: "Your renewal is ready",
      body:
        row.bucket === "resident"
          ? "Open the pending lease below and sign it. Your payments update once both parties have signed."
          : "Your manager is preparing the renewal document. You will be asked to sign it here.",
    };
  }

  if (!hasBothLeaseSignatures(row)) return { kind: "none" };

  const leaseEnd = row.application?.leaseEnd?.trim() ?? "";
  const term = row.application?.leaseTerm?.trim() ?? "";
  if (!leaseEnd || term === "Month-to-Month") {
    return {
      kind: "month_to_month",
      headline: "Your lease is month-to-month",
      body: "It continues until you or your manager gives notice. You can switch to a fixed term at any time.",
      cta: "Change lease term",
    };
  }

  const days = daysUntil(leaseEnd, today);
  if (Number.isNaN(days)) return { kind: "none" };
  const when = endLabel(leaseEnd);
  const remaining = remainingPhrase(days);

  const propertyId = row.propertyId ?? row.application?.propertyId ?? "";
  if (propertyId && listingRollsOverToMonthToMonth(propertyId)) {
    return {
      kind: "rolls_over",
      headline: `Continues month-to-month after ${when}`,
      body: `You do not need to do anything — your lease rolls into a month-to-month tenancy on the same terms.${
        remaining ? ` ${remaining}` : ""
      } Want a new fixed term instead?`,
      cta: "Choose a new term",
      daysRemaining: days,
    };
  }

  return {
    kind: "ending",
    headline: `Your lease ends ${when}`,
    body: `${remaining ? `${remaining} ` : ""}Extend it, switch to month-to-month, or pick a new term. The new lease has to be signed by both of you.`,
    cta: days <= 60 ? "Renew or extend" : "Extend lease",
    daysRemaining: days,
    soon: days <= 60,
  };
}
