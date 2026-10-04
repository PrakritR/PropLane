import { listingPresetFeeAppliesToLeaseType } from "@/lib/listing-fee-scope";
import { listingPresetFeeAmount } from "@/lib/listing-fees";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { isCustomCalendarLease } from "@/lib/rental-application/lease-dates";

export const CUSTOM_LEASE_SURCHARGE_FEE_ID = "preset:custom_lease_surcharge";
export const CUSTOM_LEASE_SURCHARGE_CHARGE_LABEL = "Custom lease";
/**
 * Retired fee id. Month-to-month carries NO surcharge (captain, Oct 4 2026: "remove $25 surcharge for
 * month to month"). It survives only so a stale monthly-fee row that still carries it is stripped.
 */
export const RETIRED_MONTH_TO_MONTH_SURCHARGE_FEE_ID = "preset:mtm_surcharge";

export type LeaseRecurringFeeBillingContext = {
  leaseStart?: string;
  leaseEnd?: string;
  leaseTerm?: string | null;
  rentalType?: string | null;
};

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
  return listingPresetFeeAmount(sub, "custom_lease_surcharge");
}

/**
 * The monthly fees a lease bills as their own charges (outside rent-fold-in listings).
 * Only the custom-start surcharge bills here, on a custom-dated lease and only when the manager set it.
 * Month-to-month never adds a fee: any retired month-to-month surcharge row is dropped.
 */
export function recurringMonthlyFeesForLease(
  sub: ManagerListingSubmissionV1 | null | undefined,
  monthlyCustomFees: { id: string; label: string; amount: number }[],
  billingContext: LeaseRecurringFeeBillingContext,
): { id: string; label: string; amount: number }[] {
  const fees = monthlyCustomFees.filter(
    (fee) => fee.id !== CUSTOM_LEASE_SURCHARGE_FEE_ID && fee.id !== RETIRED_MONTH_TO_MONTH_SURCHARGE_FEE_ID,
  );
  if (shouldBillCustomLeaseSurcharge(billingContext, sub)) {
    const amount = customLeaseSurchargeAmount(sub);
    if (amount > 0) fees.push({ id: CUSTOM_LEASE_SURCHARGE_FEE_ID, label: CUSTOM_LEASE_SURCHARGE_CHARGE_LABEL, amount });
  }
  return fees;
}
