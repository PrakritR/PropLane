import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { loadTourInquiryById } from "@/lib/tour-resident-link.server";
import { completeProspectHandoffForUser } from "@/lib/auth/complete-prospect-handoff.server";
import { provisionResidentAccountByEmail } from "@/lib/auth/provision-resident-account";
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
  const { data: claim, error } = await db.from("email_onboarding_handoffs").update({ status: "processing" }).eq("user_id", user.id).eq("token_digest", digest).eq("status", "pending").gt("expires_at", new Date().toISOString()).select("id, application_id, tour_inquiry_id, manager_purchase_id, intent").maybeSingle();
  if (error) return NextResponse.json({ error: "Could not finish account setup." }, { status: 503 });
  if (!claim) return NextResponse.json({ error: "Verification link expired or already used." }, { status: 409 });
  let completed = false;
  try {
    if (claim.intent === "manager_paid") {
      const { data: purchase, error: purchaseError } = await db.from("manager_purchases").select("email, user_id").eq("id", claim.manager_purchase_id).maybeSingle();
      if (purchaseError || !purchase || (purchase.user_id && purchase.user_id !== user.id) || typeof purchase.email !== "string" || purchase.email.trim().toLowerCase() !== user.email.trim().toLowerCase()) return NextResponse.json({ error: "Purchase could not be verified." }, { status: 403 });
    }
    if (claim.intent === "tour") {
      if (typeof claim.tour_inquiry_id !== "string" || !claim.tour_inquiry_id) return NextResponse.json({ error: "Tour request could not be verified." }, { status: 403 });
      const inquiry = await loadTourInquiryById(db, claim.tour_inquiry_id);
      if (!inquiry || typeof inquiry.email !== "string" || inquiry.email.trim().toLowerCase() !== user.email.trim().toLowerCase()) return NextResponse.json({ error: "Tour request could not be verified." }, { status: 403 });
      const handoff = await completeProspectHandoffForUser(db, { userId: user.id, email: user.email.trim().toLowerCase(), authEmail: user.email.trim().toLowerCase(), tourInquiryId: claim.tour_inquiry_id });
      if (!handoff.ok) return NextResponse.json({ error: "Tour request could not be verified." }, { status: handoff.status });
    }
    if (claim.application_id) {
      const { data: app, error: appError } = await db.from("manager_application_records").select("resident_email").eq("id", claim.application_id).maybeSingle();
      if (appError || !app || String(app.resident_email ?? "").trim().toLowerCase() !== user.email.trim().toLowerCase()) return NextResponse.json({ error: "Application email could not be verified." }, { status: 403 });
      const provision = await provisionResidentAccountByEmail(db, { userId: user.id, email: user.email.trim().toLowerCase(), emailProven: true, applicationId: claim.application_id, inheritFromApplication: true });
      if (!provision.ok) return NextResponse.json({ error: "Could not finish account setup." }, { status: 503 });
    }
    const updated = await db.from("email_onboarding_handoffs").update({ status: "completed" }).eq("id", claim.id).eq("user_id", user.id).eq("status", "processing").select("id").maybeSingle();
    if (updated.error || !updated.data) return NextResponse.json({ error: "Could not finish account setup." }, { status: 503 });
    completed = true;
  } finally {
    if (!completed) {
      await db.from("email_onboarding_handoffs").update({ status: "pending" }).eq("id", claim.id).eq("user_id", user.id).eq("status", "processing");
    }
  }
  const response = NextResponse.json({ ok: true });
  if (claim.intent === "resident" || claim.intent === "manager" || claim.intent === "vendor" || claim.intent === "tour" || claim.intent === "manager_paid" || claim.intent === "application") {
    response.cookies.set("proplane_signup_handoff", claim.id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 });
  }
  return response;
}
