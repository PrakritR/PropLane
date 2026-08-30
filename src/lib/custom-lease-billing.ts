import { listingPresetFeeAmount } from "@/lib/listing-fees";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { isCustomCalendarLease } from "@/lib/rental-application/lease-dates";

export const CUSTOM_LEASE_SURCHARGE_FEE_ID = "preset:custom_lease_surcharge";
export const CUSTOM_LEASE_SURCHARGE_CHARGE_LABEL = "Custom lease";

export type LeaseRecurringFeeBillingContext = {
  leaseStart?: string;
  leaseEnd?: string;
  leaseTerm?: string | null;
  rentalType?: string | null;
};

export function shouldBillMonthToMonthSurcharge(input: LeaseRecurringFeeBillingContext): boolean {
  if (input.rentalType === "short_term") return false;
  return input.leaseTerm?.trim() === "Month-to-Month";
}

export function shouldBillCustomLeaseSurcharge(input: LeaseRecurringFeeBillingContext): boolean {
  if (input.rentalType === "short_term") return false;
  const term = input.leaseTerm?.trim();
  if (!term || term === "Month-to-Month") return false;
  return isCustomCalendarLease(input.leaseStart, input.leaseEnd);
}

export function customLeaseSurchargeAmount(sub: ManagerListingSubmissionV1 | null | undefined): number {
  if (!sub) return 0;
  return listingPresetFeeAmount(sub, "custom_lease_surcharge");
}

export function recurringMonthlyFeesForLease(
  sub: ManagerListingSubmissionV1 | null | undefined,
  monthlyCustomFees: { id: string; label: string; amount: number }[],
  billingContext: LeaseRecurringFeeBillingContext,
): { id: string; label: string; amount: number }[] {
  const fees = monthlyCustomFees.filter((fee) => fee.id !== CUSTOM_LEASE_SURCHARGE_FEE_ID);
  if (!shouldBillCustomLeaseSurcharge(billingContext)) return fees;
  const amount = customLeaseSurchargeAmount(sub);
  if (!(amount > 0)) return fees;
  return [
    ...fees,
    { id: CUSTOM_LEASE_SURCHARGE_FEE_ID, label: CUSTOM_LEASE_SURCHARGE_CHARGE_LABEL, amount },
  ];
}
