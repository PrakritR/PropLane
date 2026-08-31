import { saveManagerAutomationSettings, normalizeManagerAutomationSettings } from "@/lib/payment-automation-settings";
import { loadManagerAutomationSettings } from "@/lib/payment-automation-settings";
import { clearReminderOverridesForUnpaidCharges } from "@/lib/payment-reminder-lifecycle.server";
import { loadVendorDispatchSettings, saveVendorDispatchSettings } from "@/lib/vendor-dispatch-settings";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { NextResponse } from "next/server";

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
  const isManager =
    roleList.includes("manager") ||
    roleList.includes("owner") ||
    roleList.includes("pro") ||
    legacy === "manager" ||
    legacy === "admin" ||
    legacy === "owner" ||
    legacy === "pro";
  if (!isManager) return null;
  return { db, userId: user.id };
}

export async function GET() {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const [settings, vendorDispatch] = await Promise.all([
      loadManagerAutomationSettings(ctx.db, ctx.userId),
      loadVendorDispatchSettings(ctx.db, ctx.userId),
    ]);
    return NextResponse.json({ settings, vendorDispatch });
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
    const { vendorDispatch: vendorDispatchPatch, applyReminderScope, ...rest } = body;

    let settings = await loadManagerAutomationSettings(ctx.db, ctx.userId);
    if (Object.keys(rest).length > 0) {
      settings = await saveManagerAutomationSettings(
        ctx.db,
        ctx.userId,
        normalizeManagerAutomationSettings({ ...settings, ...rest }),
      );
    }

    let clearedOverrides = 0;
    if (applyReminderScope === "future_and_existing") {
      clearedOverrides = await clearReminderOverridesForUnpaidCharges(ctx.db, ctx.userId);
    }

    let vendorDispatch = await loadVendorDispatchSettings(ctx.db, ctx.userId);
    if (vendorDispatchPatch && typeof vendorDispatchPatch === "object") {
      vendorDispatch = await saveVendorDispatchSettings(ctx.db, ctx.userId, {
        ...vendorDispatch,
        ...(vendorDispatchPatch as Record<string, unknown>),
      });
    }
    return NextResponse.json({ settings, vendorDispatch, clearedOverrides });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
