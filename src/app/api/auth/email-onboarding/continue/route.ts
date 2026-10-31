import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export async function POST() {
  const jar = await cookies();
  const id = jar.get("proplane_signup_handoff")?.value ?? "";
  const empty = () => { const response = NextResponse.json({ role: null }); response.cookies.delete("proplane_signup_handoff"); return response; };
  if (!/^[0-9a-f-]{36}$/i.test(id)) return empty();
  const auth = await createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user?.id || !user.email_confirmed_at) return empty();
  const db = createSupabaseServiceRoleClient();
  const { data, error } = await db.from("email_onboarding_handoffs")
    .select("intent, application_id, tour_inquiry_id, manager_purchase_id, vendor_invite_id, property_id, listing_room_id, bundle_id, application_form_id, rental_type, tier, billing")
    .eq("id", id).eq("user_id", user.id).in("status", ["completed", "consumed"])
    .gt("expires_at", new Date().toISOString()).maybeSingle();
  if (error) return NextResponse.json({ error: "Could not continue account setup." }, { status: 503 });
  if (!data) return empty();
  let payload: Record<string, unknown> | null = null;
  if (data.intent === "application" && typeof data.application_id === "string") {
    payload = { role: "application", applicationId: data.application_id };
  } else if (data.intent === "tour" && typeof data.tour_inquiry_id === "string") {
    payload = { role: "tour", tourInquiryId: data.tour_inquiry_id };
  } else if (data.intent === "vendor_invite" && data.vendor_invite_id) {
    const { data: invite, error: inviteError } = await db.from("vendor_invites").select("vendor_email, status, expires_at, invite_token").eq("id", data.vendor_invite_id).maybeSingle();
    if (inviteError) return NextResponse.json({ error: "Could not continue account setup." }, { status: 503 });
    if (invite && invite.status === "pending" && invite.expires_at && new Date(invite.expires_at).getTime() > Date.now() && invite.vendor_email?.trim().toLowerCase() === user.email?.trim().toLowerCase() && typeof invite.invite_token === "string") payload = { role: "vendor_invite", inviteToken: invite.invite_token };
  } else if (data.intent === "manager_paid" && data.manager_purchase_id) {
    const { data: purchase, error: purchaseError } = await db.from("manager_purchases").select("email, user_id, stripe_checkout_session_id").eq("id", data.manager_purchase_id).maybeSingle();
    if (purchaseError) return NextResponse.json({ error: "Could not continue account setup." }, { status: 503 });
    if (purchase && (!purchase.user_id || purchase.user_id === user.id) && purchase.email?.trim().toLowerCase() === user.email?.trim().toLowerCase() && typeof purchase.stripe_checkout_session_id === "string") {
      payload = { role: "manager_paid", checkoutSessionId: purchase.stripe_checkout_session_id };
    }
  } else if (data.intent === "generic" || data.intent === "resident" || data.intent === "manager" || data.intent === "vendor") {
    payload = { role: data.intent, propertyId: data.property_id, listingRoomId: data.listing_room_id, bundleId: data.bundle_id, applicationFormId: data.application_form_id, rentalType: data.rental_type, tier: data.tier, billing: data.billing };
  }
  if (!payload) return empty();
  const consumed = await db.from("email_onboarding_handoffs").update({ status: "consumed" })
    .eq("id", id).eq("user_id", user.id).in("status", ["completed", "consumed"])
    .gt("expires_at", new Date().toISOString()).select("id").maybeSingle();
  if (consumed.error) return NextResponse.json({ error: "Could not continue account setup." }, { status: 503 });
  if (!consumed.data) return empty();
  const response = NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  response.cookies.delete("proplane_signup_handoff");
  return response;
}
