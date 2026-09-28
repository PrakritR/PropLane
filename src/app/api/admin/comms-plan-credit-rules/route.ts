import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadCommsPlanCreditRules, saveCommsPlanCreditRule } from "@/lib/comms-billing/pool.server";
import { normalizeCommsPlanTier } from "@/lib/comms-billing/allowances";

export const runtime = "nodejs";

/**
 * PropLane admin's global per-plan messaging-credit defaults (S27): included
 * credit, whether it is shared across a funder's workspaces, and whether
 * unused credit rolls over. Seeded from `RATE_CARD` by the migration and
 * editable here from then on — this is the "global defaults" surface
 * `docs/agents/plan-entitlements.md` flagged as not yet built.
 *
 * Admin-only, service-role write, exactly like `/api/admin/manager-billing-overrides`:
 * `saveCommsPlanCreditRule` does no authorization of its own, so this route is
 * the boundary. These rules only take effect through the messaging-credit
 * pool (`COMMS_CREDIT_POOL_ENABLED`); they do not change the legacy
 * per-workspace wallet's `RATE_CARD`-driven allowance.
 */
async function requireAdminActor(): Promise<{ ok: true } | { ok: false }> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await isAdminUser(user.id))) return { ok: false };
  return { ok: true };
}

export async function GET() {
  try {
    if (!(await requireAdminActor()).ok) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const db = createSupabaseServiceRoleClient();
    const rules = await loadCommsPlanCreditRules(db);
    return NextResponse.json({ rules }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not load plan credit rules." },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request) {
  try {
    if (!(await requireAdminActor()).ok) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const tier = normalizeCommsPlanTier(typeof body?.tier === "string" ? body.tier : null);
    if (!body || typeof body.tier !== "string" || normalizeCommsPlanTier(body.tier) !== tier || !["free", "pro", "business"].includes(body.tier)) {
      return NextResponse.json({ error: "A valid tier is required." }, { status: 400 });
    }
    const includedDollars = Number(body.includedDollars);
    if (!Number.isFinite(includedDollars) || includedDollars < 0 || includedDollars > 10_000) {
      return NextResponse.json({ error: "Enter a whole-dollar included amount from $0 to $10,000." }, { status: 400 });
    }
    const db = createSupabaseServiceRoleClient();
    await saveCommsPlanCreditRule(db, tier, {
      includedCents: Math.round(includedDollars * 100),
      sharedAcrossWorkspaces: body.sharedAcrossWorkspaces === true,
      rollsOver: body.rollsOver === true,
    });
    const rules = await loadCommsPlanCreditRules(db);
    return NextResponse.json({ ok: true, rules });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not save the plan credit rule." },
      { status: 500 },
    );
  }
}
