import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import {
  listAdminServiceFeeOverrideChanges,
  normalizeServiceFeeOverrideReason,
  recordAdminServiceFeeOverrideChange,
} from "@/lib/admin-service-fee-audit.server";
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
 *
 * Every successful write also leaves one `audit_log` row (PRP-277): who changed it, from what to
 * what, what the resident was actually billed before and after, and an optional staff-entered
 * reason. The last few rows come back on every read so the screen can show them under the
 * control.
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
    const [settings, { tier: rawTier }, changes] = await Promise.all([
      loadManagerManualPaymentSettings(db, managerUserId),
      getManagerPurchaseSku(managerUserId),
      listAdminServiceFeeOverrideChanges(db, managerUserId),
    ]);
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
      changes,
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

    const reason = normalizeServiceFeeOverrideReason(body.reason);

    const db = createSupabaseServiceRoleClient();
    // The "before" picture is read up front, with the same resolver the charge paths use, so the
    // audit row records what the resident was actually billed and not merely what was stored.
    const [before, { tier: rawTier }] = await Promise.all([
      loadManagerManualPaymentSettings(db, managerUserId),
      getManagerPurchaseSku(managerUserId),
    ]);
    const tier = normalizeManagerSkuTier(rawTier) ?? "free";
    const previousOverride = before.adminServiceFeeOverride ?? null;
    const effectiveBefore = resolveServiceFeePayerFor({
      tier,
      adminOverride: before.adminServiceFeeOverride,
      managerChoice: before.serviceFeePayer,
    });

    const saved = await saveAdminServiceFeeOverride(db, managerUserId, override.value);
    const newOverride = saved.adminServiceFeeOverride ?? null;
    const effectiveAfter = resolveServiceFeePayerFor({
      tier,
      adminOverride: saved.adminServiceFeeOverride,
      managerChoice: saved.serviceFeePayer,
    });

    // Recorded after the write, and a failed record is a failed request: staff moving a cost onto
    // PropLane must leave a trace. The client re-reads on any error rather than trusting its own
    // optimistic state, so a saved-but-unrecorded change is still shown truthfully.
    await recordAdminServiceFeeOverrideChange(db, {
      actorUserId: actor.actorId,
      managerUserId,
      previousOverride,
      newOverride,
      effectiveBefore,
      effectiveAfter,
      reason,
    });
    const changes = await listAdminServiceFeeOverrideChanges(db, managerUserId);

    return NextResponse.json({
      ok: true,
      managerUserId,
      adminOverride: newOverride,
      effectivePayer: effectiveAfter,
      changes,
    });
  } catch {
    return NextResponse.json({ error: "Could not save fee settings." }, { status: 500 });
  }
}

/** The documented verb; the same handler answers `POST` for the older client. */
export const PATCH = POST;
