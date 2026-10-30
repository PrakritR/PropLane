import { claimManagerPurchase } from "@/lib/auth/claim-manager-purchase.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { primaryRoleWhenAddingManager } from "@/lib/auth/profile-primary-role";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Body = { managerId: string; email: string };

export async function POST(req: Request) {
  try {
    const { managerId, email } = (await req.json()) as Body;
    if (!managerId?.trim() || !email?.trim()) {
      return NextResponse.json({ error: "PropLane ID and email are required." }, { status: 400 });
    }

    const auth = await createSupabaseServerClient();
    const { data: { user } } = await auth.auth.getUser();
    if (!user?.email_confirmed_at || user.email?.trim().toLowerCase() !== email.trim().toLowerCase()) return NextResponse.json({ error: "Verify your email and sign in before continuing.", code: "EMAIL_VERIFICATION_REQUIRED" }, { status: 403 });
    const supabase = createSupabaseServiceRoleClient();
    const normalEmail = email.trim().toLowerCase();

    const { data: purchase, error: pErr } = await supabase
      .from("manager_purchases")
      .select("id, email, manager_id, full_name, tier, user_id")
      .eq("manager_id", managerId.trim())
      .eq("email", normalEmail)
      .maybeSingle();

    if (pErr || !purchase) {
      return NextResponse.json(
        { error: "No manager account found with that ID and email. Check your details." },
        { status: 400 },
      );
    }

    if (purchase.user_id && purchase.user_id !== user.id) {
      return NextResponse.json(
        { error: "This PropLane ID is already activated. Sign in instead." },
        { status: 409 },
      );
    }

    const userId = user.id;
    if (!(await claimManagerPurchase(supabase, purchase.id, userId))) return NextResponse.json({ error: "This purchase is already claimed." }, { status: 409 });

    const { data: existingProfile, error: profileReadError } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();

    if (profileReadError) return NextResponse.json({ error: "Could not load your profile." }, { status: 503 });
    const { error: profileError } = await supabase.from("profiles").upsert(
      {
        id: userId,
        email: normalEmail,
        role: primaryRoleWhenAddingManager(existingProfile?.role as string | undefined),
        manager_id: purchase.manager_id,
        full_name: purchase.full_name || existingProfile?.full_name || null,
        application_approved: existingProfile?.application_approved ?? true,
      },
      { onConflict: "id" },
    );

    if (profileError) return NextResponse.json({ error: "Could not complete your profile." }, { status: 503 });
    await ensureProfileRoleRow(supabase, userId, "manager");

    return NextResponse.json({ ok: true, managerId: purchase.manager_id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Activation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
