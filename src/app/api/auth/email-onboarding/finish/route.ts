import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { provisionVerifiedResidentHandoff } from "@/lib/auth/verified-resident-handoff.server";
import { linkTourFromCapability } from "@/lib/tour-resident-link.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
export const runtime = "nodejs";
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { tokenHash?: unknown };
  if (typeof body.tokenHash !== "string" || !body.tokenHash.trim()) return NextResponse.json({ error: "Invalid verification." }, { status: 400 });
  const auth = await createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user?.id || !user.email_confirmed_at || !user.email) return NextResponse.json({ error: "Sign in with your verified email." }, { status: 401 });
  const db = createSupabaseServiceRoleClient();
  const digest = createHash("sha256").update(body.tokenHash).digest("hex");
  const fields = "id, application_id, tour_inquiry_id, tour_capability_id, manager_purchase_id, vendor_invite_id, intent, status";
  const claimed = await db.from("email_onboarding_handoffs").update({ status: "processing" }).eq("user_id", user.id).eq("token_digest", digest).eq("status", "pending").gt("expires_at", new Date().toISOString()).select(fields).maybeSingle();
  if (claimed.error) return NextResponse.json({ error: "Could not finish account setup." }, { status: 503 });
  let claim = claimed.data;
  if (!claim) {
    const existing = await db.from("email_onboarding_handoffs").select(fields).eq("user_id", user.id).eq("token_digest", digest).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (existing.error) return NextResponse.json({ error: "Could not finish account setup." }, { status: 503 });
    if (!existing.data || (existing.data.status !== "processing" && existing.data.status !== "completed")) return NextResponse.json({ error: "Verification link expired or already used." }, { status: 409 });
    claim = existing.data;
  }
  if (claim.status !== "completed") {
  try {
    if (claim.intent === "vendor_invite") {
      const { data: invite, error: inviteError } = await db.from("vendor_invites").select("vendor_email, status, expires_at").eq("id", claim.vendor_invite_id).maybeSingle();
      if (inviteError || !invite || invite.status !== "pending" || !invite.expires_at || !Number.isFinite(new Date(invite.expires_at).getTime()) || new Date(invite.expires_at).getTime() <= Date.now() || invite.vendor_email?.trim().toLowerCase() !== user.email.trim().toLowerCase()) return NextResponse.json({ error: "Vendor invite could not be verified." }, { status: 403 });
    }
    if (claim.intent === "manager_paid") {
      const { data: purchase, error: purchaseError } = await db.from("manager_purchases").select("email, user_id").eq("id", claim.manager_purchase_id).maybeSingle();
      if (purchaseError || !purchase || (purchase.user_id && purchase.user_id !== user.id) || typeof purchase.email !== "string" || purchase.email.trim().toLowerCase() !== user.email.trim().toLowerCase()) return NextResponse.json({ error: "Purchase could not be verified." }, { status: 403 });
    }
    if (claim.intent === "tour") {
      if (typeof claim.tour_inquiry_id !== "string" || typeof claim.tour_capability_id !== "string") return NextResponse.json({ error: "Tour request could not be verified." }, { status: 403 });
      if (!(await provisionVerifiedResidentHandoff(db, { userId: user.id, email: user.email }))) return NextResponse.json({ error: "Could not finish account setup." }, { status: 503 });
      const linked = await linkTourFromCapability(db, { userId: user.id, email: user.email, inquiryId: claim.tour_inquiry_id, capabilityId: claim.tour_capability_id });
      if (!linked) return NextResponse.json({ error: "Tour request could not be verified." }, { status: 403 });
    }
    if (claim.application_id) {
      const { data: app, error: appError } = await db.from("manager_application_records").select("resident_email").eq("id", claim.application_id).maybeSingle();
      if (appError || !app || String(app.resident_email ?? "").trim().toLowerCase() !== user.email.trim().toLowerCase()) return NextResponse.json({ error: "Application email could not be verified." }, { status: 403 });
      const provision = await provisionVerifiedResidentHandoff(db, { userId: user.id, email: user.email, applicationId: claim.application_id });
      if (!provision) return NextResponse.json({ error: "Could not finish account setup." }, { status: 503 });
    }
    const updated = await db.from("email_onboarding_handoffs").update({ status: "completed" }).eq("id", claim.id).eq("user_id", user.id).eq("status", "processing").select("id").maybeSingle();
    if (updated.error) return NextResponse.json({ error: "Could not finish account setup." }, { status: 503 });
    if (!updated.data) {
      const concurrent = await db.from("email_onboarding_handoffs").select("status").eq("id", claim.id).eq("user_id", user.id).maybeSingle();
      if (concurrent.error || concurrent.data?.status !== "completed") return NextResponse.json({ error: "Could not finish account setup." }, { status: 503 });
    }
  } catch {
    return NextResponse.json({ error: "Could not finish account setup." }, { status: 503 });
  }
  }
  const response = NextResponse.json({ ok: true });
  if (claim.intent === "generic" || claim.intent === "resident" || claim.intent === "manager" || claim.intent === "vendor" || claim.intent === "tour" || claim.intent === "manager_paid" || claim.intent === "vendor_invite" || claim.intent === "application") {
    response.cookies.set("proplane_signup_handoff", claim.id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 });
  }
  return response;
}
