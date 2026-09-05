import { NextRequest, NextResponse } from "next/server";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { checkMoveOutAvailabilityForLease } from "@/lib/lease-amendment.server";

export const runtime = "nodejs";

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}
function hasBothSignatures(row: LeasePipelineRow): boolean {
  const mgr = row.managerSignature as Record<string, unknown> | null | undefined;
  const res = row.residentSignature as Record<string, unknown> | null | undefined;
  const legacyName = typeof row.signatureName === "string" ? row.signatureName : null;
  const legacyAt = typeof row.signedAtIso === "string" ? row.signedAtIso : null;
  return Boolean(mgr?.name && mgr?.signedAtIso && ((res?.name && res?.signedAtIso) || (legacyName && legacyAt)));
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
    const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();
    const isResident = await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role });
    if (!isResident) return NextResponse.json({ error: "Residents only." }, { status: 403 });
    if (!email) return NextResponse.json({ error: "No email on file." }, { status: 400 });

    const body = await req.json() as { newLeaseEnd?: string };
    const newLeaseEnd = (body.newLeaseEnd ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newLeaseEnd)) {
      return NextResponse.json({ error: "Provide a valid newLeaseEnd (YYYY-MM-DD)." }, { status: 400 });
    }

    // Find the resident's fully-signed lease
    const { data: leaseRecords } = await db
      .from("portal_lease_pipeline_records")
      .select("id, row_data, manager_user_id, property_id")
      .eq("resident_email", email)
      .order("updated_at", { ascending: false });

    const leaseRecord = (leaseRecords ?? []).find((r) => {
      const row = asObject(r.row_data) as unknown as LeasePipelineRow | null;
      return row && hasBothSignatures(row) && row.status !== "Voided";
    });

    if (!leaseRecord) {
      return NextResponse.json({ available: true, direction: "extend" });
    }

    const leaseRow = leaseRecord.row_data as unknown as LeasePipelineRow;

    // ONE implementation, shared with the manager amend path, so the capacity rule
    // and the disclosure rule cannot drift apart between the two surfaces — they
    // were previously duplicated line for line and both had to be fixed together.
    //
    // "resident" audience: a refusal names no roommate, no lease dates and no
    // next-available date. Under per-bed rentals a same-room peer reaches this code
    // path routinely, and the caller controls newLeaseEnd, so any peer date returned
    // here could be binary-searched straight out of the endpoint.
    const availability = await checkMoveOutAvailabilityForLease(
      db,
      leaseRow,
      leaseRecord,
      newLeaseEnd,
      email,
      "resident",
    );

    if (availability.ok) {
      return NextResponse.json({ available: true, direction: availability.direction });
    }
    return NextResponse.json({
      available: false,
      direction: availability.direction,
      reason: availability.reason,
      nextAvailableDate: availability.nextAvailableDate ?? null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
