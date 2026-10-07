/**
 * "Listed with PropLane" attribution on syndicated posts and the public listing page.
 *
 * The one rule: shown unless the workspace turned it off AND its effective plan is above Free.
 * Free is always on. The plan is read only through `resolveEffectiveManagerSkuTier`
 * (see `docs/agents/plan-entitlements.md`); an unreadable plan fails closed to on.
 * The setting lives on `workspace_automation_settings.row_data.listingAttribution`.
 */
import type { ManagerSkuTier } from "@/lib/manager-access";

export const LISTING_ATTRIBUTION_ROW_KEY = "listingAttribution";

export const LISTING_ATTRIBUTION_PARTNER_PATH = "/partner";

/** The workspace's stored choice. Anything but an explicit `show: false` means on. */
export function normalizeListingAttributionSetting(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
  return (raw as { show?: unknown }).show !== false;
}

/** The plan as the entitlement resolver reports it; `ok: false` is a failed plan read. */
export type ListingAttributionPlan = { ok: true; tier: ManagerSkuTier | null } | { ok: false };

/** Free (or an unreadable plan) is always on; a paid plan follows the workspace's setting. */
export function listingAttributionForcedOn(plan: ListingAttributionPlan): boolean {
  return !plan.ok || plan.tier === "free";
}

export function resolveShowListingAttribution(input: { plan: ListingAttributionPlan; setting: boolean }): boolean {
  return listingAttributionForcedOn(input.plan) ? true : input.setting;
}

/** The final paragraph of a syndicated post. */
export function listingAttributionLine(origin: string): string {
  return `Listed with PropLane — free for landlords: ${origin.replace(/\/$/, "")}${LISTING_ATTRIBUTION_PARTNER_PATH}`;
}
