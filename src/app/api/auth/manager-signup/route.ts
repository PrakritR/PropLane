import { isManagerOnboardingComplete } from "@/lib/auth/manager-onboarding";
import { normalizeE164 } from "@/lib/phone-e164";
import { claimManagerPurchase } from "@/lib/auth/claim-manager-purchase.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { track } from "@/lib/analytics/posthog";
import { primaryRoleWhenAddingManager } from "@/lib/auth/profile-primary-role";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { checkoutSessionIndicatesPaidPurchase, recordPaidManagerCheckoutSession } from "@/lib/manager-purchase-from-session";
import { isAxisIntentSessionId } from "@/lib/manager-signup-intent";
import { getStripe } from "@/lib/stripe/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Body = { sessionId: string; fullName?: string; phone?: string };

export async function POST(req: Request) {
  try {
    const { sessionId, fullName: rawName, phone: rawPhone } = (await req.json()) as Body;
    if (!sessionId || typeof sessionId !== "string") {
      return NextResponse.json({ error: "sessionId is required." }, { status: 400 });
    }

    const auth = await createSupabaseServerClient();
    const { data: { user } } = await auth.auth.getUser();
    if (!user?.email_confirmed_at || !user.email) return NextResponse.json({ error: "Verify your email and sign in before continuing.", code: "EMAIL_VERIFICATION_REQUIRED" }, { status: 403 });
    const submittedName = typeof rawName === "string" ? rawName.trim() : "";
    const submittedPhone = normalizeE164(typeof rawPhone === "string" ? rawPhone : "");
    if (!submittedName || !submittedPhone) return NextResponse.json({ error: "Enter your full name and a valid phone number." }, { status: 400 });

    const supabase = createSupabaseServiceRoleClient();

    if (isAxisIntentSessionId(sessionId)) {
      const { data: purchase, error: pErr } = await supabase
        .from("manager_purchases")
        .select("id, email, manager_id, user_id, full_name, tier, billing, stripe_checkout_session_id, paid_at")
        .eq("stripe_checkout_session_id", sessionId)
        .maybeSingle();

      if (pErr || !purchase) {
        return NextResponse.json({ error: "Could not load signup for this link." }, { status: 400 });
      }
      if (!isManagerOnboardingComplete(purchase)) return NextResponse.json({ error: "Signup is not complete yet." }, { status: 409 });
      if (purchase.user_id && purchase.user_id !== user.id) {
        return NextResponse.json({ error: "This signup link was already used." }, { status: 409 });
      }

      const email = purchase.email;
      if (user.email!.trim().toLowerCase() !== email.trim().toLowerCase()) return NextResponse.json({ error: "Verify the purchase email before continuing.", code: "EMAIL_VERIFICATION_REQUIRED" }, { status: 403 });

      const userId = user.id;
      if (!(await claimManagerPurchase(supabase, purchase.id, userId, { email: purchase.email, managerId: purchase.manager_id, sessionId }))) return NextResponse.json({ error: "This purchase is already claimed." }, { status: 409 });

      const { data: existingProfile, error: profileReadError } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
      if (profileReadError) return NextResponse.json({ error: "Could not load your profile." }, { status: 503 });

      const { error: upErr } = await supabase.from("profiles").upsert(
        {
          id: userId,
          email,
          role: primaryRoleWhenAddingManager(existingProfile?.role as string | undefined),
          manager_id: existingProfile?.manager_id?.trim() || purchase.manager_id,
          full_name: existingProfile?.full_name?.trim() || submittedName,
          phone: existingProfile?.phone?.trim() || submittedPhone,
          application_approved: existingProfile?.application_approved ?? true,
        },
        { onConflict: "id" },
      );

      if (upErr) {
        return NextResponse.json({ error: upErr.message }, { status: 500 });
      }

      await ensureProfileRoleRow(supabase, userId, "manager");


      track("manager_account_created", userId, { manager_id: purchase.manager_id, signup_method: "axis_intent" });
      return NextResponse.json({ ok: true, managerId: purchase.manager_id });
    }

    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!checkoutSessionIndicatesPaidPurchase(session)) {
      return NextResponse.json({ error: "Checkout is not paid yet. Wait a moment and try again." }, { status: 400 });
    }

    await recordPaidManagerCheckoutSession(session);

    const { data: purchase, error: pErr } = await supabase
      .from("manager_purchases")
      .select("id, email, manager_id, user_id, tier, billing, stripe_checkout_session_id, paid_at")
      .eq("stripe_checkout_session_id", sessionId)
      .maybeSingle();

    if (pErr || !purchase) {
      return NextResponse.json({ error: "Could not load purchase for this checkout session." }, { status: 400 });
    }
    if (!isManagerOnboardingComplete(purchase)) return NextResponse.json({ error: "Signup is not complete yet." }, { status: 409 });
    if (purchase.user_id && purchase.user_id !== user.id) {
      return NextResponse.json({ error: "This checkout was already used to create an account." }, { status: 409 });
    }

    const email = purchase.email;
    if (user.email!.trim().toLowerCase() !== email.trim().toLowerCase()) return NextResponse.json({ error: "Verify the purchase email before continuing.", code: "EMAIL_VERIFICATION_REQUIRED" }, { status: 403 });

    const userId = user.id;
      if (!(await claimManagerPurchase(supabase, purchase.id, userId, { email: purchase.email, managerId: purchase.manager_id, sessionId }))) return NextResponse.json({ error: "This purchase is already claimed." }, { status: 409 });

    const { data: existingProfile, error: profileReadError } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (profileReadError) return NextResponse.json({ error: "Could not load your profile." }, { status: 503 });

    const { error: upErr } = await supabase.from("profiles").upsert(
      {
        id: userId,
        email,
        role: primaryRoleWhenAddingManager(existingProfile?.role as string | undefined),
        manager_id: existingProfile?.manager_id?.trim() || purchase.manager_id,
        full_name: existingProfile?.full_name?.trim() || submittedName,
        phone: existingProfile?.phone?.trim() || submittedPhone,
        application_approved: existingProfile?.application_approved ?? true,
      },
      { onConflict: "id" },
    );

    if (upErr) {
      return NextResponse.json({ error: upErr.message }, { status: 500 });
    }

    await ensureProfileRoleRow(supabase, userId, "manager");


    track("manager_account_created", userId, { manager_id: purchase.manager_id, signup_method: "stripe" });
    return NextResponse.json({ ok: true, managerId: purchase.manager_id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Signup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
