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
 */

export type PlanAddonId = "extra_listing" | "extra_work_number" | "extra_workspace" | "extra_seat";

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

export const PLAN_ADDONS: readonly PlanAddonDefinition[] = [
  {
    id: "extra_listing",
    label: "Extra property listing",
    unit: "listing",
    description: "One more live listing beyond your plan's included count.",
    monthlyCents: { pro: 800, business: 600 },
    maxQuantity: { pro: null, business: null },
    why: "Pro's $20 buys 2 (≈ $10 each); a third at $8 stays cheaper than Business until about 20.",
  },
  {
    id: "extra_work_number",
    label: "Extra work number",
    unit: "number",
    description: "Another texting and calling line beyond the one your plan includes.",
    monthlyCents: { pro: 500, business: 500 },
    maxQuantity: { pro: null, business: null },
    why: "Carrier cost ≈ $1.15 plus A2P registration; $5 leaves margin.",
  },
  {
    id: "extra_workspace",
    label: "Extra workspace",
    unit: "workspace",
    description: "A second team of houses and people, with its own work number on Business.",
    monthlyCents: { pro: 1500, business: 3000 },
    // Pro: 1 included + 2 extra = the 3 the product supports. Business: 3
    // included; extras up to the database ceiling.
    maxQuantity: { pro: 2, business: null },
    why: "A workspace is a second team and a second number.",
  },
  {
    id: "extra_seat",
    label: "Extra co-manager seat",
    unit: "seat",
    description: "One more manager on your houses beyond the seats your plan includes.",
    monthlyCents: { pro: 500, business: 500 },
    maxQuantity: { pro: null, business: null },
    why: "Seat pricing, Slack-style.",
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
  extra_listing: 0,
  extra_work_number: 0,
  extra_workspace: 0,
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
export function includedWorkNumbersForTier(tier: string | null | undefined, workspaceCount: number): number {
  if (tier === "pro") return 1;
  if (tier === "business") return Math.max(1, workspaceCount);
  return 0;
}

/** The Stripe Price id for one add-on on one plan, from env; ignores non-`price_` values. */
export function stripePriceIdForPlanAddon(id: PlanAddonId, tier: PaidPlanTier): string | undefined {
  const key = `STRIPE_PRICE_ADDON_${id.toUpperCase()}_${tier.toUpperCase()}`;
  const raw = process.env[key]?.trim();
  return raw?.startsWith("price_") ? raw : undefined;
}

export function formatAddonPrice(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}
