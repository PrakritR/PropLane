import { NextResponse } from "next/server";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createPersonaInquiry, personaEnabled, resumePersonaInquiry } from "@/lib/resident-identity/persona.server";
import { residentIdentityThrottle } from "@/lib/resident-identity/throttle.server";
import { residentIdentityActor } from "@/lib/resident-identity/auth.server";

export const runtime = "nodejs";

export async function GET() {
  const actor = await residentIdentityActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const [subject, review] = await Promise.all([
    actor.db.from("resident_identity_subjects").select("status, verified_at").eq("resident_user_id", actor.userId).maybeSingle(),
    actor.db.from("resident_identity_manual_reviews").select("status").eq("resident_user_id", actor.userId).in("status", ["requested", "in_review"]).maybeSingle(),
  ]);
  if (subject.error || review.error) return NextResponse.json({ error: "Verification is unavailable." }, { status: 503 });
  const status = subject.data?.status === "approved" ? "approved" : personaEnabled() ? (subject.data?.status ?? "not_started") : "unavailable";
  return NextResponse.json({ status, provider: status === "approved" ? "Persona" : null, verifiedAt: status === "approved" ? subject.data?.verified_at : null, manualReview: review.data?.status ?? null }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST() {
  if (!personaEnabled()) return NextResponse.json({ error: "Verification is unavailable." }, { status: 503 });
  const auth = await createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const throttled = await residentIdentityThrottle(user.id);
  if (throttled) return throttled;
  const db = createSupabaseServiceRoleClient();
  const { data: profile, error: profileError } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (profileError || !(await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role }))) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  const { error: subjectError } = await db.from("resident_identity_subjects").upsert({ resident_user_id: user.id }, { onConflict: "resident_user_id", ignoreDuplicates: true });
  if (subjectError) return NextResponse.json({ error: "Verification is unavailable." }, { status: 503 });
  const { data: subject, error: readError } = await db.from("resident_identity_subjects").select("status").eq("resident_user_id", user.id).single();
  if (readError) return NextResponse.json({ error: "Verification is unavailable." }, { status: 503 });
  if (subject.status === "approved") return NextResponse.json({ status: "approved" });
  const { data: inserted, error: insertError } = await db.from("resident_identity_inquiries").insert({ resident_user_id: user.id }).select("id, provider_inquiry_id, claim_key, status, created_at").maybeSingle();
  if (insertError && insertError.code !== "23505") return NextResponse.json({ error: "Verification is unavailable." }, { status: 503 });
  const { data: existing, error: existingError } = inserted ? { data: inserted, error: null } : await db.from("resident_identity_inquiries").select("id, provider_inquiry_id, claim_key, status, created_at").eq("resident_user_id", user.id).eq("active", true).maybeSingle();
  if (existingError || !existing) return NextResponse.json({ error: "Verification is unavailable." }, { status: 503 });
  if (["review", "approved", "declined"].includes(existing.status)) return NextResponse.json({ status: existing.status });
  try {
    let inquiryId = existing.provider_inquiry_id as string | null;
    if (!inquiryId) {
      // Persona prunes idempotency keys after 24h. Never retry an old claim.
      if (Date.now() - Date.parse(existing.created_at) >= 23 * 60 * 60 * 1000) return NextResponse.json({ status: "reconciliation" }, { status: 409 });
      inquiryId = await createPersonaInquiry(user.id, existing.claim_key);
      const { error } = await db.from("resident_identity_inquiries").update({ provider_inquiry_id: inquiryId, status: "pending", updated_at: new Date().toISOString() }).eq("id", existing.id).eq("resident_user_id", user.id).is("provider_inquiry_id", null);
      if (error) throw new Error("Claim persistence failed");
    }
    const url = await resumePersonaInquiry(inquiryId, user.id);
    return NextResponse.json({ status: "pending", url }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "reconciliation", error: "Verification is temporarily unavailable." }, { status: 503 });
  }
}
