/**
 * Plan add-ons — a price for everything that costs PropLane something.
 *
 * The three plans buy a fixed bundle (listings, a work number, workspaces,
 * seats, communication credit). Past the bundle a paying account adds one of
 * these at a time; Free adds nothing and upgrades instead. Prices are the
 * captain's round-3 table; the "why" beside each is the margin reasoning it
 * came with, kept here so a later edit knows what the number was for.
 *
 * Quantities live in `manager_plan_addons` (see `plan-addons.server.ts`).
 * A quota reads its plan cap PLUS the add-on quantity — never the add-on
 * alone — so a downgrade or a Stripe lapse falls back to the plan, and an
 * account is never left below what its plan already includes.
 *
 * `extra_listing` (PLAN-DOOR step 2): retired from this catalogue — per-door
 * billing (`src/lib/billing/rate-card.ts`) now prices extra doors directly, so
 * a per-listing add-on would double-price the same axis. It is no longer
 * `PlanAddonId`, so `isPlanAddonId("extra_listing")` is false and
 * `setManagerPlanAddonQuantities` refuses any change naming it — it can no
 * longer be bought, and an account already holding it can no longer change
 * that quantity through the product either. This deliberately leaves any
 * existing `manager_plan_addons` row (and its Stripe subscription item, if
 * any) untouched: no migration here cancels or backfills it. See the
 * per-door billing PRP for what those existing rows still cost.
 */

export type PlanAddonId = "extra_work_number" | "extra_workspace" | "extra_seat" | "extra_resident" | "extra_comms_credit";

export type PaidPlanTier = "pro" | "business";

export type PlanAddonDefinition = {
  id: PlanAddonId;
  label: string;
  /** What one unit buys, in the manager's nouns. */
  unit: string;
  description: string;
  /** Monthly price per unit, by paid plan. */
  monthlyCents: Record<PaidPlanTier, number>;
  /** Units a plan may hold; `null` = no cap beyond the database ceiling. */
  maxQuantity: Record<PaidPlanTier, number | null>;
  why: string;
};

/** Add-ons the Billing panel offers to buy. Retired ids stay in PLAN_ADDONS for grandfathered rows. */
export const PLAN_ADDON_STOREFRONT_IDS: readonly PlanAddonId[] = [
  "extra_workspace",
  "extra_resident",
] as const;

export const PLAN_ADDONS: readonly PlanAddonDefinition[] = [
  {
    id: "extra_comms_credit",
    label: "Communication credits",
    unit: "credit pack",
    description: "Retired — buy communication credit under Extra usage, not as a monthly add-on.",
    monthlyCents: { pro: 1_000, business: 1_000 },
    maxQuantity: { pro: 0, business: 0 },
    why: "Monthly communication top-ups moved to Extra usage Embedded Checkout.",
  },
  {
    id: "extra_workspace",
    label: "Extra workspace",
    unit: "workspace",
    description: "Another team of houses and people, with its own work number and work email.",
    monthlyCents: { pro: 1500, business: 3000 },
    maxQuantity: { pro: null, business: null },
    why: "A workspace is a second team and a second number.",
  },
  {
    id: "extra_resident",
    label: "Extra residents",
    unit: "resident",
    description: "One more resident slot beyond what your plan includes.",
    monthlyCents: { pro: 300, business: 200 },
    maxQuantity: { pro: null, business: null },
    why: "Matches the per-resident overage rate on the rate card.",
  },
  {
    id: "extra_work_number",
    label: "Extra work number",
    unit: "number",
    description: "Retired — each workspace includes exactly one work number.",
    monthlyCents: { pro: 500, business: 500 },
    maxQuantity: { pro: 0, business: 0 },
    why: "Hard product limit: 1 work number per workspace.",
  },
  {
    id: "extra_seat",
    label: "Extra co-manager seat",
    unit: "seat",
    description: "Retired — team seats are no longer plan-capped.",
    monthlyCents: { pro: 500, business: 500 },
    maxQuantity: { pro: 0, business: 0 },
    why: "Seats are uncapped; invite anyone with workspace permissions.",
  },
];

