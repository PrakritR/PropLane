import { NextResponse } from "next/server";

import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import {
  PLAN_ADDONS,
  isPlanAddonId,
  planAddonsMonthlyTotalCents,
  planTierCanHoldAddons,
} from "@/lib/plan-addons";
import {
  describePlanAddons,
  loadManagerPlanAddonQuantities,
  setManagerPlanAddonQuantity,
} from "@/lib/plan-addons.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Plan add-ons for the signed-in manager (Settings → Billing & plan).
 *
 * GET: the catalogue with this account's quantities and monthly add-on total.
 * POST `{ addonId, quantity }`: set one add-on's quantity. The plan, the cap
 * and the Stripe subscription item are validated server-side; the body never
 * carries a price. A co-manager has no spending authority on the owner's
 * plan: add-ons follow the authenticated manager's own purchase row only.
 */
export async function GET() {
  const auth = await requireManagerRouteUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const tierResult = await getEffectiveManagerSkuTier(auth.userId);
  if (!tierResult.ok) return NextResponse.json({ error: tierResult.error }, { status: 503 });
  const tier = tierResult.tier;
  if (!planTierCanHoldAddons(tier)) {
    return NextResponse.json(
      {
        tier,
        canHoldAddons: false,
        addons: PLAN_ADDONS.map((a) => ({
          id: a.id,
          label: a.label,
          unit: a.unit,
          description: a.description,
          monthlyCents: a.monthlyCents.pro,
          maxQuantity: a.maxQuantity.pro,
          quantity: 0,
          purchasable: false,
        })),
        monthlyTotalCents: 0,
      },
      { headers: NO_STORE },
    );
  }
  const read = await loadManagerPlanAddonQuantities(createSupabaseServiceRoleClient(), auth.userId);
  if (!read.ok) return NextResponse.json({ error: "Could not read your add-ons." }, { status: 503 });
  return NextResponse.json(
    {
      tier,
      canHoldAddons: true,
      addons: describePlanAddons(tier, read.quantities),
      monthlyTotalCents: planAddonsMonthlyTotalCents(tier, read.quantities),
    },
    { headers: NO_STORE },
  );
}

export async function POST(req: Request) {
  const auth = await requireManagerRouteUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  let body: { addonId?: unknown; quantity?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!isPlanAddonId(body.addonId)) return NextResponse.json({ error: "Unknown add-on." }, { status: 400 });
  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity)) return NextResponse.json({ error: "Choose a quantity." }, { status: 400 });

  const result = await setManagerPlanAddonQuantity({ managerUserId: auth.userId, addonId: body.addonId, quantity });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status, headers: NO_STORE });
  }
  const tierResult = await getEffectiveManagerSkuTier(auth.userId);
  const tier = tierResult.ok && planTierCanHoldAddons(tierResult.tier) ? tierResult.tier : "pro";
  return NextResponse.json(
    {
      tier,
      canHoldAddons: true,
      addons: describePlanAddons(tier, result.quantities),
      monthlyTotalCents: planAddonsMonthlyTotalCents(tier, result.quantities),
      stripeSynced: result.stripeSynced,
    },
    { headers: NO_STORE },
  );
}
