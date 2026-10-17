import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { sealApplicantRow } from "@/lib/security/applicant-identity";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import type { ChannelCalendarImportedRange } from "@/lib/channel-calendar/types";
import { icalGuestStaysForResidents, icalStayHasEnded } from "@/lib/channel-calendar/airbnb-residents";
import { reservationCodeForEntry } from "@/lib/channel-calendar/reservation-code";
import { normalizeStayGuestName } from "@/lib/channel-calendar/stay-details";

export { icalGuestStaysForResidents, icalStayHasEnded } from "@/lib/channel-calendar/airbnb-residents";

/** The email domain of a placeholder resident the sync filed; a row with a real address is a person's own. */
const IMPORT_EMAIL_SUFFIX = "@import.proplane.local";

/** A feed summary that names nobody ("Reserved", "Booked"), so it can never be a resident's name. */
function isGenericFeedSummary(summary: string): boolean {
  const raw = summary.trim();
  if (!raw) return true;
  if (/^(reserved|booked)$/i.test(raw)) return true;
  return /https?:\/\//i.test(raw) || reservationCodeForEntry({ source: "airbnb", summary: raw }) !== null;
}

/**
 * The name a synced reservation's resident carries, in this order: the guest name on the stay
 * (`channel_stay_details.guest_name`, typed by the manager or read off Airbnb's email), a real name
 * the feed itself carried, then "Airbnb guest · HM..." from the confirmation code. Never "Reserved".
 */
export function airbnbResidentName(input: {
  guestName?: string | null;
  summary?: string | null;
  reservationCode?: string | null;
}): string {
  const typed = normalizeStayGuestName(input.guestName);
  if (typed) return typed;
  const summary = (input.summary ?? "").trim();
  if (summary && !isGenericFeedSummary(summary)) return summary;
  const code = reservationCodeForEntry({ source: "airbnb", summary, reservationCode: input.reservationCode });
  return code ? `Airbnb guest · ${code}` : "Airbnb guest";
}

/**
 * A name this module itself invented for a reservation nobody named ("Airbnb guest", "Airbnb guest ·
 * HM..."), or a generic feed summary stored as one. Anything else on the row is a name a person put
 * there - the manager in Residents, or the guest's own account - and a sync never writes over it.
 */
function isSyncPlaceholderName(name: string): boolean {
  const raw = name.trim();
  if (!raw) return true;
  if (/^airbnb guest(\s*·.*)?$/i.test(raw)) return true;
  return isGenericFeedSummary(raw);
}

/** `source_uid -> guest_name` for one connection's typed / emailed guest names. A failed read names nobody. */
async function guestNamesForConnection(db: SupabaseClient, connectionId: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const { data, error } = await db
      .from("channel_stay_details")
      .select("source_uid, guest_name")
      .eq("connection_id", connectionId);
    if (error) return names;
    for (const row of (data ?? []) as Array<{ source_uid?: string | null; guest_name?: string | null }>) {
      const uid = String(row.source_uid ?? "").trim();
      const name = normalizeStayGuestName(row.guest_name);
      if (uid && name) names.set(uid, name);
    }
  } catch {
    // A name is a nicety: the code label still stands in.
  }
  return names;
}

/**
 * Put a guest's name on the placeholder resident filed for one reservation (matched on feed
 * connection + event UID). Only an `@import.proplane.local` placeholder is renamed - a row a real
 * person attached an account to keeps its own name. Returns whether a row was renamed.
 */
export async function renameAirbnbResident(
  db: SupabaseClient,
  input: { managerUserId: string; connectionId: string; sourceUid: string; name: string },
): Promise<boolean> {
  const name = normalizeStayGuestName(input.name);
  if (!name) return false;
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, resident_email, row_data")
    .eq("manager_user_id", input.managerUserId)
    .eq("row_data->>icalConnectionId", input.connectionId)
    .eq("row_data->>icalSourceUid", input.sourceUid);
  if (error) return false;
  let renamed = false;
  for (const hit of (data ?? []) as Array<{ id?: string; resident_email?: string | null; row_data?: Record<string, unknown> }>) {
    if (!hit.id || !hit.row_data || !String(hit.resident_email ?? "").endsWith(IMPORT_EMAIL_SUFFIX)) continue;
    // A label this module invented ("Airbnb guest", "Reserved") must not replace a name a person put here.
    const currentName = typeof hit.row_data.name === "string" ? hit.row_data.name.trim() : "";
    if (currentName && !isSyncPlaceholderName(currentName) && isSyncPlaceholderName(name)) continue;
    if (hit.row_data.name === name) continue;
    const application = (hit.row_data.application as Record<string, unknown> | undefined) ?? {};
    const row = { ...hit.row_data, name, application: { ...application, fullLegalName: name } };
    const { error: writeError } = await db
      .from("manager_application_records")
      .update({ row_data: sealApplicantRow(row, hit.id, input.managerUserId), updated_at: new Date().toISOString() })
      .eq("id", hit.id);
    if (!writeError) renamed = true;
  }
  return renamed;
}

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
  const guestNames = await guestNamesForConnection(db, input.connectionId);
  const codeByUid = new Map<string, string | undefined>();
  for (const range of input.ranges) {
    const uid = (range.sourceUid || range.id || "").trim();
    if (uid && range.reservationCode) codeByUid.set(uid, range.reservationCode);
  }
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
    // `channel_stay_details.guest_name` is the stay's own record of who is coming (typed by the manager
    // or read off Airbnb's confirmation email) and always wins. Failing that, a name already on the row
    // that this sync did not invent is a person's own - keep it, or a rename in Residents would revert
    // on the next sync (the same guard `renameAirbnbResident` applies).
    const storedName = typeof hit?.row_data?.name === "string" ? hit.row_data.name.trim() : "";
    const guestName =
      normalizeStayGuestName(guestNames.get(stay.sourceUid)) ||
      (storedName && !isSyncPlaceholderName(storedName)
        ? storedName
        : airbnbResidentName({ summary: stay.summary, reservationCode: codeByUid.get(stay.sourceUid) }));
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