export const PLAN_ADDON_IDS = PLAN_ADDONS.map((a) => a.id) as readonly PlanAddonId[];

export function isPlanAddonId(raw: unknown): raw is PlanAddonId {
  return typeof raw === "string" && (PLAN_ADDON_IDS as readonly string[]).includes(raw);
}

export function planAddon(id: PlanAddonId): PlanAddonDefinition {
  return PLAN_ADDONS.find((a) => a.id === id)!;
}

export type PlanAddonQuantities = Record<PlanAddonId, number>;

export const EMPTY_PLAN_ADDON_QUANTITIES: PlanAddonQuantities = {
  extra_comms_credit: 0,
  extra_workspace: 0,
  extra_resident: 0,
  extra_work_number: 0,
  extra_seat: 0,
};

/** Add-ons are for paying plans; Free upgrades instead. */
export function planTierCanHoldAddons(tier: string | null | undefined): tier is PaidPlanTier {
  return tier === "pro" || tier === "business";
}

export function planAddonMonthlyCents(id: PlanAddonId, tier: PaidPlanTier): number {
  return planAddon(id).monthlyCents[tier];
}

export function planAddonMaxQuantity(id: PlanAddonId, tier: PaidPlanTier): number | null {
  return planAddon(id).maxQuantity[tier];
}

/** Monthly total of every add-on an account holds. */
export function planAddonsMonthlyTotalCents(tier: PaidPlanTier, quantities: PlanAddonQuantities): number {
  return PLAN_ADDONS.reduce((sum, a) => sum + a.monthlyCents[tier] * Math.max(0, quantities[a.id] ?? 0), 0);
}

/**
 * Work numbers a plan includes before add-ons. Free has none; Pro one; on
 * Business every workspace comes with its own line.
 */
export function includedWorkNumbers(tier: string | null | undefined, workspaceCount: number): number {
  if (tier === "pro") return 1;
  if (tier === "business") return Math.max(1, workspaceCount);
  return 0;
}

/**
 * Every workspace holds at most 1 work number (hard product limit). Pure of
 * any table read so both the panel's displayed cap and the route's write-time
 * validation share one answer.
 */
export function maxWorkNumbersForWorkspaces(totalWorkspaces: number): number {
  return Math.max(0, totalWorkspaces);
}

/** No extra work numbers for sale — 1 per workspace is the hard ceiling. */
export function maxExtraWorkNumberQuantity(tier: string | null | undefined, totalWorkspaces: number): number {
  void tier;
  void totalWorkspaces;
  return 0;
}

/**
 * The `extra_workspace` quantity a plan may hold: the product cap from the
 * catalog (Pro: up to 2, i.e. 3 total; Business: no product cap) narrowed by
 * the database ceiling so a purchase can never promise more than
 * `create_portal_workspace_with_limit` will actually create.
 */
export function maxExtraWorkspaceQuantity(tier: PaidPlanTier, includedWorkspaces: number, workspaceLimit: number): number {
  const productCap = planAddon("extra_workspace").maxQuantity[tier];
  const ceiling = Math.max(0, workspaceLimit - includedWorkspaces);
  return productCap === null ? ceiling : Math.min(productCap, ceiling);
}

/** The Stripe Price id for one add-on on one plan, from env; ignores non-`price_` values. */
export function stripePriceIdForPlanAddon(id: PlanAddonId, tier: PaidPlanTier): string | undefined {
  const key = `STRIPE_PRICE_ADDON_${id.toUpperCase()}_${tier.toUpperCase()}`;
  const raw = process.env[key]?.trim();
  return raw?.startsWith("price_") ? raw : undefined;
}

/**
 * The Stripe lookup_key an auto-created Price (and its Product, given the same
 * value as an explicit id) is filed under — stable across restarts so
 * `ensureAddonPrice` never creates a duplicate. Never change the format
 * without a migration: it is how an existing Price is found again.
 */
export function planAddonLookupKey(id: PlanAddonId, tier: PaidPlanTier): string {
  return `proplane_addon_${id}_${tier}`;
}

export function formatAddonPrice(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}
