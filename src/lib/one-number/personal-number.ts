/**
 * Number model (captain, Oct 18): every workspace texts on the set PropLane line. Only a Pro or
 * Business workspace may take a personalized number of its own, and PropLane's managed service
 * (workspaces owned by the platform service account) always may. The plan is read only through
 * `resolveEffectiveManagerSkuTier` (docs/agents/plan-entitlements.md); this module holds the two
 * facts that sit beside it: who the service owner is, and what a refusal says.
 */

/** User ids of the PropLane service owner account(s): `PROPLANE_SERVICE_OWNER_USER_ID`, comma separated. */
export function platformServiceOwnerIds(env: Record<string, string | undefined> = process.env): string[] {
  return String(env.PROPLANE_SERVICE_OWNER_USER_ID ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Is this account the one that owns PropLane's own managed-service workspaces? */
export function isPlatformServiceOwner(
  userId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const id = String(userId ?? "").trim();
  return Boolean(id) && platformServiceOwnerIds(env).includes(id);
}

/** A Free workspace stays on the PropLane line. Neutral on purpose: no plan names, no upsell. */
export const PERSONAL_NUMBER_FREE_REFUSAL = {
  code: "personal_number_needs_paid_plan",
  error: "This workspace texts from the PropLane line.",
} as const;

/** The plan tiers that may hold a personalized number. */
export function planMayHavePersonalNumber(tier: "free" | "pro" | "business" | null | undefined): boolean {
  return tier === "pro" || tier === "business";
}
