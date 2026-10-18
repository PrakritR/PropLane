import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { isPhoneOptedOut, normalizeConsentPhone } from "@/lib/sms-consent";
import { loadPreferences } from "./store.server";
import type { ResidentCandidate } from "./types";

/**
 * Who lives in a house today, as group candidates. The occupancy snapshot is the one reader the
 * Bookings screen uses (docs/agents/bookings.md): a stay with a `resident` payload is an executed
 * lease or an approved long-term hold. A guest-portal short stay is a room block with no such
 * payload, and any stay shorter than a month is treated as a short stay as well.
 */

/** A stay at least this long is a long-term resident (the short-stay product caps at 28 nights). */
export const LONG_TERM_MIN_DAYS = 30;

export type OccupancyStayLike = {
  propertyId: string;
  roomLabel: string;
  start: string;
  end: string;
  openEnded?: boolean;
  resident?: { residentName?: string; residentEmail?: string; residentPhone?: string; source: string } | undefined;
};

export type ProfileLike = { id: string; email: string; phone: string | null; verified: boolean; fullName: string };

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

export function firstNameOf(name: string | null | undefined): string {
  const first = String(name ?? "").trim().split(/\s+/)[0] ?? "";
  return first.replace(/[^\p{L}'-]/gu, "").slice(0, 40);
}

/** Stays covering `today` (inclusive), one candidate per resident stay. Pure. */
export function candidatesFromStays(
  stays: readonly OccupancyStayLike[],
  input: {
    propertyId: string;
    today: string;
    profilesByEmail: ReadonlyMap<string, ProfileLike>;
    preferenceByPhoneKey: ReadonlyMap<string, { optedOut: boolean; consentAt: string | null }>;
    stoppedPhoneKeys: ReadonlySet<string>;
  },
): ResidentCandidate[] {
  const out: ResidentCandidate[] = [];
  for (const stay of stays) {
    if (stay.propertyId !== input.propertyId || !stay.resident) continue;
    if (stay.start > input.today || (!stay.openEnded && stay.end < input.today)) continue;
    const email = String(stay.resident.residentEmail ?? "").trim().toLowerCase();
    const profile = email ? input.profilesByEmail.get(email) : undefined;
    const e164 = normalizeE164(profile?.phone ?? stay.resident.residentPhone ?? "");
    if (!e164) continue;
    const phoneKey = normalizeConsentPhone(e164);
    const pref = input.preferenceByPhoneKey.get(phoneKey);
    const longTerm = Boolean(stay.openEnded) || dayDiff(stay.start, stay.end) >= LONG_TERM_MIN_DAYS;
    out.push({
      phoneKey,
      phoneE164: e164,
      userId: profile?.id ?? null,
      firstName: firstNameOf(profile?.fullName || stay.resident.residentName),
      roomLabel: stay.roomLabel.slice(0, 60),
      moveIn: stay.start,
      longTerm,
      verifiedPhone: Boolean(profile?.verified),
      consented: Boolean(pref?.consentAt) && !pref?.optedOut,
      optedOut: Boolean(pref?.optedOut),
      stopped: input.stoppedPhoneKeys.has(phoneKey),
    });
  }
  return out;
}

export async function loadHouseResidentCandidates(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string; propertyId: string; today: string },
): Promise<ResidentCandidate[]> {
  const { occupancySnapshotForManager } = await import("@/lib/occupancy/snapshot.server");
  const snapshot = await occupancySnapshotForManager(db, input.ownerUserId, {
    propertyIds: [input.propertyId],
    from: input.today,
    to: input.today,
    days: [input.today],
  });
  const stays = snapshot.stays as unknown as OccupancyStayLike[];
  const emails = [...new Set(stays.map((s) => String(s.resident?.residentEmail ?? "").trim().toLowerCase()).filter(Boolean))];
  const profilesByEmail = new Map<string, ProfileLike>();
  if (emails.length > 0) {
    const { data } = await db.from("profiles").select("id, email, phone, phone_verified_at, full_name").in("email", emails);
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const email = String(row.email ?? "").trim().toLowerCase();
      if (!email) continue;
      profilesByEmail.set(email, {
        id: String(row.id ?? ""),
        email,
        phone: row.phone == null ? null : String(row.phone),
        verified: Boolean(row.phone_verified_at),
        fullName: String(row.full_name ?? ""),
      });
    }
  }
  // First pass picks the phones the candidates will use; then read preferences and the STOP ledger for them.
  const draft = candidatesFromStays(stays, {
    propertyId: input.propertyId,
    today: input.today,
    profilesByEmail,
    preferenceByPhoneKey: new Map(),
    stoppedPhoneKeys: new Set(),
  });
  const keys = [...new Set(draft.map((c) => c.phoneKey))];
  const prefs = await loadPreferences(db, input.workspaceId, keys);
  const stopped = new Set<string>();
  for (const c of draft) {
    if (await isPhoneOptedOut(db, c.phoneE164, { userId: c.userId }).catch(() => false)) stopped.add(c.phoneKey);
  }
  return candidatesFromStays(stays, {
    propertyId: input.propertyId,
    today: input.today,
    profilesByEmail,
    preferenceByPhoneKey: new Map([...prefs].map(([k, v]) => [k, { optedOut: v.optedOut, consentAt: v.consentAt }] as const)),
    stoppedPhoneKeys: stopped,
  });
}
