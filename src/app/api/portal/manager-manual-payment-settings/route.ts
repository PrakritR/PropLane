import { NextResponse } from "next/server";

import {
  loadManagerManualPaymentSettings,
  managerManualPaymentSettingsPublic,
  isValidZelleContact,
  normalizeManagerManualPaymentSettings,
  resolveSavedServiceFeeSelection,
  saveManagerManualPaymentSettings,
} from "@/lib/manager-manual-payment-settings";
import { applyManagerManualPaymentsToListings } from "@/lib/manager-manual-payment-settings.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

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

export async function GET() {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const settings = await loadManagerManualPaymentSettings(ctx.db, ctx.userId);
    return NextResponse.json({ settings: managerManualPaymentSettingsPublic(settings) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json()) as Record<string, unknown>;
    const { propertyIds, ...rest } = body;
    const normalized = normalizeManagerManualPaymentSettings(rest);
    if (normalized.zellePaymentsEnabled && !isValidZelleContact(normalized.zelleContact)) {
      return NextResponse.json({ error: "Enter a valid Zelle phone number or email address." }, { status: 400 });
    }
    // Refuse a PropLane-absorbed selection without the promo code instead of saving a
    // quietly downgraded one: `saveManagerManualPaymentSettings` would store `resident`
    // and answer 200, so the manager would be told their fees are covered when they are
    // not. The save keeps its own guard; this only makes the refusal visible.
    // Only a PropLane-absorbed selection needs the stored value, and the save loads it
    // again anyway — so every ordinary save keeps its single read (egress is a real
    // constraint here, see AGENTS.md).
    const storedSettings =
      normalized.serviceFeePayer === "proplane"
        ? await loadManagerManualPaymentSettings(ctx.db, ctx.userId)
        : null;
    if (
      normalized.serviceFeePayer === "proplane" &&
      resolveSavedServiceFeeSelection(normalized, storedSettings).serviceFeePayer !== "proplane"
    ) {
      return NextResponse.json(
        { error: "Enter your PropLane promo code to have PropLane cover the processing fee." },
        { status: 400 },
      );
    }
    const settings = await saveManagerManualPaymentSettings(
      ctx.db,
      ctx.userId,
      normalized,
    );
    const requestedPropertyIds = Array.isArray(propertyIds)
      ? propertyIds.filter((id): id is string => typeof id === "string")
      : undefined;
    if (requestedPropertyIds?.length === 0) {
      return NextResponse.json({ error: "Select at least one property." }, { status: 400 });
    }
    const propagation = requestedPropertyIds
      ? await applyManagerManualPaymentsToListings(ctx.db, ctx.userId, settings, requestedPropertyIds)
      : { listingsUpdated: 0, chargesUpdated: 0 };
    return NextResponse.json({
      settings: managerManualPaymentSettingsPublic(settings),
      listingsUpdated: propagation.listingsUpdated,
      chargesUpdated: propagation.chargesUpdated,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
