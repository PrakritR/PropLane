import { claimManagerPurchase } from "@/lib/auth/claim-manager-purchase.server";
import { isManagerOnboardingComplete } from "@/lib/auth/manager-onboarding";
import { primaryRoleWhenAddingManager } from "@/lib/auth/profile-primary-role";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { checkoutSessionIndicatesPaidPurchase, recordPaidManagerCheckoutSession } from "@/lib/manager-purchase-from-session";
import { isAxisIntentSessionId } from "@/lib/manager-signup-intent";
import { getStripe } from "@/lib/stripe/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export type CompleteManagerSignupResult =
  | { ok: true; managerId: string }
  | { ok: false; status: number; error: string };

async function linkManagerPurchase(
  supabase: SupabaseClient,
  userId: string,
  purchase: { id: string; email: string; manager_id: string; user_id: string | null; full_name?: string | null },
  fullName: string,
  userEmail: string,
  sessionId: string,
): Promise<CompleteManagerSignupResult> {
  const normalizedEmail = userEmail.trim().toLowerCase();
  if (purchase.email.trim().toLowerCase() !== normalizedEmail) {
    return {
      ok: false,
      status: 403,
      error: "Sign in with the same Google account email used at checkout.",
    };
  }

  try {
    if (!(await claimManagerPurchase(supabase, purchase.id, userId, { email: purchase.email, managerId: purchase.manager_id, sessionId }))) {
      return { ok: false, status: 409, error: "This signup link was already used." };
    }
  } catch {
    return { ok: false, status: 503, error: "Could not claim this signup. Please try again." };
  }

  const { data: existingProfile, error: profileReadError } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (profileReadError) return { ok: false, status: 503, error: "Could not read this account. Please try again." };

  const { error: upErr } = await supabase.from("profiles").upsert(
    {
      id: userId,
      email: normalizedEmail,
      role: primaryRoleWhenAddingManager(existingProfile?.role as string | undefined),
      manager_id: purchase.manager_id,
      full_name: existingProfile?.full_name || fullName || purchase.full_name?.trim() || null,
      application_approved: existingProfile?.application_approved ?? true,
    },
    { onConflict: "id" },
  );

  if (upErr) {
    return { ok: false, status: 500, error: upErr.message };
  }

  await ensureProfileRoleRow(supabase, userId, "manager");

  try {
    const { maybeSendManagerPropLaneAssistantIntro } = await import("@/lib/claw-onboarding-sms.server");
    void maybeSendManagerPropLaneAssistantIntro(supabase, userId);
  } catch {
    /* non-critical */
  }

  try {
    const { scheduleManagerMessagingReady } = await import("@/lib/proplane-sms-transport.server");
    scheduleManagerMessagingReady(userId);
  } catch {
    /* non-critical */
  }

  return { ok: true, managerId: purchase.manager_id };
}

/** Links an OAuth-authenticated user to a reserved manager purchase (post-checkout or free intent). */
export async function completeManagerSignupFromOAuth(
  supabase: SupabaseClient,
  userId: string,
  userEmail: string,
  sessionId: string,
): Promise<CompleteManagerSignupResult> {
  const verified = await supabase.auth.admin.getUserById(userId).catch(() => null);
  if (!verified) return { ok: false, status: 503, error: "Could not verify this account. Please try again." };
  if (verified.error) return { ok: false, status: 503, error: "Could not verify this account. Please try again." };
  const authUser = verified.data.user;
  if (!authUser?.email_confirmed_at || !authUser.email || authUser.email.trim().toLowerCase() !== userEmail.trim().toLowerCase()) {
    return { ok: false, status: 403, error: "Verify the checkout email before continuing." };
  }

  if (!sessionId || typeof sessionId !== "string") {
    return { ok: false, status: 400, error: "sessionId is required." };
  }

  if (isAxisIntentSessionId(sessionId)) {
    const { data: purchase, error: pErr } = await supabase
      .from("manager_purchases")
      .select("id, email, manager_id, user_id, full_name, tier, billing, stripe_checkout_session_id, paid_at")
      .eq("stripe_checkout_session_id", sessionId)
      .maybeSingle();

    if (pErr || !purchase) {
      return { ok: false, status: 400, error: "Could not load signup for this link." };
    }

    if (!isManagerOnboardingComplete(purchase)) return { ok: false, status: 409, error: "Signup is not complete yet." };
    return linkManagerPurchase(supabase, userId, purchase, purchase.full_name?.trim() ?? "", userEmail, sessionId);
  }

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId);

  if (!checkoutSessionIndicatesPaidPurchase(session)) {
    return { ok: false, status: 400, error: "Checkout is not paid yet. Wait a moment and try again." };
  }

  await recordPaidManagerCheckoutSession(session);

  const { data: purchase, error: pErr } = await supabase
    .from("manager_purchases")
    .select("id, email, manager_id, user_id, tier, billing, stripe_checkout_session_id, paid_at")
    .eq("stripe_checkout_session_id", sessionId)
    .maybeSingle();

  if (pErr || !purchase) {
    return { ok: false, status: 400, error: "Could not load purchase for this checkout session." };
  }

  if (!isManagerOnboardingComplete(purchase)) return { ok: false, status: 409, error: "Signup is not complete yet." };
  const fullName = session.metadata?.full_name?.trim() ?? "";
  return linkManagerPurchase(supabase, userId, purchase, fullName, userEmail, sessionId);
}
