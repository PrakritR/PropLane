import { NextRequest, NextResponse } from "next/server";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import type { ManagerListingSubmissionV1, ManagerRoomUnavailableRange } from "@/lib/manager-listing-submission";

export const runtime = "nodejs";

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}
function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function hasBothSignatures(row: LeasePipelineRow): boolean {
  const mgr = row.managerSignature as Record<string, unknown> | null | undefined;
  const res = row.residentSignature as Record<string, unknown> | null | undefined;
  const legacyName = typeof row.signatureName === "string" ? row.signatureName : null;
  const legacyAt = typeof row.signedAtIso === "string" ? row.signedAtIso : null;
  return Boolean(mgr?.name && mgr?.signedAtIso && ((res?.name && res?.signedAtIso) || (legacyName && legacyAt)));
}

function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
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
    const currentEnd = leaseRow.application?.leaseEnd ?? "";
    const currentStart = leaseRow.application?.leaseStart ?? "";

    const direction = newLeaseEnd < currentEnd ? "decrease" : newLeaseEnd > currentEnd ? "extend" : "same";

    if (direction === "decrease") {
      // Early termination — always allowed but may incur a fee. No availability check needed.
      if (currentStart && newLeaseEnd < currentStart) {
        return NextResponse.json({
          available: false,
          direction,
          reason: "New move-out date cannot be before the lease start date.",
        });
      }
      return NextResponse.json({ available: true, direction });
    }

    if (direction === "same") {
      return NextResponse.json({ available: true, direction });
    }

    // Extension — check for conflicts in the window (currentEnd+1 .. newLeaseEnd)
    const extensionStart = (() => {
      const d = new Date(currentEnd + "T00:00:00");
      d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10);
    })();

    // Extract the room ID from the lease
    const roomChoice = leaseRow.roomChoice ?? leaseRow.application?.roomChoice1 ?? "";
    const sep = "::";
    const sepIdx = roomChoice.indexOf(sep);
    const roomId = sepIdx >= 0 ? roomChoice.slice(sepIdx + sep.length) : null;
    const propertyId = leaseRecord.property_id ?? leaseRow.propertyId ?? "";

    if (!propertyId || !roomId) {
      return NextResponse.json({ available: true, direction });
    }

    // Fetch the property to get room data and manualUnavailableRanges
    const { data: propRecord } = await db
      .from("manager_property_records")
      .select("id, property_data, row_data")
      .eq("id", propertyId)
      .maybeSingle();

    if (propRecord) {
      const pd = asObject(propRecord.property_data);
      if (pd?.listingSubmission) {
        const rawSub = pd.listingSubmission as ManagerListingSubmissionV1;
        if (rawSub.v === 1) {
          const norm = normalizeManagerListingSubmissionV1(rawSub);
          const room = norm.rooms.find((r) => r.id === roomId);
          if (room) {
            // Check manualUnavailableRanges for overlap with the extension window
            const blocked = (room.manualUnavailableRanges ?? []).find((range: ManagerRoomUnavailableRange) =>
              rangesOverlap(extensionStart, newLeaseEnd, range.start, range.end),
            );
            if (blocked) {
              return NextResponse.json({
                available: false,
                direction,
                reason: `This room has a blocked period from ${blocked.start} to ${blocked.end} set by your manager.`,
                blockedFrom: blocked.start,
                blockedTo: blocked.end,
              });
            }
          }
        }
      }
    }

    // Check if another signed (non-voided) lease for the same property+room
    // starts before the requested newLeaseEnd, which would conflict.
    const { data: otherLeases } = await db
      .from("portal_lease_pipeline_records")
      .select("id, row_data")
      .eq("property_id", propertyId)
      .neq("resident_email", email)
      .order("updated_at", { ascending: false });

    for (const rec of otherLeases ?? []) {
      const row = asObject(rec.row_data) as unknown as LeasePipelineRow | null;
      if (!row || !hasBothSignatures(row) || row.status === "Voided") continue;

      // Match room
      const otherRoomChoice = row.roomChoice ?? row.application?.roomChoice1 ?? "";
      const otherSepIdx = otherRoomChoice.indexOf(sep);
      const otherRoomId = otherSepIdx >= 0 ? otherRoomChoice.slice(otherSepIdx + sep.length) : null;
      if (otherRoomId !== roomId) continue;

      const otherStart = asString(row.application?.leaseStart);
      const otherEnd = asString(row.application?.leaseEnd);
      if (!otherStart) continue;

      // If the other lease starts within the extension window, there's a conflict
      if (rangesOverlap(extensionStart, newLeaseEnd, otherStart, otherEnd || "9999-12-31")) {
        const nextFree = otherEnd ? otherEnd : null;
        return NextResponse.json({
          available: false,
          direction,
          reason: `This room is already booked by another resident starting ${otherStart}.`,
          nextAvailableDate: nextFree,
        });
      }
    }

    return NextResponse.json({ available: true, direction });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
