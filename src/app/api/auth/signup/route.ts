import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";
import { normalizeE164 } from "@/lib/phone-e164";
import { assertPasswordMatchesExistingAuthUser } from "@/lib/auth/verify-auth-password";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Body = {
  email?: string;
  password?: string;
  fullName?: string;
  /**
   * Optional here, unlike manager-register which requires it (PRP-186).
   *
   * This route is role-agnostic — the role is chosen afterwards at
   * /auth/get-started — so it cannot know yet whether the caller will become a
   * manager, for whom a phone is load-bearing (the work number binds inbound
   * SMS to a verified cell). Storing whatever the form collected means that
   * when they DO pick manager, the number is already on the profile instead of
   * being lost at the one moment the person was willing to type it.
   */
  phone?: string;
};

/**
 * Role-agnostic account creation for the single portal sign-up screen. Creates an auth
 * user (email confirmed so they can sign in immediately) with NO role and NO portal
 * provisioning — the post-auth role step (/auth/get-started) decides manager vs resident.
 * An existing email is accepted only after verifying the password (never silently reset).
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    // Empty string when absent or unparseable; a bad number is dropped rather
    // than blocking a signup this route does not require a phone for.
    const phone = normalizeE164(typeof body.phone === "string" ? body.phone : "");

    if (!email.includes("@")) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient();
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        ...(fullName ? { full_name: fullName } : {}),
        ...(phone ? { phone } : {}),
      },
    });

    if (createErr) {
      const exists =
        createErr.message.toLowerCase().includes("already") ||
        createErr.message.toLowerCase().includes("registered");
      if (!exists) {
        return NextResponse.json({ error: createErr.message }, { status: 400 });
      }
      const existingId = await findAuthUserIdByEmail(supabase, email);
      if (!existingId) {
        return NextResponse.json({ error: "Could not locate the existing account for this email." }, { status: 400 });
      }
      // Existing login — require the correct password so signup can't hijack or reset it.
      const pwCheck = await assertPasswordMatchesExistingAuthUser(email, password);
      if (!pwCheck.ok) {
        return NextResponse.json({ error: pwCheck.message }, { status: 401 });
      }
      return NextResponse.json({ ok: true, existingAccount: true });
    }

    // Best-effort: the account exists either way, so a failed profile write
    // must not fail the signup. Mirrors manager-register, which writes the same
    // column after creating the user.
    const newUserId = created?.user?.id;
    if (phone && newUserId) {
      await supabase.from("profiles").update({ phone }).eq("id", newUserId);
    }

    return NextResponse.json({ ok: true, existingAccount: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not create your account.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
