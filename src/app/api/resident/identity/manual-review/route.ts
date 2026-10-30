import { NextResponse } from "next/server";
import { residentIdentityActor } from "@/lib/resident-identity/auth.server";
export const runtime = "nodejs";
export async function POST() {
  if (process.env.RESIDENT_IDENTITY_ENABLED !== "true") return NextResponse.json({ error: "Verification is unavailable." }, { status: 503 });
  const actor = await residentIdentityActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { error: subjectError } = await actor.db.from("resident_identity_subjects").upsert({ resident_user_id: actor.userId }, { onConflict: "resident_user_id", ignoreDuplicates: true });
  if (subjectError) return NextResponse.json({ error: "Verification is unavailable." }, { status: 503 });
  const { error } = await actor.db.from("resident_identity_manual_reviews").insert({ resident_user_id: actor.userId });
  if (error && error.code !== "23505") return NextResponse.json({ error: "Verification is unavailable." }, { status: 503 });
  return NextResponse.json({ status: "requested" });
}
