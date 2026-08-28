import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import {
  loadManagerManualPaymentSettings,
  saveAdminServiceFeeOverride,
} from "@/lib/manager-manual-payment-settings";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { normalizeManagerSkuTier } from "@/lib/manager-access";
import { resolveServiceFeePayerFor, type ServiceFeePayer } from "@/lib/payment-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * PropLane staff's control over who pays a manager's payment processing fees.
 *
 * This is the ONLY way `proplane` can be selected below the Business plan — PropLane absorbing
 * Stripe's cost so that neither the resident nor the manager is charged. It is therefore staff
 * spending PropLane's own money, and the authorization is checked here on every request rather
 * than inherited from anything the client sends.
 *
 * `saveAdminServiceFeeOverride` deliberately does no authorization of its own, matching every
 * other service-role writer, so this route is the boundary.
 */
async function requireAdminActor(): Promise<{ ok: true; actorId: string } | { ok: false }> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await isAdminUser(user.id))) return { ok: false };
  return { ok: true, actorId: user.id };
}

function readManagerId(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * `null` is a real, distinct value here: it CLEARS the override, returning the manager to the
 * plan-and-choice rule. Pinning "resident" is a different act that fixes the answer whatever the
 * manager later chooses, so the two must not collapse into one.
 */
function readOverride(raw: unknown): { ok: true; value: ServiceFeePayer | null } | { ok: false } {
  if (raw === null) return { ok: true, value: null };
  if (raw === "resident" || raw === "manager" || raw === "proplane") return { ok: true, value: raw };
  return { ok: false };
}

/** What staff currently see for one manager: their own choice, the override, and the net effect. */
export async function GET(req: Request) {
  try {
    if (!(await requireAdminActor()).ok) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const managerUserId = readManagerId(new URL(req.url).searchParams.get("managerUserId"));
    if (!managerUserId) return NextResponse.json({ error: "managerUserId is required." }, { status: 400 });

    const db = createSupabaseServiceRoleClient();
    const settings = await loadManagerManualPaymentSettings(db, managerUserId);
    const { tier: rawTier } = await getManagerPurchaseSku(managerUserId);
    const tier = normalizeManagerSkuTier(rawTier) ?? "free";

    return NextResponse.json({
      managerUserId,
      tier,
      managerChoice: settings.serviceFeePayer,
      adminOverride: settings.adminServiceFeeOverride ?? null,
      // The net answer, computed by the same resolver the charge paths use, so the screen can
      // never disagree with what a resident is actually billed.
      effectivePayer: resolveServiceFeePayerFor({
        tier,
        adminOverride: settings.adminServiceFeeOverride,
        managerChoice: settings.serviceFeePayer,
      }),
    });
  } catch {
    return NextResponse.json({ error: "Could not load fee settings." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const actor = await requireAdminActor();
    if (!actor.ok) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const managerUserId = readManagerId(body.managerUserId);
    if (!managerUserId) return NextResponse.json({ error: "managerUserId is required." }, { status: 400 });

    const override = readOverride(body.adminOverride);
    if (!override.ok) {
      // An unrecognised value is rejected rather than coerced: silently reading it as "resident"
      // would report success while doing something other than what was asked.
      return NextResponse.json(
        { error: "adminOverride must be resident, manager, proplane, or null." },
        { status: 400 },
      );
    }

    const db = createSupabaseServiceRoleClient();
    const saved = await saveAdminServiceFeeOverride(db, managerUserId, override.value);
    const { tier: rawTier } = await getManagerPurchaseSku(managerUserId);
    const tier = normalizeManagerSkuTier(rawTier) ?? "free";

    return NextResponse.json({
      ok: true,
      managerUserId,
      adminOverride: saved.adminServiceFeeOverride ?? null,
      effectivePayer: resolveServiceFeePayerFor({
        tier,
        adminOverride: saved.adminServiceFeeOverride,
        managerChoice: saved.serviceFeePayer,
      }),
    });
  } catch {
    return NextResponse.json({ error: "Could not save fee settings." }, { status: 500 });
  }
}
