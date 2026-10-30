import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export async function POST() {
  const jar = await cookies();
  const id = jar.get("proplane_signup_handoff")?.value ?? "";
  const response = NextResponse.json({ role: null });
  response.cookies.delete("proplane_signup_handoff");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return response;
  const auth = await createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user?.id || !user.email_confirmed_at) return response;
  const db = createSupabaseServiceRoleClient();
  const { data, error } = await db.from("email_onboarding_handoffs").update({ status: "consumed" })
    .eq("id", id).eq("user_id", user.id).eq("status", "completed")
    .gt("expires_at", new Date().toISOString()).select("intent, application_id, manager_purchase_id, property_id, listing_room_id, bundle_id, application_form_id, rental_type, tier, billing").maybeSingle();
  if (!error && data?.intent === "application" && typeof data.application_id === "string") {
    const applicationResponse = NextResponse.json({ role: "application", applicationId: data.application_id });
    applicationResponse.cookies.delete("proplane_signup_handoff");
    return applicationResponse;
  }
  if (!error && data?.intent === "manager_paid" && data.manager_purchase_id) {
    const { data: purchase, error: purchaseError } = await db.from("manager_purchases").select("email, user_id, stripe_checkout_session_id").eq("id", data.manager_purchase_id).maybeSingle();
    if (!purchaseError && purchase && (!purchase.user_id || purchase.user_id === user.id) && purchase.email?.trim().toLowerCase() === user.email?.trim().toLowerCase() && typeof purchase.stripe_checkout_session_id === "string") {
      const paidResponse = NextResponse.json({ role: "manager_paid", checkoutSessionId: purchase.stripe_checkout_session_id });
      paidResponse.cookies.delete("proplane_signup_handoff");
      return paidResponse;
    }
  }
  if (!error && (data?.intent === "resident" || data?.intent === "manager" || data?.intent === "vendor" || data?.intent === "tour")) {
    const roleResponse = NextResponse.json({ role: data.intent, propertyId: data.property_id, listingRoomId: data.listing_room_id, bundleId: data.bundle_id, applicationFormId: data.application_form_id, rentalType: data.rental_type, tier: data.tier, billing: data.billing });
    roleResponse.cookies.delete("proplane_signup_handoff");
    return roleResponse;
  }
  return response;
}
