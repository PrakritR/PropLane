import { NextResponse } from "next/server";
import { residentIdentityThrottle } from "@/lib/resident-identity/throttle.server";
import { residentIdentityActor } from "@/lib/resident-identity/auth.server";
export const runtime = "nodejs";
export async function POST() {
  if (process.env.RESIDENT_IDENTITY_ENABLED !== "true") return NextResponse.json({ error: "Verification is unavailable." }, { status: 503 });
  const actor = await residentIdentityActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const throttled = await residentIdentityThrottle(actor.userId);
  if (throttled) return throttled;
  const { error: subjectError } = await actor.db.from("resident_identity_subjects").upsert({ resident_user_id: actor.userId }, { onConflict: "resident_user_id", ignoreDuplicates: true });
  if (subjectError) return NextResponse.json({ error: "Verification is unavailable." }, { status: 503 });
  const { data: created, error } = await actor.db.from("resident_identity_manual_reviews").insert({ resident_user_id: actor.userId }).select("id").maybeSingle();
  if (error && error.code !== "23505") return NextResponse.json({ error: "Verification is unavailable." }, { status: 503 });
  if (created?.id) return NextResponse.json({ status: "requested", reviewId: created.id });
  const { data: existing, error: readError } = await actor.db.from("resident_identity_manual_reviews").select("id").eq("resident_user_id", actor.userId).in("status", ["requested", "in_review"]).maybeSingle();
  if (readError || !existing?.id) return NextResponse.json({ error: "Verification is unavailable." }, { status: 503 });
  return NextResponse.json({ status: "requested", reviewId: existing.id });
}
