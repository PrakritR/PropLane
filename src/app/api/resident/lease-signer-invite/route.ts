import { NextRequest, NextResponse } from "next/server";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { sendLeaseSignerInvite } from "@/lib/lease-signer-invite.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * C278 — the resident's own "Sign" step sends a one-way informational email
 * to a representative / legal representative / guarantor they named. See
 * `src/lib/lease-signer-invite.server.ts` for the full contract.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db
      .from("profiles")
      .select("email, role, full_name")
      .eq("id", user.id)
      .maybeSingle();
    const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();
    const isResident = await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role });
    if (!isResident) return NextResponse.json({ error: "Residents only." }, { status: 403 });
    if (!email) return NextResponse.json({ error: "No email on file." }, { status: 400 });

    const body = (await req.json()) as { leaseId?: string; roleLabel?: string; inviteEmail?: string };
    const result = await sendLeaseSignerInvite(db, {
      residentUserId: user.id,
      residentEmail: email,
      residentName: typeof profile?.full_name === "string" ? profile.full_name : undefined,
      leaseId: (body.leaseId ?? "").trim(),
      roleLabel: (body.roleLabel ?? "").trim(),
      inviteEmail: (body.inviteEmail ?? "").trim(),
    });

    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
