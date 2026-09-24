import { NextResponse } from "next/server";

import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { loadResidentLeaseSigningFeeStatus } from "@/lib/lease-signing-fee-resident.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * Resident: what the lease signing fee is for one lease, and whether this
 * resident has paid it. The amount comes from the manager's leasing-pipeline
 * settings server-side — the client never states a price.
 */
export async function GET(req: Request) {
  try {
    const leaseId = new URL(req.url).searchParams.get("leaseId")?.trim() ?? "";
    if (!leaseId) {
      return NextResponse.json({ error: "leaseId is required." }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.id) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db
      .from("profiles")
      .select("email, role")
      .eq("id", user.id)
      .maybeSingle();
    const isResident = await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role });
    if (!isResident) return NextResponse.json({ error: "Residents only." }, { status: 403 });

    const status = await loadResidentLeaseSigningFeeStatus(db, {
      leaseId,
      residentUserId: user.id,
      residentEmail: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
    });
    if (!status) return NextResponse.json({ error: "Lease not found." }, { status: 404 });

    return NextResponse.json({
      leaseId: status.leaseId,
      feeCents: status.feeCents,
      paid: status.paid,
      managerUserId: status.managerUserId,
      propertyId: status.propertyId,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
