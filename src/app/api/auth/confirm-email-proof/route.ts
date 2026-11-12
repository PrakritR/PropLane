import { NextResponse } from "next/server";
import { defaultEmailTaken } from "@/lib/personal-link/complete.server";
import { verifyEmailProof } from "@/lib/personal-link/email-proof.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store" };

/** Open a personal email proof (`/auth/confirm-email?token=`). Every failure answers the same. */
export async function POST(req: Request) {
  if (!(await rateLimit(`email-proof-ip:${clientIpFrom(req)}`, 20, 10 * 60 * 1000)).ok) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes." }, { status: 429, headers: NO_STORE });
  }
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const ok = await verifyEmailProof(createSupabaseServiceRoleClient(), typeof body?.token === "string" ? body.token : "", { emailTaken: defaultEmailTaken });
  return ok
    ? NextResponse.json({ ok: true }, { headers: NO_STORE })
    : NextResponse.json({ error: "This link is invalid or has expired." }, { status: 400, headers: NO_STORE });
}
