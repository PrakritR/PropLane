import { NextResponse } from "next/server";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { planTierCanHoldAddons } from "@/lib/plan-addons";
import {
  countActiveRentReportingResidents,
  countCurrentRentPayingResidents,
  loadRentReportingAddonSettings,
  saveRentReportingAddonEnabled,
} from "@/lib/rent-reporting/manager-settings.server";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Settings → Billing & plan → Add-ons → Rent reporting. Pro and Business only
 * (`planTierCanHoldAddons`); Free sees the same "upgrade" answer the rest of the
 * Add-ons panel gives. Billing for this add-on is NOT yet wired to a charge — see
 * `docs/agents/rent-reporting.md` "Billing".
 */
export async function GET() {
  const auth = await requireManagerRouteUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const tierResult = await getEffectiveManagerSkuTier(auth.userId);
  if (!tierResult.ok) return NextResponse.json({ error: tierResult.error }, { status: 503 });
  const canHoldAddon = planTierCanHoldAddons(tierResult.tier);
  if (!canHoldAddon) {
    return NextResponse.json({ tier: tierResult.tier, canHoldAddon: false, enabled: false, reporting: 0, total: 0 }, { headers: NO_STORE });
  }
  const [settings, reporting, total] = await Promise.all([
    loadRentReportingAddonSettings(auth.db, auth.userId),
    countActiveRentReportingResidents(auth.db, auth.userId),
    countCurrentRentPayingResidents(auth.db, auth.userId),
  ]);
  return NextResponse.json(
    { tier: tierResult.tier, canHoldAddon: true, enabled: settings.enabled, reporting, total },
    { headers: NO_STORE },
  );
}

export async function POST(req: Request) {
  const auth = await requireManagerRouteUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  let body: { enabled?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "Choose on or off." }, { status: 400 });

  const tierResult = await getEffectiveManagerSkuTier(auth.userId);
  if (!tierResult.ok) return NextResponse.json({ error: tierResult.error }, { status: 503 });
  if (!planTierCanHoldAddons(tierResult.tier)) {
    return NextResponse.json({ error: "Rent reporting is for Pro and Business." }, { status: 403 });
  }

  const settings = await saveRentReportingAddonEnabled(auth.db, auth.userId, body.enabled);
  const [reporting, total] = await Promise.all([
    countActiveRentReportingResidents(auth.db, auth.userId),
    countCurrentRentPayingResidents(auth.db, auth.userId),
  ]);
  return NextResponse.json(
    { tier: tierResult.tier, canHoldAddon: true, enabled: settings.enabled, reporting, total },
    { headers: NO_STORE },
  );
}
