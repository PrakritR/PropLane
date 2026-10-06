import type { HouseholdCharge } from "@/lib/household-charges";
import { canPayHouseholdChargeWithAxisAch } from "@/lib/household-charge-payment-eligibility";
import type { ResidentAxisPaymentMethod } from "@/lib/payment-policy";

export type ResidentPayMethod = ResidentAxisPaymentMethod;

/** Web — bank (ACH) and card via Stripe. Link is never offered; payment stays in-app. */
export const RESIDENT_WEB_PAYMENT_METHODS: ResidentAxisPaymentMethod[] = ["ach", "card"];

/** iOS/Android app — bank (ACH) and card via Stripe. */
export const RESIDENT_NATIVE_PAYMENT_METHODS: ResidentAxisPaymentMethod[] = ["ach", "card"];

export function residentPaymentMethodsForSurface(isNativeApp: boolean): ResidentAxisPaymentMethod[] {
  return isNativeApp ? RESIDENT_NATIVE_PAYMENT_METHODS : RESIDENT_WEB_PAYMENT_METHODS;
}

export function coerceResidentPaymentMethodForSurface(
  method: ResidentAxisPaymentMethod | undefined,
  isNativeApp: boolean,
): ResidentAxisPaymentMethod {
  const offered = residentPaymentMethodsForSurface(isNativeApp);
  return method && offered.includes(method) ? method : "ach";
}

export function isStripeResidentPayMethod(method: string): method is ResidentAxisPaymentMethod {
  return method === "ach" || method === "card";
}

export function isPayableHouseholdCharge(charge: HouseholdCharge): boolean {
  if (charge.status !== "pending" && charge.status !== "failed") return false;
  return canPayHouseholdChargeWithAxisAch(charge);
}

/** Every PropLane method (bank, card) pays the same set of charges. */
export function filterChargesForPayMethod(charges: HouseholdCharge[]): HouseholdCharge[] {
  return charges.filter((c) => canPayHouseholdChargeWithAxisAch(c));
}

/** True when at least one pending charge can start PropLane / Stripe checkout. */
export function chargesSupportPlatformCheckout(charges: HouseholdCharge[]): boolean {
  return charges.some(
    (c) => (c.status === "pending" || c.status === "failed") && canPayHouseholdChargeWithAxisAch(c),
  );
}
