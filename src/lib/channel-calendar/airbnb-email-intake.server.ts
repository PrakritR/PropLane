import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { airbnbResidentName, renameAirbnbResident } from "@/lib/channel-calendar/airbnb-residents.server";
import { parseConnectionRow } from "@/lib/channel-calendar/connections.server";
import { normalizeStayGuestName } from "@/lib/channel-calendar/stay-details";
import { importedRangeUid } from "@/lib/channel-calendar/stay-tombstones";
import type { ParsedAirbnbEmail } from "@/lib/inbound-email/airbnb-parser";

export type AirbnbIntakeResult =
  | { applied: true; connectionId: string; sourceUid: string }
  | { applied: false; reason: "no_match" | "write_failed" };

/**
 * Write what an Airbnb email says onto the manager's own channel stay, matched by confirmation code.
 *
 * Owner-scoped: only connections the workspace owner holds are searched, so a code in someone else's
 * mail can never touch another manager's stay. The guest name fills only an empty name (a typed name
 * wins); a booking mail sets the dates; a payout mail sets the payout and the day it landed. Nothing
 * here creates a resident charge - the payout surfaces in Incoming payments as a projection.
 */
export async function applyAirbnbEmailToStay(
  db: SupabaseClient,
  ownerUserId: string,
  parsed: ParsedAirbnbEmail,
  receivedAt: string,
): Promise<AirbnbIntakeResult> {
  const { data, error } = await db.from("external_calendar_connections").select("*").eq("manager_user_id", ownerUserId);
  if (error) return { applied: false, reason: "write_failed" };
  for (const raw of data ?? []) {
    const connection = parseConnectionRow(raw as Record<string, unknown>);
    const range = connection.imported_ranges.find((r) => r.reservationCode === parsed.confirmationCode);
    if (!range) continue;
    const sourceUid = importedRangeUid(range);

    const { data: stored, error: readError } = await db
      .from("channel_stay_details")
      .select("guest_name, notes")
      .eq("connection_id", connection.id)
      .eq("source_uid", sourceUid)
      .maybeSingle();
    if (readError) return { applied: false, reason: "write_failed" };
    const existing = stored as { guest_name?: string | null; notes?: string | null } | null;

    const patch: Record<string, unknown> = {
      connection_id: connection.id,
      source_uid: sourceUid,
      guest_name: existing?.guest_name?.trim() || normalizeStayGuestName(parsed.guestFirstName) || null,
      notes: existing?.notes ?? null,
      source: "airbnb_email",
      updated_at: new Date().toISOString(),
    };
    if (parsed.checkIn && parsed.checkOut) {
      patch.check_in = parsed.checkIn;
      patch.check_out = parsed.checkOut;
    }
    if (parsed.kind === "payout" && parsed.payoutCents) {
      patch.payout_cents = parsed.payoutCents;
      patch.currency = "USD";
      patch.paid_at = receivedAt;
    }
    const { error: writeError } = await db.from("channel_stay_details").upsert(patch, { onConflict: "connection_id,source_uid" });
    if (writeError) return { applied: false, reason: "write_failed" };
    // The resident the sync filed for this reservation takes the name in the same step that saved it.
    // The name saved above (a typed one wins) is what the resident reads, so the two never disagree.
    try {
      await renameAirbnbResident(db, {
        managerUserId: ownerUserId,
        connectionId: connection.id,
        sourceUid,
        name: airbnbResidentName({
          guestName: patch.guest_name as string | null,
          summary: range.summary,
          reservationCode: range.reservationCode,
        }),
      });
    } catch {
      // The stay details are saved; a resident row that will not rename is fixed by the next sync.
    }
    return { applied: true, connectionId: connection.id, sourceUid };
  }
  return { applied: false, reason: "no_match" };
}
