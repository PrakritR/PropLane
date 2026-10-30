import { tourCapabilityEligible } from "@/lib/tour-resident-link.server";
import { tourCapabilityDigest } from "@/lib/auth/tour-signup-capability.server";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";
import { findApplicationForResidentSetup } from "@/lib/auth/resident-setup-token";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { memoizeEffectiveApplicationProperty } from "@/lib/rental-application/validate-application-submit.server";
import { applicationPinForLinkedForm } from "@/lib/send-forms";
import { findPendingVendorInviteByToken } from "@/lib/auth/provision-vendor-account";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
export const runtime = "nodejs";
const GENERIC = { ok: true };
export async function POST(req: Request) {
  if (!(await rateLimit(`email-onboarding:${clientIpFrom(req)}`, 5, 60_000)).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  if (Number(req.headers.get("content-length") ?? "0") > 16384) return NextResponse.json(GENERIC);
  const rawBody = await req.text().catch(() => "");
  if (rawBody.length > 16384) return NextResponse.json(GENERIC);
  const parsed = (() => { try { return JSON.parse(rawBody); } catch { return {}; } })();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return NextResponse.json(GENERIC);
  const body = parsed as { email?: unknown; applicationId?: unknown; setupToken?: unknown; intent?: unknown; tourInquiryId?: unknown; tourToken?: unknown; checkoutSessionId?: unknown; vendorInviteToken?: unknown; propertyId?: unknown; tier?: unknown; billing?: unknown; listingRoomId?: unknown; bundleId?: unknown; applicationFormId?: unknown; rentalType?: unknown };
  if (Object.values(body).some((value) => typeof value === "string" && value.length > 1024)) return NextResponse.json(GENERIC);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email.includes("@") || email.length > 254) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  // A per-IP bucket alone does not bound delivery to one mailbox across clients.
  // The shared limiter hashes the key before persistence; failure also denies.
  const recipientLimit = await rateLimit(`email-onboarding:email:${email}`, 3, 10 * 60_000).catch(() => ({ ok: false }));
  if (!recipientLimit.ok) return NextResponse.json(GENERIC);
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim();
  if (!apiKey || !from) return NextResponse.json({ error: "Email verification is unavailable." }, { status: 503 });
  const tourRequest = body.intent === "tour";
  try {
    const db = createSupabaseServiceRoleClient();
    const cleanup = await db.rpc("purge_expired_email_onboarding_handoffs");
    if (cleanup.error) return NextResponse.json({ error: "Email verification is unavailable." }, { status: 503 });
    const intent = body.intent === "resident" || body.intent === "manager" || body.intent === "vendor" || body.intent === "tour" || body.intent === "manager_paid" || body.intent === "vendor_invite" ? body.intent : "generic";
    let applicationId: string | null = null;
    let applicationSetupDigest: string | null = null;
    let tourInquiryId: string | null = null;
    let tourTokenDigest: string | null = null;
    let tourConsumedUserId: string | null = null;
    let managerPurchaseId: string | null = null;
    let vendorInviteId: string | null = null;
    if (intent === "vendor_invite") {
      if (typeof body.vendorInviteToken !== "string" || !body.vendorInviteToken.trim()) return NextResponse.json(GENERIC);
      const invite = await findPendingVendorInviteByToken(db, body.vendorInviteToken);
      if (!invite || invite.vendor_email.trim().toLowerCase() !== email) return NextResponse.json(GENERIC);
      vendorInviteId = invite.id;
    }
    let propertyId: string | null = null;
    let listingRoomId: string | null = null;
    let bundleId: string | null = null;
    let applicationFormId: string | null = null;
    const rentalType = intent === "resident" && (body.rentalType === "standard" || body.rentalType === "short_term") ? body.rentalType : null;
    const tier = intent === "manager" && (body.tier === "free" || body.tier === "pro" || body.tier === "business") ? body.tier : null;
    const billing = intent === "manager" && (body.billing === "monthly" || body.billing === "annual") ? body.billing : null;
    if (intent === "resident" && body.propertyId !== undefined) {
      if (typeof body.propertyId !== "string" || !body.propertyId.trim() || body.propertyId.length > 200) return NextResponse.json(GENERIC);
      const { data: property, error } = await db.from("manager_property_records").select("id").eq("id", body.propertyId.trim()).maybeSingle();
      if (error || !property || typeof property.id !== "string") return NextResponse.json(GENERIC);
      propertyId = property.id;
      if (body.listingRoomId !== undefined || body.bundleId !== undefined || body.applicationFormId !== undefined) {
        const loaded = await memoizeEffectiveApplicationProperty(db)(propertyId);
        const sub = loaded.ok ? loaded.property?.listingSubmission : null;
        if (!sub || sub.v !== 1) return NextResponse.json(GENERIC);
        if (body.listingRoomId !== undefined) {
          if (typeof body.listingRoomId !== "string" || !sub.rooms.some((room) => room.id === body.listingRoomId)) return NextResponse.json(GENERIC);
          listingRoomId = body.listingRoomId;
        }
        if (body.bundleId !== undefined) {
          if (typeof body.bundleId !== "string" || !(sub.bundles ?? []).some((bundle) => bundle.id === body.bundleId)) return NextResponse.json(GENERIC);
          bundleId = body.bundleId;
        }
        if (body.applicationFormId !== undefined) {
          if (typeof body.applicationFormId !== "string" || !applicationPinForLinkedForm(sub, body.applicationFormId)) return NextResponse.json(GENERIC);
          applicationFormId = body.applicationFormId;
        }
      }
    } else if (intent === "resident" && (body.listingRoomId !== undefined || body.bundleId !== undefined || body.applicationFormId !== undefined)) {
      return NextResponse.json(GENERIC);
    }
    if (intent === "manager_paid") {
      if (typeof body.checkoutSessionId !== "string" || !body.checkoutSessionId.trim() || body.checkoutSessionId.length > 255) return NextResponse.json(GENERIC);
      const { data: purchase, error } = await db.from("manager_purchases").select("id, email, user_id").eq("stripe_checkout_session_id", body.checkoutSessionId.trim()).maybeSingle();
      if (error || !purchase || typeof purchase.email !== "string" || purchase.email.trim().toLowerCase() !== email) return NextResponse.json(GENERIC);
      managerPurchaseId = purchase.id;
    }
    if (intent === "tour") {
      if (typeof body.tourInquiryId !== "string" || !body.tourInquiryId.trim() || typeof body.tourToken !== "string" || !/^[a-f0-9]{64}$/.test(body.tourToken)) return NextResponse.json({ error: "This tour invitation is unavailable. Request a new tour from the listing." }, { status: 410 });
      tourTokenDigest = tourCapabilityDigest(body.tourToken);
      const capability = await db.from("tour_signup_capabilities").select("id, inquiry_id, recipient_email, manager_user_id, property_id, tour_group_id, consumed_user_id").eq("token_digest", tourTokenDigest).eq("inquiry_id", body.tourInquiryId.trim()).eq("recipient_email", email).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (capability.error) return NextResponse.json({ error: "Tour verification is unavailable. Please try again." }, { status: 503 });
      if (!capability.data) return NextResponse.json({ error: "This tour invitation has expired or was used. Request a new tour from the listing." }, { status: 410 });
      if (!(await tourCapabilityEligible(db, capability.data))) return NextResponse.json({ error: "This tour is no longer available. Request a new tour from the listing." }, { status: 410 });
      tourConsumedUserId = capability.data.consumed_user_id;
      tourInquiryId = body.tourInquiryId.trim();
    }
    if (body.applicationId !== undefined || body.setupToken !== undefined) {
      if ((intent !== "generic" && intent !== "resident") || typeof body.applicationId !== "string" || typeof body.setupToken !== "string") return NextResponse.json(GENERIC);
      const lookup = await findApplicationForResidentSetup(db, { axisId: body.applicationId, token: body.setupToken });
      if (!lookup.ok || lookup.email !== email) return NextResponse.json(GENERIC);
      applicationId = lookup.axisId;
      applicationSetupDigest = createHash("sha256").update(body.setupToken.trim()).digest("hex");
    }
    let id = await findAuthUserIdByEmail(db, email);
    if (!id) {
      const created = await db.auth.admin.createUser({ email, password: randomBytes(48).toString("base64url"), email_confirm: false, app_metadata: { proplane_email_onboarding: true } });
      if (created.error || !created.data.user) return NextResponse.json(GENERIC);
      id = created.data.user.id;
    }
    if (tourConsumedUserId && tourConsumedUserId !== id) return NextResponse.json({ error: "This tour invitation has expired or was used. Request a new tour from the listing." }, { status: 410 });
    const found = await db.auth.admin.getUserById(id);
    const account = found.data?.user;
    if (found.error || !account) return NextResponse.json(GENERIC);
    if (!account.email_confirmed_at && account.app_metadata?.proplane_email_onboarding !== true) {
      const retired = await db.rpc("retire_unconfirmed_email_password", { p_user_id: id, p_email: email });
      if (retired.error || retired.data !== true) return NextResponse.json(GENERIC);
    }
    const recent = await db.from("email_onboarding_handoffs").select("id").eq("user_id", id).in("status", ["pending", "processing"]).gte("created_at", new Date(Date.now() - 60_000).toISOString()).gt("expires_at", new Date().toISOString()).limit(1);
    if (recent.error) return NextResponse.json({ error: "Email verification is unavailable." }, { status: 503 });
    if ((recent.data ?? []).length > 0) return NextResponse.json(GENERIC);
    let tourHandoffId: string | null = null;
    let tourPlaceholder: string | null = null;
    if (intent === "tour") {
      tourHandoffId = randomUUID();
      tourPlaceholder = randomBytes(32).toString("hex");
      const reserved = await db.rpc("preclaim_tour_email_handoff", { p_digest: tourTokenDigest, p_inquiry: tourInquiryId, p_email: email, p_user: id, p_handoff: tourHandoffId, p_placeholder: tourPlaceholder });
      if (reserved.error || reserved.data !== true) return NextResponse.json({ error: "Check your email for an existing verification link, or try again." }, { status: 503 });
    }
    const link = await db.auth.admin.generateLink({ type: "magiclink", email });
    const hash = link.data?.properties?.hashed_token;
    const verificationType = link.data?.properties?.verification_type;
    if (link.error || !hash || link.data.user?.id !== id || (verificationType !== "magiclink" && verificationType !== "signup")) return intent === "tour" ? NextResponse.json({ error: "Tour verification is unavailable. Please try again." }, { status: 503 }) : NextResponse.json(GENERIC);
    const digest = createHash("sha256").update(hash).digest("hex");
    if (intent === "tour") {
      const bound = await db.rpc("bind_tour_email_handoff", { p_user: id, p_handoff: tourHandoffId, p_placeholder: tourPlaceholder, p_digest: digest });
      if (bound.error || bound.data !== true) return NextResponse.json({ error: "Tour verification is unavailable. Please try again." }, { status: 503 });
    } else {
    const { error } = await db.from("email_onboarding_handoffs").insert({ user_id: id, application_id: applicationId, application_setup_token_digest: applicationSetupDigest, tour_inquiry_id: tourInquiryId, manager_purchase_id: managerPurchaseId, vendor_invite_id: vendorInviteId, property_id: propertyId, listing_room_id: listingRoomId, bundle_id: bundleId, application_form_id: applicationFormId, rental_type: rentalType, tier, billing, intent: applicationId ? "application" : intent, token_digest: digest, expires_at: new Date(Date.now() + 3600000).toISOString() });
    if (error) return NextResponse.json(GENERIC);
    }
    const href = `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/auth/confirm?token_hash=${encodeURIComponent(hash)}&type=${verificationType}`;
    let response: Response;
    try {
      response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [email], subject: "Verify your PropLane email", text: `Use this link to verify your email and continue:\n\n${href}\n\nIf you did not request this, ignore this email.` }) });
    } catch {
      return NextResponse.json({ error: "Could not send the verification email. Please try again." }, { status: 503 });
    }
    if (!response.ok) {
      console.error("Email onboarding delivery failed", response.status);
      return NextResponse.json({ error: "Could not send the verification email. Please try again." }, { status: 503 });
    }
  } catch {
    console.error("Email onboarding could not be started");
    if (tourRequest) return NextResponse.json({ error: "Tour verification is unavailable. Please try again." }, { status: 503 });
  }
  return NextResponse.json(GENERIC);
}
