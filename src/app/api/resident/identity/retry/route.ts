import { NextResponse } from "next/server";
import { residentIdentityActor } from "@/lib/resident-identity/auth.server";
import { personaEnabled } from "@/lib/resident-identity/persona.server";
export const runtime = "nodejs";
export async function POST() {
  if (!personaEnabled()) return NextResponse.json({ error: "Verification is unavailable." }, { status: 503 });
  const actor = await residentIdentityActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { data, error } = await actor.db.rpc("retry_expired_resident_identity", { p_resident_user_id: actor.userId });
  if (error) return NextResponse.json({ error: "Verification is unavailable." }, { status: 503 });
  if (!data) return NextResponse.json({ error: "Inquiry cannot be retried." }, { status: 409 });
  return NextResponse.json({ status: "not_started" });
}
