/**
 * Booking notices roll over PER BOOKING (plan `channels-sync-1027`, decision D3), not per day and not as one heap.
 *
 * The owner's PropLane Assistant is ONE conversation per person per workspace (`communication-manager-assistant-thread.ts`);
 * the booking notices ("New Airbnb booking", "Airbnb booking cancelled", "Check-in tomorrow", "Check-out today") used to be
 * appended to it undifferentiated until it held hundreds. Every one of a reservation's notices now carries the SAME roll
 * key, derived from the booking record's own key, so the thread can show one reservation's booking, change and check-out
 * notices together and a second reservation never shares a group with the first. The key is stamped on the message
 * (`rollKey`); the conversation itself is deliberately NOT split: a separate `agent_notice_*` row per booking would be an
 * Assistant row the manager cannot archive or delete, and the one-Assistant-per-workspace rule would break.
 *
 * Pure and client-safe: no crypto, a stable 53-bit string hash.
 */

/** Stable, case-sensitive 53-bit hash (cyrb53) of the booking key, base36. */
function hash53(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The roll key of a booking record key (`channelStayBookingKey`, a block id, ...), or null when there is no booking. */
export function bookingNoticeRollKey(bookingKey: unknown): string | null {
  const key = typeof bookingKey === "string" ? bookingKey.trim() : "";
  return key ? `bk_${hash53(key)}` : null;
}

export type RolledNotice = { id?: string; rollKey?: string | null };

/** One reservation's notices together, in thread order. Notices with no roll key are not a booking's and are left out. */
export function groupNoticesByBooking<T extends RolledNotice>(messages: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const message of messages) {
    const key = message.rollKey?.trim();
    if (!key) continue;
    const bucket = groups.get(key) ?? [];
    bucket.push(message);
    groups.set(key, bucket);
  }
  return groups;
}
