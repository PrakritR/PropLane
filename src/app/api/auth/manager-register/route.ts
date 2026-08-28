import { normalizeE164 } from "@/lib/twilio";
import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";
import {
  findManagerPurchaseForAccount,
  isManagerOnboardingComplete,
  provisionPendingManagerAccount,
} from "@/lib/auth/manager-onboarding";
import { completeManagerSignupTrial, isManagerSignupTrialTier } from "@/lib/auth/manager-signup-trial";
import { primaryRoleWhenAddingManager } from "@/lib/auth/profile-primary-role";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { resolveManagerPortalEntryPath } from "@/lib/auth/manager-google-services-onboarding.server";
import { assertPasswordMatchesExistingAuthUser } from "@/lib/auth/verify-auth-password";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Body = {
  email?: string;
  password?: string;
  fullName?: string;
  phone?: string;
  tier?: string;
};

/**
 * Creates a new manager account for email/password signup. Every new manager gets a
 * 14-day Pro trial (no card) unless the client sends an explicit `tier` (e.g. free).
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    const phone = normalizeE164(typeof body.phone === "string" ? body.phone : "");
    const tierRaw = typeof body.tier === "string" ? body.tier.toLowerCase().trim() : "";

    if (!email.includes("@")) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    if (!fullName) {
      return NextResponse.json({ error: "Enter your full name." }, { status: 400 });
    }
    if (!phone) {
      return NextResponse.json({ error: "Enter a valid phone number." }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient();

    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { role: "manager", full_name: fullName },
    });

    let userId: string;

    if (createErr) {
      const exists =
        createErr.message.toLowerCase().includes("already") ||
        createErr.message.toLowerCase().includes("registered");
      if (!exists) {
        return NextResponse.json({ error: createErr.message }, { status: 400 });
      }
      const existingId = await findAuthUserIdByEmail(supabase, email);
      if (!existingId) {
        return NextResponse.json({ error: "Could not locate existing account for this email." }, { status: 400 });
      }
      const pwCheck = await assertPasswordMatchesExistingAuthUser(email, password);
      if (!pwCheck.ok) {
        return NextResponse.json({ error: pwCheck.message }, { status: 401 });
      }
      userId = existingId;
    } else {
      if (!created?.user?.id) {
        return NextResponse.json({ error: "Could not create account." }, { status: 500 });
      }
      userId = created.user.id;
    }

    const existingPurchase = await findManagerPurchaseForAccount(supabase, userId, email);
    if (existingPurchase && isManagerOnboardingComplete(existingPurchase)) {
      const { data: existingProfile } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
      const { error: linkProfileErr } = await supabase.from("profiles").upsert(
        {
          id: userId,
          email,
          role: primaryRoleWhenAddingManager(existingProfile?.role as string | undefined),
          manager_id: existingProfile?.manager_id?.trim() || existingPurchase.manager_id,
          full_name: fullName || existingProfile?.full_name || existingPurchase.full_name || null,
          application_approved: existingProfile?.application_approved ?? true,
        },
        { onConflict: "id" },
      );
      if (linkProfileErr) {
        return NextResponse.json({ error: linkProfileErr.message }, { status: 500 });
      }
      await ensureProfileRoleRow(supabase, userId, "manager");
      await supabase.from("profiles").update({ phone }).eq("id", userId);
      if (!existingPurchase.user_id) {
        await supabase
          .from("manager_purchases")
          .update({ user_id: userId })
          .eq("id", existingPurchase.id);
      }
      return NextResponse.json({
        ok: true,
        managerId: existingPurchase.manager_id,
        redirectTo: await resolveManagerPortalEntryPath(supabase, userId),
        existingAccount: true,
      });
    }

    const { managerId } = await provisionPendingManagerAccount(supabase, {
      userId,
      email,
      fullName,
    });
    // Notifications text this number automatically (STOP always honored).
    await supabase.from("profiles").update({ phone }).eq("id", userId);

    const trialTier = isManagerSignupTrialTier(tierRaw) ? tierRaw : "pro";
    await completeManagerSignupTrial(supabase, { userId, email, fullName, tier: trialTier });
    return NextResponse.json({
      ok: true,
      managerId,
      redirectTo: await resolveManagerPortalEntryPath(supabase, userId),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not create manager account.";
    const status = message.includes("already exists") ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
