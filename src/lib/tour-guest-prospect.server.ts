import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadMessageListing, type MessageListing } from "@/lib/listing-message/listing.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { recordInbound } from "@/lib/prospect-spine/index.server";

/**
 * A guest tour (no account; captain, Nov 14) is a prospect like any other: the spine gets ONE thread per person
 * per workspace, tagged with the house, so the manager's Communication inbox has the conversation the moment the
 * request lands. The phone is the identity and it is UNVERIFIED here - nobody proved they hold it - so nothing
 * links this thread to an account until a code is texted to that phone (`linkAccountToProspectRecord`).
 */

/** The home a guest tour is about, re-derived from the database; the request body names only an id. */
export async function loadGuestTourListing(db: SupabaseClient, propertyId: string): Promise<MessageListing | null> {
  const id = propertyId.trim();
  if (!id || id.length > 200) return null;
  const loaded = await loadMessageListing(db, { propertyId: id, roomId: null }).catch(() => null);
  return loaded && loaded.ok ? loaded.listing : null;
}

/** The line the manager reads in the thread. No phone number, no email: those are on the request itself. */
export function guestTourThreadBody(input: { name: string; propertyLabel: string; whenLabel: string; roomLabel: string }): string {
  const room = input.roomLabel ? ` (${input.roomLabel})` : "";
  const when = input.whenLabel ? ` for ${input.whenLabel}` : "";
  return `${input.name || "A renter"} requested a tour of ${input.propertyLabel}${room}${when}.`;
}

export async function recordGuestTourProspect(
  db: SupabaseClient,
  input: { listing: MessageListing; inquiryId: string; name: string; phone: string; roomLabel: string; whenLabel: string; occurredAt?: Date },
): Promise<boolean> {
  const phoneE164 = normalizeE164(input.phone);
  if (!phoneE164) return false;
  const recorded = await recordInbound(db, {
    workspaceId: input.listing.workspaceId,
    ownerUserId: input.listing.ownerUserId,
    identity: { kind: "phone", phoneE164, verified: false, displayName: input.name || null },
    context: {
      propertyId: input.listing.propertyId,
      roomId: null,
      roomLabel: input.roomLabel || null,
      source: "tour",
    },
    body: guestTourThreadBody({ name: input.name, propertyLabel: input.listing.propertyLabel, whenLabel: input.whenLabel, roomLabel: input.roomLabel }),
    channel: "in_app",
    // Idempotent on the inquiry: a retried request never writes a second line.
    eventId: `web:guest-tour:${input.inquiryId}`,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    // The manager is already told by the tour request itself; PropLane's ops alert is for texts and messages.
    notify: false,
  }).catch(() => null);
  return Boolean(recorded && recorded.ok);
}
