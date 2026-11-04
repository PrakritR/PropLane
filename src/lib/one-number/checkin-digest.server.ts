import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadPropertyStayClock } from "@/lib/bookings/property-stay-times.server";
import { withResolvedStayTimes } from "@/lib/channel-calendar/property-bookings";
import { digestLinesByHouse } from "@/lib/one-number/checkin-digest";
import { checkinDigestEntityId } from "@/lib/one-number/ops-alert-lines";
import { alertPhonesOf } from "@/lib/one-number/ops-alerts.server";
import { occupancyEntriesForManager } from "@/lib/occupancy/snapshot.server";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { readServiceManagerSettings } from "@/lib/service/service-manager.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

/**
 * The 7 AM (Pacific) "who checks in and out today" text, one line per house, to each owner's listed alert
 * phones (and, for a PropLane-managed workspace, the Service-settings phone). Vercel crons run on UTC, so the
 * route is scheduled at 14:00 and 15:00 UTC and this only acts when it is 7 o'clock in Pacific time (the one
 * that matches in either half of the year); the per-house-per-day idempotency key makes a repeat harmless.
 */
export const CHECKIN_DIGEST_HOUR_PACIFIC = 7;

function pacificHourOf(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  return Number(parts.find((p) => p.type === "hour")?.value ?? "-1");
}

export type CheckinDigestSummary = {
  owners: number;
  houses: number;
  sent: number;
  failed: number;
  skippedReason?: "not_7am" | "unreadable";
};

/** Owners who have anyone to tell: an alert phone / email, or a managed workspace with a verified Service phone. */
async function ownersToTell(db: SupabaseClient): Promise<string[] | null> {
  const owners = new Set<string>();
  const { data, error } = await db.from("workspace_work_number_recipients").select("owner_user_id").limit(5000);
  if (error) return null;
  for (const row of (data ?? []) as Array<{ owner_user_id?: unknown }>) {
    const id = typeof row.owner_user_id === "string" ? row.owner_user_id.trim() : "";
    if (id) owners.add(id);
  }
  try {
    const settings = await readServiceManagerSettings(db);
    if (settings?.phoneE164 && settings.verifiedAt) {
      const { data: service } = await db.from("portal_workspaces").select("owner_user_id").eq("is_service", true).limit(500);
      for (const row of (service ?? []) as Array<{ owner_user_id?: unknown }>) {
        const id = typeof row.owner_user_id === "string" ? row.owner_user_id.trim() : "";
        if (id) owners.add(id);
      }
    }
  } catch {
    // The Service leg is additive; the alert phones are still told.
  }
  return [...owners];
}

export async function runCheckinCheckoutDigest(
  db: SupabaseClient,
  deps: { now?: () => Date; force?: boolean } = {},
): Promise<CheckinDigestSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const summary: CheckinDigestSummary = { owners: 0, houses: 0, sent: 0, failed: 0 };
  if (!deps.force && pacificHourOf(now) !== CHECKIN_DIGEST_HOUR_PACIFIC) return { ...summary, skippedReason: "not_7am" };
  const owners = await ownersToTell(db);
  if (!owners) return { ...summary, skippedReason: "unreadable" };
  const dayKey = pacificCalendarDateYmd(now);
  const url = `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/portal/bookings/upcoming`;

  for (const ownerUserId of owners) {
    try {
      const { data: properties, error } = await db.from("manager_property_records").select("id").eq("manager_user_id", ownerUserId).limit(500);
      if (error) throw new Error(error.message);
      const propertyIds = ((properties ?? []) as Array<{ id?: unknown }>).map((row) => String(row.id ?? "").trim()).filter(Boolean);
      if (propertyIds.length === 0) continue;
      summary.owners += 1;
      const { entries } = await occupancyEntriesForManager(db, ownerUserId, { propertyIds });
      const clocks = new Map<string, Awaited<ReturnType<typeof loadPropertyStayClock>>["times"]>();
      for (const id of propertyIds) clocks.set(id, (await loadPropertyStayClock(db, id)).times);
      const timed = withResolvedStayTimes(entries, (propertyId) => clocks.get(propertyId) as never);
      for (const line of digestLinesByHouse(timed, dayKey)) {
        summary.houses += 1;
        const out = await alertPhonesOf(db, {
          ownerUserId,
          kind: "checkin_checkout_today",
          entityId: checkinDigestEntityId(line.propertyId, dayKey),
          propertyId: line.propertyId,
          text: line.text,
          url,
        });
        if (out.texted + out.emailed > 0) summary.sent += 1;
      }
    } catch {
      // One owner's unreadable house never stops the next owner's text. Nothing identifying is logged.
      summary.failed += 1;
      console.error("check-in digest failed for one owner");
    }
  }
  return summary;
}
