import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { residentAchStatusResponse, residentAchVerifyResponse } from "@/lib/resident-ach-payment.server";

export const runtime = "nodejs";

async function actor() {
  const auth = await createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user?.id) return { userId: null, forbidden: false };
  const db = createSupabaseServiceRoleClient();
  const { data: profile, error } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (error || !(await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role }))) {
    return { userId: null, forbidden: true };
  }
  return { userId: user.id, forbidden: false };
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("payment_intent_id")?.trim();
  if (!id) return NextResponse.json({ error: "Missing payment_intent_id." }, { status: 400 });
  const { userId, forbidden } = await actor();
  if (!userId) return NextResponse.json({ error: forbidden ? "Resident access required." : "Not authenticated." },
    { status: forbidden ? 403 : 401 });
  return residentAchStatusResponse(id, userId);
}

export async function POST(req: Request) {
  const { userId, forbidden } = await actor();
  if (!userId) return NextResponse.json({ error: forbidden ? "Resident access required." : "Not authenticated." },
    { status: forbidden ? 403 : 401 });
  return residentAchVerifyResponse(req, userId);
}
