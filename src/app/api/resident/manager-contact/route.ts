/**
 * The work number(s) a resident may text, for THEIR managers only.
 *
 * The caller never names a manager: it is derived server-side from the
 * resident's own tenancies, so this cannot be used to look up an arbitrary
 * manager's number. Only numbers confirmed sendable are returned — a number
 * that cannot receive a text is worse than none, because the resident texts it
 * and hears nothing.
 */
import { NextResponse } from "next/server";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { resolveResidentManagerPhones } from "@/lib/resident-manager-contact.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db
      .from("profiles")
      .select("email, role")
      .eq("id", user.id)
      .maybeSingle();
    const isResident = await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role });
    if (!isResident) return NextResponse.json({ error: "Residents only." }, { status: 403 });

    const contacts = await resolveResidentManagerPhones(db, {
      residentUserId: user.id,
      residentEmail: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
    });

    // Only what the surface renders. The manager id stays server-side: the
    // resident has no use for it and it is not theirs to hold.
    return NextResponse.json(
      {
        contacts: contacts.map((contact) => ({
          phone: contact.phone,
          propertyLabel: contact.propertyLabel,
          leaseStart: contact.leaseStart,
          leaseEnd: contact.leaseEnd,
          status: contact.status,
        })),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Could not load your manager's number." }, { status: 500 });
  }
}
