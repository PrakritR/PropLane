import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { assertSettingsScopeOwned, trackSettingsScopeChanged } from "@/lib/scope/settings-scope";
import { applyLateFeeToListings } from "@/lib/manager-listing-late-fee-settings.server";
import { parseSanitizedMoneyNumber, sanitizeMoneyInput } from "@/lib/listing-form-inputs";

export const runtime = "nodejs";

const ANALYTICS_MODULE = "late_fees";
const GRACE_MIN_DAYS = 1;
const GRACE_MAX_DAYS = 30;

function clampGraceDays(n: number): number {
  if (!Number.isFinite(n)) return 5;
  return Math.min(GRACE_MAX_DAYS, Math.max(GRACE_MIN_DAYS, Math.round(n)));
}

async function requireManager() {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  const [{ data: profile }, { data: roles }] = await Promise.all([
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", user.id),
  ]);
  const roleList = (roles ?? []).map((r) => String(r.role).toLowerCase());
  const legacy = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const isManager = roleList.includes("manager") || legacy === "manager" || legacy === "admin";
  if (!isManager) return null;
  return { db, userId: user.id };
}

/**
 * Late fee amount + grace days apply to a LIST of properties at once — every
 * property in scope when the Payments settings bar is set to "All properties
 * in <workspace>", or the explicit selection when the manager picked houses.
 *
 * Ids in the body are never authorization: every id is re-checked with
 * `assertSettingsScopeOwned` BEFORE anything writes, and the first id that
 * fails refuses the whole request — none of the properties named in the same
 * request are touched. `applyLateFeeToListings` re-derives ownership again at
 * the database layer as a second, independent check.
 */
export async function POST(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      propertyIds?: unknown;
      lateFeeAmount?: unknown;
      lateFeeGraceDays?: unknown;
      workspaceId?: unknown;
    };

    const propertyIds = Array.isArray(body.propertyIds)
      ? [...new Set(body.propertyIds.map((id) => String(id).trim()).filter(Boolean))]
      : [];
    if (propertyIds.length === 0) {
      return NextResponse.json({ error: "Pick at least one property." }, { status: 400 });
    }

    const amount = sanitizeMoneyInput(String(body.lateFeeAmount ?? ""));
    if (parseSanitizedMoneyNumber(amount) <= 0) {
      return NextResponse.json({ error: "Enter a late fee amount." }, { status: 400 });
    }
    const graceDays = clampGraceDays(Number(body.lateFeeGraceDays));

    for (const propertyId of propertyIds) {
      const access = await assertSettingsScopeOwned(ctx.db, ctx.userId, { propertyId });
      if (!access.ok) {
        return NextResponse.json({ error: access.error }, { status: access.status });
      }
    }

    const result = await applyLateFeeToListings(ctx.db, ctx.userId, propertyIds, { amount, graceDays });
    if (result.missingPropertyIds.length > 0) {
      return NextResponse.json({ error: "One or more of those properties could not be found." }, { status: 404 });
    }

    const workspaceId = typeof body.workspaceId === "string" && body.workspaceId.trim() ? body.workspaceId.trim() : null;
    await trackSettingsScopeChanged(ctx.db, ctx.userId, {
      module: ANALYTICS_MODULE,
      rung: "property",
      ownerUserId: ctx.userId,
      workspaceId,
      count: result.listingsUpdated,
    });

    return NextResponse.json({
      listingsUpdated: result.listingsUpdated,
      lateFeeAmount: amount,
      lateFeeGraceDays: graceDays,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
