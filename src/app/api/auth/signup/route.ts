import { normalizeE164 } from "@/lib/phone-e164";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Body = { email?: string; fullName?: string; phone?: string };

/** Role selection begins only after the mailbox owner has signed in. */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email.includes("@")) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }

    const auth = await createSupabaseServerClient();
    const { data: { user } } = await auth.auth.getUser();
    if (!user?.email_confirmed_at || user.email?.trim().toLowerCase() !== email) {
      return NextResponse.json({ error: "Verify your email and sign in before continuing.", code: "EMAIL_VERIFICATION_REQUIRED" }, { status: 403 });
    }
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    const phone = normalizeE164(typeof body.phone === "string" ? body.phone : "");
    if (fullName || phone) {
      const db = createSupabaseServiceRoleClient();
      const updated = await db.auth.admin.updateUserById(user.id, { user_metadata: { ...(user.user_metadata ?? {}), ...(fullName ? { full_name: fullName } : {}), ...(phone ? { phone } : {}) } });
      if (updated.error) return NextResponse.json({ error: "Could not save your details." }, { status: 503 });
    }
    return NextResponse.json({ ok: true, existingAccount: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not create your account.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
