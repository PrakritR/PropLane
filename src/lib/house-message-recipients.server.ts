import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadReachByForEmails } from "@/lib/recipient-channels.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { isPhoneOptedOut } from "@/lib/sms-consent";
import {
  houseResidentsFromStays,
  type HouseProfileLike,
  type HouseRecipient,
  type HouseStayLike,
} from "@/lib/house-message-recipients";

/**
 * Who a manager reaches with "everyone living there": the current residents of ONE house, read from the
 * occupancy snapshot (the one reader Bookings uses). The caller has already proved the house belongs to the
 * workspace and that the viewer holds Communication on it; this only derives people and what each can receive.
 */
export async function loadHouseMessageRecipients(
  db: SupabaseClient,
  input: { ownerUserId: string; propertyId: string; today: string; includeGuests: boolean },
): Promise<{ people: HouseRecipient[]; excludedGuests: number; unaddressable: number }> {
  const { occupancySnapshotForManager } = await import("@/lib/occupancy/snapshot.server");
  const snapshot = await occupancySnapshotForManager(db, input.ownerUserId, {
    propertyIds: [input.propertyId],
    from: input.today,
    to: input.today,
    days: [input.today],
  });
  const stays = snapshot.stays as unknown as HouseStayLike[];
  const emails = [
    ...new Set(stays.map((stay) => String(stay.resident?.residentEmail ?? "").trim().toLowerCase()).filter(Boolean)),
  ];
  const profilesByEmail = new Map<string, HouseProfileLike>();
  if (emails.length > 0) {
    const { data } = await db.from("profiles").select("id, email, phone, full_name").in("email", emails);
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const email = String(row.email ?? "").trim().toLowerCase();
      if (!email) continue;
      profilesByEmail.set(email, {
        id: String(row.id ?? ""),
        email,
        phone: row.phone == null ? null : String(row.phone),
        fullName: String(row.full_name ?? ""),
      });
    }
  }
  const reachByEmail = await loadReachByForEmails(db, emails);
  const optedOutEmails = new Set<string>();
  for (const email of emails) {
    const profile = profilesByEmail.get(email);
    const stay = stays.find((s) => String(s.resident?.residentEmail ?? "").trim().toLowerCase() === email);
    const e164 = normalizeE164(profile?.phone ?? stay?.resident?.residentPhone ?? "");
    if (!e164) continue;
    if (await isPhoneOptedOut(db, e164, { userId: profile?.id ?? null }).catch(() => false)) optedOutEmails.add(email);
  }
  return houseResidentsFromStays(stays, {
    propertyId: input.propertyId,
    today: input.today,
    includeGuests: input.includeGuests,
    profilesByEmail,
    optedOutEmails,
    reachByEmail,
    normalizePhone: (raw) => normalizeE164(raw ?? "") || null,
  });
}
