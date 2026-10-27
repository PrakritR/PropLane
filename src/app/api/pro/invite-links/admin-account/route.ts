import { NextResponse } from "next/server";
import { createVerifiedAdminAccount, sendAdminInviteCode } from "@/lib/admin-team/admin-invite-proof.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * The "Create your admin account" step of an Admin team invite. Public by design (the opener has no account yet), so it
 * is keyed on the link token alone and rate limited; the address is always the one stored on the link, never one in the
 * body. `send` mails a 6-digit code to that address; `create` verifies it and only then creates the (confirmed) account.
 * The page signs in with the password afterwards and redeems the link as any signed-in opener does.
 */
export async function POST(req: Request) {
  if (!(await rateLimit(`admin-invite-account-ip:${clientIpFrom(req)}`, 30, 60_000)).ok) {
    return NextResponse.json({ error: "Too many tries. Wait a minute." }, { status: 429, headers: NO_STORE });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return NextResponse.json({ error: "That invite link is not valid." }, { status: 404, headers: NO_STORE });
  const db = createSupabaseServiceRoleClient();
  if (body.action === "send") {
    const sent = await sendAdminInviteCode(db, { token });
    if (!sent.ok) return NextResponse.json({ error: sent.error }, { status: sent.status, headers: NO_STORE });
    return NextResponse.json({ challenge: sent.challenge, expiresAt: sent.expiresAt }, { headers: NO_STORE });
  }
  if (body.action === "create") {
    const created = await createVerifiedAdminAccount(db, {
      token,
      challenge: typeof body.challenge === "string" ? body.challenge : "",
      code: typeof body.code === "string" ? body.code : "",
      fullName: typeof body.fullName === "string" ? body.fullName : "",
      phone: typeof body.phone === "string" ? body.phone : "",
      password: typeof body.password === "string" ? body.password : "",
    });
    if (!created.ok) return NextResponse.json({ error: created.error }, { status: created.status, headers: NO_STORE });
    return NextResponse.json({ ok: true, email: created.email }, { status: 201, headers: NO_STORE });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400, headers: NO_STORE });
}
