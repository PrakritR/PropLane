import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { airbnbResidentName, renameAirbnbResident } from "@/lib/channel-calendar/airbnb-residents.server";
import { parseConnectionRow } from "@/lib/channel-calendar/connections.server";
import { normalizeStayGuestName } from "@/lib/channel-calendar/stay-details";
import { importedRangeUid } from "@/lib/channel-calendar/stay-tombstones";
import { parseAirbnbEmail, type ParsedAirbnbEmail } from "@/lib/inbound-email/airbnb-parser";

export type AirbnbIntakeResult =
  | { applied: true; connectionId: string; sourceUid: string }
  | { applied: false; reason: "no_match" | "write_failed" | "nothing_to_apply" };

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
  options: {
    /**
     * Write the guest's name and nothing else: no dates, no payout. A confirmation the manager FORWARDED is not
     * Airbnb telling us anything, so it can name a stay in the manager's own calendar but never create or move one.
     */
    nameOnly?: boolean;
  } = {},
): Promise<AirbnbIntakeResult> {
  const nameOnly = options.nameOnly === true;
  const incomingName = normalizeStayGuestName(parsed.guestFullName || parsed.guestFirstName);
  if (nameOnly && !incomingName) return { applied: false, reason: "nothing_to_apply" };
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
      guest_name: existing?.guest_name?.trim() || incomingName || null,
      notes: existing?.notes ?? null,
      source: "airbnb_email",
      updated_at: new Date().toISOString(),
    };
    if (!nameOnly && parsed.checkIn && parsed.checkOut) {
      patch.check_in = parsed.checkIn;
      patch.check_out = parsed.checkOut;
    }
    if (!nameOnly && parsed.kind === "payout" && parsed.payoutCents) {
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

export type ForwardedAirbnbResult = AirbnbIntakeResult | { applied: false; reason: "not_authenticated" | "not_owner" | "not_airbnb" };

/**
 * A manager forwards an Airbnb confirmation to their own work email. The mail is the manager's, not Airbnb's, so
 * it is believed only this far: when the receiving server proved the sender (`authenticated`), the sender is the
 * workspace owner themselves, and the mail quotes a booking confirmation whose HM code is ALREADY one of the
 * owner's own imported reservations (the code matching is the proof the stay is theirs). It then fills the guest's
 * name on that stay (a typed name wins) and does nothing else: it can never create, move, or price a stay.
 */
export async function applyForwardedAirbnbConfirmation(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    senderUserId: string;
    authenticated: boolean;
    subject: string;
    text: string;
    receivedAt: string;
  },
): Promise<ForwardedAirbnbResult> {
  if (!input.authenticated) return { applied: false, reason: "not_authenticated" };
  if (input.senderUserId !== input.ownerUserId) return { applied: false, reason: "not_owner" };
  const parsed = parseAirbnbEmail({ subject: input.subject, text: input.text, receivedAt: input.receivedAt });
  if (!parsed || parsed.kind !== "booking" || !/airbnb/i.test(`${input.subject}\n${input.text}`)) return { applied: false, reason: "not_airbnb" };
  return applyAirbnbEmailToStay(db, input.ownerUserId, parsed, input.receivedAt, { nameOnly: true });
}
