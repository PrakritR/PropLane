import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { isValidAdminRegisterKey } from "@/lib/auth/admin-register-key";
import { isPrimaryAdminEmail } from "@/lib/auth/primary-admin";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { assertPasswordMatchesExistingAuthUser } from "@/lib/auth/verify-auth-password";
import { generateAxisId } from "@/lib/manager-id";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Body = { email: string; password: string; adminKey: string; fullName?: string };

export async function POST(req: Request) {
  try {
    const { email, password, adminKey, fullName } = (await req.json()) as Body;
    if (!isValidAdminRegisterKey(adminKey ?? "")) {
      return NextResponse.json({ error: "Invalid admin registration key." }, { status: 401 });
    }
    if (!email?.trim() || !password || password.length < 8) {
      return NextResponse.json({ error: "Valid email and password (8+ chars) required." }, { status: 400 });
    }

    const auth = await createSupabaseServerClient();
    const { data: { user } } = await auth.auth.getUser();
    if (!user?.email_confirmed_at || user.email?.trim().toLowerCase() !== email.trim().toLowerCase()) return NextResponse.json({ error: "Verify your email and sign in before continuing.", code: "EMAIL_VERIFICATION_REQUIRED" }, { status: 403 });
    const normalEmail = email.trim().toLowerCase();
    if (!isPrimaryAdminEmail(normalEmail)) {
      return NextResponse.json({ error: "Admin registration is restricted to the primary PropLane admin email." }, { status: 403 });
    }

    const supabase = createSupabaseServiceRoleClient();
    let userId: string;

    const { data, error } = await supabase.auth.admin.createUser({
      email: normalEmail,
      password,
      email_confirm: true,
      user_metadata: { role: "admin" },
    });

    if (error) {
      const isAlreadyExists =
        error.message.toLowerCase().includes("already") ||
        error.message.toLowerCase().includes("registered");
      if (!isAlreadyExists) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      const { data: listData, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      if (listErr || !listData) {
        return NextResponse.json({ error: "Could not look up existing user." }, { status: 500 });
      }
      const existing = listData.users.find((u) => u.email?.toLowerCase() === normalEmail);
      if (!existing) {
        return NextResponse.json({ error: "Could not locate existing account for this email." }, { status: 400 });
      }
      const pwCheck = await assertPasswordMatchesExistingAuthUser(normalEmail, password);
      if (!pwCheck.ok) {
        return NextResponse.json({ error: pwCheck.message }, { status: 401 });
      }
      userId = existing.id;
    } else {
      if (!data.user) {
        return NextResponse.json({ error: "Could not create user." }, { status: 400 });
      }
      userId = data.user.id;
    }

    const { data: existingProfile } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
    const axisId = existingProfile?.manager_id?.trim() || generateAxisId();

    const { error: pErr } = await supabase.from("profiles").upsert(
      {
        id: userId,
        email: normalEmail,
        role: "admin",
        manager_id: axisId,
        full_name: fullName?.trim() || existingProfile?.full_name || null,
        application_approved: existingProfile?.application_approved ?? true,
      },
      { onConflict: "id" },
    );
    if (pErr) {
      return NextResponse.json({ error: pErr.message }, { status: 500 });
    }

    await ensureProfileRoleRow(supabase, userId, "admin");

    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Registration failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
