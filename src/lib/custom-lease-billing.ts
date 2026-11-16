import { listingPresetFeeAppliesToLeaseType } from "@/lib/listing-fee-scope";
import { listingPresetFeeAmount, removedStandardListingFeeRowSet, resolveListingFees } from "@/lib/listing-fees";
import { listingPresetFeeAmountIfEnabled } from "@/lib/listing-fee-term-toggles";
import { resolveAllowedLeaseTerms, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { CUSTOM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { DEFAULT_CUSTOM_LEASE_SURCHARGE, isCustomCalendarLease } from "@/lib/rental-application/lease-dates";

export const CUSTOM_LEASE_SURCHARGE_FEE_ID = "preset:custom_lease_surcharge";
export const CUSTOM_LEASE_SURCHARGE_CHARGE_LABEL = "Custom lease";
export const MONTH_TO_MONTH_SURCHARGE_FEE_ID = "preset:mtm_surcharge";
export const MONTH_TO_MONTH_SURCHARGE_CHARGE_LABEL = "Month-to-month surcharge";

export type LeaseRecurringFeeBillingContext = {
  leaseStart?: string;
  leaseEnd?: string;
  leaseTerm?: string | null;
  rentalType?: string | null;
};

export function shouldBillMonthToMonthSurcharge(input: LeaseRecurringFeeBillingContext): boolean {
  if (input.rentalType === "short_term" || input.rentalType === "airbnb") return false;
  return input.leaseTerm?.trim() === "Month-to-Month";
}

export function shouldBillCustomLeaseSurcharge(
  input: LeaseRecurringFeeBillingContext,
  sub?: ManagerListingSubmissionV1 | null,
): boolean {
  if (input.rentalType === "short_term" || input.rentalType === "airbnb") return false;
  const term = input.leaseTerm?.trim();
  if (!term || term === "Month-to-Month") return false;
  if (sub && !listingPresetFeeAppliesToLeaseType(sub, "custom_lease_surcharge", term)) return false;
  return isCustomCalendarLease(input.leaseStart, input.leaseEnd);
}

export function customLeaseSurchargeAmount(sub: ManagerListingSubmissionV1 | null | undefined): number {
  if (!sub) return 0;
  // A row the manager REMOVED bills nothing, blank amount or not: a removal is their decision exactly as a
  // typed amount is, and the default below must never outrank it. (The per-term checkbox is deliberately not
  // consulted here - it is derived from the amount being filled, so it reads "off" for precisely the
  // not-priced-yet row this default exists for; the lease length is gated per term by
  // `shouldBillCustomLeaseSurcharge` and, for the default, by the Custom-term check below.)
  if (removedStandardListingFeeRowSet(sub).has("customLeaseSurcharge")) return 0;
  // Blank means "not priced yet" and defaults to $100/month; an amount the manager typed
  // (including 0) is theirs.
  const row = resolveListingFees(sub).find((fee) => fee.presetId === "custom_lease_surcharge");
  if (!row || !String(row.amount ?? "").trim()) {
    // Blank defaults only when the listing actually offers a Custom (calendar) term.
    return resolveAllowedLeaseTerms(sub).includes(CUSTOM_LEASE_TERM) ? DEFAULT_CUSTOM_LEASE_SURCHARGE : 0;
  }
  return listingPresetFeeAmount(sub, "custom_lease_surcharge");
}

export function monthToMonthSurchargeAmount(sub: ManagerListingSubmissionV1 | null | undefined): number {
  if (!sub) return 0;
  // Gated like the self-billing presets: a removed/unchecked row or a listing that does not
  // offer month-to-month bills nothing, even if a stale amount survives on the row.
  return listingPresetFeeAmountIfEnabled(sub, "mtm_surcharge");
}

/**
 * The monthly fees a lease bills as their own charges (outside rent-fold-in listings).
 * Captain, Oct 3: the month-to-month surcharge bills monthly on a Month-to-Month lease,
 * like the custom-start surcharge does on a custom lease — only when the manager set it.
 */
export function recurringMonthlyFeesForLease(
  sub: ManagerListingSubmissionV1 | null | undefined,
  monthlyCustomFees: { id: string; label: string; amount: number }[],
  billingContext: LeaseRecurringFeeBillingContext,
): { id: string; label: string; amount: number }[] {
  const fees = monthlyCustomFees.filter(
    (fee) => fee.id !== CUSTOM_LEASE_SURCHARGE_FEE_ID && fee.id !== MONTH_TO_MONTH_SURCHARGE_FEE_ID,
  );
  if (shouldBillCustomLeaseSurcharge(billingContext, sub)) {
    const amount = customLeaseSurchargeAmount(sub);
    if (amount > 0) fees.push({ id: CUSTOM_LEASE_SURCHARGE_FEE_ID, label: CUSTOM_LEASE_SURCHARGE_CHARGE_LABEL, amount });
  }
  if (shouldBillMonthToMonthSurcharge(billingContext)) {
    const amount = monthToMonthSurchargeAmount(sub);
    if (amount > 0) fees.push({ id: MONTH_TO_MONTH_SURCHARGE_FEE_ID, label: MONTH_TO_MONTH_SURCHARGE_CHARGE_LABEL, amount });
  }
  return fees;
}
