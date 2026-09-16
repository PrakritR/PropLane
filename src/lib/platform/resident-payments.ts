import type { HouseholdCharge } from "@/lib/household-charges";
import { canPayHouseholdChargeWithAxisAch } from "@/lib/household-charge-payment-eligibility";
import type { ResidentAxisPaymentMethod } from "@/lib/payment-policy";

export type ResidentPayMethod = ResidentAxisPaymentMethod;

export const RESIDENT_WEB_PAYMENT_METHODS: ResidentAxisPaymentMethod[] = ["ach", "link", "card"];

/** iOS/Android app — bank (ACH) and card via Stripe. */
export const RESIDENT_NATIVE_PAYMENT_METHODS: ResidentAxisPaymentMethod[] = ["ach", "card"];

export function residentPaymentMethodsForSurface(isNativeApp: boolean): ResidentAxisPaymentMethod[] {
  return isNativeApp ? RESIDENT_NATIVE_PAYMENT_METHODS : RESIDENT_WEB_PAYMENT_METHODS;
}

export function coerceResidentPaymentMethodForSurface(
  method: ResidentAxisPaymentMethod | undefined,
  isNativeApp: boolean,
): ResidentAxisPaymentMethod {
  const normalized: ResidentAxisPaymentMethod =
    method === "card" || method === "link" ? method : "ach";
  if (isNativeApp && normalized === "link") return "ach";
  if (isNativeApp) return normalized === "card" ? "card" : "ach";
  return normalized;
}

export function isStripeResidentPayMethod(method: string): method is ResidentAxisPaymentMethod {
  return method === "ach" || method === "card" || method === "link";
}

export function isPayableHouseholdCharge(charge: HouseholdCharge): boolean {
  if (charge.status !== "pending") return false;
  return canPayHouseholdChargeWithAxisAch(charge);
}

/** Every PropLane method (bank, card, Link) pays the same set of charges. */
export function filterChargesForPayMethod(charges: HouseholdCharge[]): HouseholdCharge[] {
  return charges.filter((c) => canPayHouseholdChargeWithAxisAch(c));
}

/** True when at least one pending charge can start PropLane / Stripe checkout. */
export function chargesSupportPlatformCheckout(charges: HouseholdCharge[]): boolean {
  return charges.some((c) => c.status === "pending" && canPayHouseholdChargeWithAxisAch(c));
}
