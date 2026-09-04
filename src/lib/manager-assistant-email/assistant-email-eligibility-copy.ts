import type { ManagerMessagingEntitlement, ManagerMessagingPlanTier } from "@/lib/sms/manager-messaging-number";

export function assistantEmailEntitlementIsUnverified(entitlement: ManagerMessagingEntitlement): boolean {
  return (
    !entitlement.eligible &&
    (entitlement.reason === "plan_unreadable" || entitlement.reason === "legacy_unknown")
  );
}

/** Upsell copy only for genuinely free or lapsed plans — not unverified paid accounts. */
export function assistantEmailUpsellMessage(
  planTier: ManagerMessagingPlanTier,
  entitlement: ManagerMessagingEntitlement,
): string | null {
  if (planTier === "free" || entitlement.reason === "free") {
    return "A dedicated PropLane assistant email is included with an active paid Pro or Business plan.";
  }
  if (entitlement.eligible) return null;
  switch (entitlement.reason) {
    case "trialing":
      return "Assistant email becomes available after your paid subscription begins.";
    case "past_due":
      return "Update your billing details to restore assistant email eligibility.";
    case "canceled":
      return "Restart a paid Pro or Business plan to request an assistant email.";
    default:
      return null;
  }
}

export function assistantEmailEligibilityError(
  planTier: ManagerMessagingPlanTier,
  entitlement: ManagerMessagingEntitlement,
): string {
  if (entitlement.eligible) return "";
  if (planTier === "free" || entitlement.reason === "free") {
    return "A paid Pro or Business plan is required for a PropLane assistant email.";
  }
  switch (entitlement.reason) {
    case "trialing":
      return "Assistant email becomes available after your paid subscription begins.";
    case "past_due":
      return "Update your billing details, then try again.";
    case "canceled":
      return "Restart a paid Pro or Business plan to request an assistant email.";
    case "plan_unreadable":
      return "We could not read your plan. Tap Check eligibility, then try again.";
    case "legacy_unknown":
      return "We could not verify billing for this account. Check eligibility or contact support if you have an active paid plan.";
    default:
      return "A paid Pro or Business plan is required for a PropLane assistant email.";
  }
}
