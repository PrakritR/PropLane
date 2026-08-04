import { NextResponse } from "next/server";

import {
  loadManagerManualPaymentSettings,
  managerManualPaymentSettingsPublic,
  isValidZelleContact,
  normalizeManagerManualPaymentSettings,
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
    const settings = await saveManagerManualPaymentSettings(
      ctx.db,
      ctx.userId,
      normalized,
    );
    const requestedPropertyIds = Array.isArray(propertyIds)
      ? propertyIds.filter((id): id is string => typeof id === "string")
      : undefined;
    if (Array.isArray(propertyIds) && requestedPropertyIds.length === 0) {
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
