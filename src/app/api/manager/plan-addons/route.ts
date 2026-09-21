import { NextResponse } from "next/server";

import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import {
  PLAN_ADDONS,
  isPlanAddonId,
  planAddonsMonthlyTotalCents,
  planTierCanHoldAddons,
  type PlanAddonId,
} from "@/lib/plan-addons";
import {
  describePlanAddons,
  loadManagerPlanAddonQuantities,
  setManagerPlanAddonQuantities,
  type PlanAddonChangeInput,
} from "@/lib/plan-addons.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Plan add-ons for the signed-in manager (Settings → Billing & plan).
 *
 * GET: the catalogue with this account's quantities and monthly add-on total.
 * Add-ons are always purchasable — a missing Stripe Price is created from the
 * catalog before the first charge, so no row is ever disabled.
 *
 * PATCH `{ changes: [{ addonId, quantity }] }` (or the older single-item
 * `{ addonId, quantity }` body): applies the whole set as ONE Stripe
 * subscription update, all-or-nothing. POST accepts the same bodies for
 * backward compatibility. A co-manager has no spending authority on the
 * owner's plan: add-ons follow the authenticated manager's own purchase row.
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

/** Accepts `{ changes: [...] }` or the older single-item `{ addonId, quantity }` shape. */
function parseChanges(body: unknown): PlanAddonChangeInput[] | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { changes?: unknown; addonId?: unknown; quantity?: unknown };
  if (Array.isArray(record.changes)) {
    const out: PlanAddonChangeInput[] = [];
    for (const raw of record.changes) {
      if (!raw || typeof raw !== "object") return null;
      const addonId = (raw as { addonId?: unknown }).addonId;
      const quantity = Number((raw as { quantity?: unknown }).quantity);
      if (!isPlanAddonId(addonId) || !Number.isFinite(quantity)) return null;
      out.push({ addonId, quantity });
    }
    return out;
  }
  if (isPlanAddonId(record.addonId)) {
    const quantity = Number(record.quantity);
    if (!Number.isFinite(quantity)) return null;
    return [{ addonId: record.addonId as PlanAddonId, quantity }];
  }
  return null;
}

async function handleAddonMutation(req: Request) {
  const auth = await requireManagerRouteUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const changes = parseChanges(body);
  if (!changes) return NextResponse.json({ error: "Choose a quantity for a known add-on." }, { status: 400 });

  const result = await setManagerPlanAddonQuantities({ managerUserId: auth.userId, changes });
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

export async function PATCH(req: Request) {
  return handleAddonMutation(req);
}

/** Back-compat: earlier callers POST the same bodies PATCH now accepts. */
export async function POST(req: Request) {
  return handleAddonMutation(req);
}
