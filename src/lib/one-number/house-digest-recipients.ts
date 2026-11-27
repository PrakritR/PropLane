import { normalizeE164 } from "@/lib/phone-e164";

/**
 * Who gets the 7 AM check-in / check-out text, folded per PHONE (pure: no database, no clock).
 *
 * Each house that has a move today hands in its line and the people on that house (worked out on the server from
 * PropLane's records: the owner of record, the co-managers and team members whose grants put them on the house's
 * calendar notices, and for a PropLane-managed workspace the listed admin phones and staff seats). A person is one
 * normalized E.164 number: on several houses they get ONE text with only their own houses' lines, never a house they
 * are not on, and never the same house twice.
 *
 * Empty days: a house with no move today hands in no line, so a person whose houses are all quiet has an empty bucket and
 * gets no text at all (`composeServiceDigest` returns nothing for nothing). That is what the managed digest already does
 * for a day with no moves, leads or reminders, and it keeps the 7 AM text a signal instead of a daily "nothing" ping.
 */
export type HouseDigestRecipient = {
  phone: string;
  /** The person's PropLane account (consent reads THEIR verified phone); null for a listed alert phone. */
  userId: string | null;
  sendClass: "transactional" | "automated";
};

export type HouseDigestBucket = {
  phone: string;
  userId: string | null;
  sendClass: "transactional" | "automated";
  houseLines: string[];
  propertyIds: string[];
};

/**
 * Add one house's line to every recipient on that house. `scope` separates senders (one bucket per phone PER scope: the
 * PropLane line is one scope, each self-serve workspace's own work number another). The first entry for a phone keeps
 * its identity, so callers hand in listed phones before account phones (a listed number's consent is its listing).
 */
export function addHouseLineToRecipients(
  buckets: Map<string, HouseDigestBucket>,
  house: { propertyId: string; text: string },
  recipients: readonly HouseDigestRecipient[],
  scope = "",
): void {
  const text = house.text.replace(/\s+/g, " ").trim();
  const propertyId = house.propertyId.trim();
  if (!text || !propertyId) return;
  for (const r of recipients) {
    const phone = normalizeE164(r.phone);
    if (!phone) continue;
    const key = `${scope}|${phone}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { phone, userId: r.userId, sendClass: r.sendClass, houseLines: [], propertyIds: [] };
      buckets.set(key, bucket);
    }
    if (bucket.propertyIds.includes(propertyId)) continue;
    bucket.propertyIds.push(propertyId);
    bucket.houseLines.push(text);
  }
}

/** Pure: merge recipient lists into one entry per normalized number (the first entry for a number wins). */
export function dedupeDigestRecipients(...lists: ReadonlyArray<readonly HouseDigestRecipient[]>): HouseDigestRecipient[] {
  const seen = new Set<string>();
  const out: HouseDigestRecipient[] = [];
  for (const list of lists) {
    for (const r of list) {
      const phone = normalizeE164(r.phone);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      out.push({ ...r, phone });
    }
  }
  return out;
}

/**
 * Pure: a profile's phone counts only when it is VERIFIED and SMS forwarding is not off, the same pair the consent
 * gate re-checks at send time (`ensureTeamNoticeScopedSmsConsent`). Anything else is no usable phone.
 */
export function usableProfilePhone(profile: { phone?: unknown; phone_verified_at?: unknown; sms_forward_inbound?: unknown } | null | undefined): string | null {
  if (!profile) return null;
  const verified = typeof profile.phone_verified_at === "string" && profile.phone_verified_at.trim() && !Number.isNaN(Date.parse(profile.phone_verified_at));
  if (!verified || profile.sms_forward_inbound === false) return null;
  return normalizeE164(profile.phone);
}
