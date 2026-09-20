import { NextRequest, NextResponse } from "next/server";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { amendLeaseMoveOutDate, hasBothLeaseSignatures } from "@/lib/lease-amendment.server";
import { notifyManagerOfLeaseRenewalRequest } from "@/lib/lease-renewal-notification.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

export const runtime = "nodejs";

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

async function propertyLabelForLease(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  leaseRecord: { property_id?: string | null; row_data: unknown },
  leaseRow: LeasePipelineRow,
): Promise<string | undefined> {
  const propertyId = leaseRecord.property_id ?? leaseRow.propertyId ?? leaseRow.application?.propertyId ?? "";
  if (!propertyId) return leaseRow.unit?.trim() || undefined;
  const { data } = await db
    .from("manager_property_records")
    .select("row_data")
    .eq("id", propertyId)
    .maybeSingle();
  const rowData = asObject(data?.row_data);
  const title = typeof rowData?.title === "string" ? rowData.title.trim() : "";
  return title || leaseRow.unit?.trim() || undefined;
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
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

    const body = await req.json() as { newLeaseEnd?: string };
    const newLeaseEnd = (body.newLeaseEnd ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newLeaseEnd)) {
      return NextResponse.json({ error: "Provide a valid newLeaseEnd (YYYY-MM-DD)." }, { status: 400 });
    }

    const { data: leaseRecords } = await db
      .from("portal_lease_pipeline_records")
      .select("id, row_data, manager_user_id, property_id, resident_email")
      .eq("resident_email", email)
      .order("updated_at", { ascending: false });

    const leaseRecord = (leaseRecords ?? []).find((r) => {
      const row = asObject(r.row_data) as unknown as LeasePipelineRow | null;
      return row && hasBothLeaseSignatures(row) && row.status !== "Voided";
    });

    if (!leaseRecord) return NextResponse.json({ error: "No fully-signed lease found." }, { status: 404 });

    const leaseRow = asObject(leaseRecord.row_data) as unknown as LeasePipelineRow;
    const result = await amendLeaseMoveOutDate(db, leaseRecord, newLeaseEnd);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

    const managerUserId = String(leaseRecord.manager_user_id ?? leaseRow.managerUserId ?? "").trim();
    if (managerUserId) {
      const propertyLabel = await propertyLabelForLease(db, leaseRecord, leaseRow);
      void notifyManagerOfLeaseRenewalRequest(db, {
        kind: "extend",
        senderUserId: user.id,
        senderEmail: email,
        senderName: typeof profile?.full_name === "string" ? profile.full_name : leaseRow.residentName,
        managerUserId,
        leaseRow,
        propertyLabel,
        newLeaseEnd: result.newLeaseEnd,
      });
    }

    return NextResponse.json({
      ok: true,
      newLeaseEnd: result.newLeaseEnd,
      direction: result.direction,
      earlyMoveOutFee: result.earlyMoveOutFee,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
