import "server-only";
import type { SmsEntitlement } from "@/lib/sms/manager-sms-entitlement.server";
import { isTrialWorkNumberOnboardingEnabled } from "@/lib/sms/number-registration-policy";

// Work contact addresses are included on every verified plan. Credit gates
// apply to metered transport only; email remains usable with an empty wallet.
export type ManagerCommsIneligible = Extract<SmsEntitlement, { eligible: false }>;

export function managerCommsEntitlementCanBeReconciled(
  entitlement: SmsEntitlement,
): boolean {
  return (
    entitlement.eligible ||
    (entitlement.reason === "trialing" && isTrialWorkNumberOnboardingEnabled()) ||
    entitlement.reason === "plan_unreadable" ||
    entitlement.reason === "legacy_unknown"
  );
}

/**
 * Status-time: may the manager still be OFFERED the request?
 *
 * Optimistic on purpose — the authoritative reconciliation happens at the
 * request boundary, never on a status read.
 */
export function managerCommsRequestIsOfferable(input: {
  entitlement: SmsEntitlement;
}): boolean {
  return managerCommsEntitlementCanBeReconciled(input.entitlement);
}

/**
 * Status-time: may the manager USE a channel they already have?
 *
 * Stricter than `managerCommsRequestIsOfferable`: an unreconciled snapshot is
 * grounds to keep offering the setup, never to start sending.
 */
export function managerCommsUseIsAllowed(input: {
  entitlement: SmsEntitlement;
}): boolean {
  return input.entitlement.eligible;
}

/**
 * An entitlement refusal we could not settle rather than one we did: HTTP 503
 * and "try again", not 403 and "upgrade". Telling a paid manager to buy a plan
 * they already have because our own billing read failed is the worse mistake.
 */
export function managerCommsEntitlementIsUnreadable(
  entitlement: ManagerCommsIneligible,
): boolean {
  return entitlement.reason === "plan_unreadable" || entitlement.reason === "legacy_unknown";
}
