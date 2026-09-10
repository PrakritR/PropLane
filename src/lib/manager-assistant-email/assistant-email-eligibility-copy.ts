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
  // `reason` lives only on the not-eligible branch of the union, so narrow
  // before reading it. Same behaviour — on an eligible entitlement the property
  // is absent and the comparison was already false — it just typechecks.
  if (planTier === "free" || (!entitlement.eligible && entitlement.reason === "free")) {
    return "A dedicated PropLane work email is included with an active paid Pro or Business plan.";
  }
  if (entitlement.eligible) return null;
  switch (entitlement.reason) {
    case "trialing":
      // Reachable only while trial onboarding is CLOSED. With it open, a trial
      // reconciles to eligible and gets a work email exactly like a work
      // number — the two used to disagree here, and that was the bug.
      return "Your work email becomes available after your paid subscription begins.";
    case "past_due":
      return "Update your billing details to restore your work email.";
    case "canceled":
      return "Restart a paid Pro or Business plan to request a work email.";
    default:
      return null;
  }
}

export function assistantEmailEligibilityError(
  planTier: ManagerMessagingPlanTier,
  entitlement: ManagerMessagingEntitlement,
): string {
  if (entitlement.eligible) return "";
  // `reason` lives only on the not-eligible branch of the union, so narrow
  // before reading it. Same behaviour — on an eligible entitlement the property
  // is absent and the comparison was already false — it just typechecks.
  if (planTier === "free" || (!entitlement.eligible && entitlement.reason === "free")) {
    return "A paid Pro or Business plan is required for a PropLane work email.";
  }
  switch (entitlement.reason) {
    case "trialing":
      return "Work email setup is available after your Pro or Business trial converts to a paid subscription.";
    case "past_due":
      return "Update your billing details, then try again.";
    case "canceled":
      return "Restart a paid Pro or Business plan to request a work email.";
    case "plan_unreadable":
      return "We could not read your plan. Reload the page and try again.";
    case "legacy_unknown":
      return "We could not verify billing for this account. Contact support if you have an active paid plan.";
    default:
      return "A paid Pro or Business plan is required for a PropLane work email.";
  }
}
