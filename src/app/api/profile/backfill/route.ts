import { NextResponse } from "next/server";
import { primaryRoleWhenAddingResident } from "@/lib/auth/profile-primary-role";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadSharedLineConfig } from "@/lib/one-number/config.server";
import { legacyPhoneWriteDecision, PHONE_VERIFICATION_PATH, VERIFIED_PHONE_CHANGE_MESSAGE } from "@/lib/auth/legacy-phone-write";

export const runtime = "nodejs";

type Body = {
  fullName?: string;
  phone?: string;
  axisId?: string;
};

export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    let body: Body = {};
    try {
      body = (await req.json()) as Body;
    } catch {
      body = {};
    }

    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    const axisId = typeof body.axisId === "string" ? body.axisId.trim() : "";

    const svc = createSupabaseServiceRoleClient();
    const shared = (await loadSharedLineConfig(svc)).mode === "shared";
    const { data: existingProfile, error: profileReadError } = await svc.from("profiles").select("*").eq("id", user.id).maybeSingle();
    if (shared && profileReadError) return NextResponse.json({ error: "Could not load your profile." }, { status: 503 });
    const decision = legacyPhoneWriteDecision(existingProfile, phone || existingProfile?.phone || null, shared);
    if (decision.blocked) return NextResponse.json({ error: VERIFIED_PHONE_CHANGE_MESSAGE, redirectTo: PHONE_VERIFICATION_PATH }, { status: 409 });

    const nextProfile = {
      id: user.id,
      email: user.email?.trim().toLowerCase() ?? existingProfile?.email ?? null,
      role: primaryRoleWhenAddingResident(existingProfile?.role as string | undefined),
      full_name: fullName || existingProfile?.full_name || null,
      phone: decision.phone,
      ...(decision.clearVerification ? { phone_verified_at: null } : {}),
      manager_id: existingProfile?.manager_id ?? null,
      application_approved: existingProfile?.application_approved ?? false,
    };

    const { error: profileError } = await svc.from("profiles").upsert(nextProfile, { onConflict: "id" });
    if (profileError) {
      return NextResponse.json({ error: profileError.message }, { status: 400 });
    }

    await ensureProfileRoleRow(svc, user.id, "resident");

    if (axisId) {
      const nextMeta = { ...(user.user_metadata ?? {}), axis_id: axisId };
      const { error: authError } = await svc.auth.admin.updateUserById(user.id, { user_metadata: nextMeta });
      if (authError) {
        return NextResponse.json({ error: authError.message }, { status: 400 });
      }
    }

    return NextResponse.json({ ok: true, axisId: axisId || null });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
