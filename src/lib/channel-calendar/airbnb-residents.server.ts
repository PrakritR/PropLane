import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { sealApplicantRow } from "@/lib/security/applicant-identity";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import type { ChannelCalendarImportedRange } from "@/lib/channel-calendar/types";
import { icalGuestStaysForResidents, icalStayHasEnded } from "@/lib/channel-calendar/airbnb-residents";

export { icalGuestStaysForResidents, icalStayHasEnded } from "@/lib/channel-calendar/airbnb-residents";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function upsertAirbnbResidentsFromImportedRanges(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    propertyId: string;
    propertyLabel: string;
    roomId: string;
    roomLabel: string;
    connectionId: string;
    ranges: readonly ChannelCalendarImportedRange[];
  },
): Promise<{ created: number; updated: number; skipped: number }> {
  const stays = icalGuestStaysForResidents(input.connectionId, input.ranges);
  const today = todayKey();
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const stay of stays) {
    const { data: existing } = await db
      .from("manager_application_records")
      .select("id, row_data")
      .eq("manager_user_id", input.managerUserId)
      .eq("row_data->>icalConnectionId", stay.connectionId)
      .eq("row_data->>icalSourceUid", stay.sourceUid)
      .limit(1);
    const hit = (existing ?? [])[0] as { id?: string; row_data?: Record<string, unknown> } | undefined;
    const ended = icalStayHasEnded(stay, today);
    const guestName = stay.summary;
    const axisId = normalizeApplicationAxisId(hit?.id ?? randomUUID());
    const email =
      typeof hit?.row_data?.email === "string" && hit.row_data.email.includes("@")
        ? String(hit.row_data.email)
        : `airbnb.${stay.connectionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10)}.${stay.sourceUid.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16).toLowerCase()}@import.proplane.local`;
    const row = {
      ...(hit?.row_data && typeof hit.row_data === "object" ? hit.row_data : {}),
      id: axisId,
      name: guestName,
      property: input.propertyLabel,
      stage: ended ? "Past" : "Current",
      bucket: "approved" as const,
      email,
      detail: `${input.roomLabel} · ${stay.start}`,
      propertyId: input.propertyId,
      assignedPropertyId: input.propertyId,
      assignedRoomChoice: `${input.propertyId}::${input.roomId}`,
      manuallyAdded: true,
      bookingResidency: true,
      icalConnectionId: stay.connectionId,
      icalSourceUid: stay.sourceUid,
      application: {
        ...((hit?.row_data?.application as Record<string, unknown> | undefined) ?? {}),
        propertyId: input.propertyId,
        roomChoice1: `${input.propertyId}::${input.roomId}`,
        leaseStart: stay.start,
        leaseEnd: stay.end,
        fullLegalName: guestName,
      },
      manualResidentDetails: {
        roomNumber: input.roomLabel,
        moveInDate: stay.start,
        moveOutDate: stay.end,
      },
    };
    const { error } = await db.from("manager_application_records").upsert(
      {
        id: axisId,
        manager_user_id: input.managerUserId,
        resident_email: email,
        row_data: sealApplicantRow(row, axisId, input.managerUserId),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (error) {
      skipped += 1;
      continue;
    }
    if (hit?.id) updated += 1;
    else created += 1;
  }
  return { created, updated, skipped };
}
