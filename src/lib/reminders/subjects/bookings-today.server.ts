import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { traceSystemNotification } from "@/lib/observability/langfuse";
import { channelStays, leaseStays, roomDateBlockStays, type Stay } from "@/lib/reminders/subjects/bookings.server";
import { pacificTodayKey } from "@/lib/sheet-sync/dates";

/**
 * The daily "Today at your houses" message (BUILD-WAVE2 C211) — a new
 * built-in notice, not a `reminders/rules.ts` subject. It has no per-event
 * setting (per Part 5's rule for built-in messages), so it deliberately does
 * NOT go through the generic lead-time/audience reminder-rule machinery
 * `rules.ts` owns; landing this file's own cron and settings entry ahead of
 * WS4's `reminders/rules.ts` edits would conflict with that file, which this
 * workstream does not touch (see BUILD-WAVE2.md §4 WS4 ownership note).
 *
 * Counts one stay per room per day across every source
 * `sweepBookingReminders` already sweeps for the per-stay check-in reminder:
 * an imported Airbnb/Booking.com range, a signed PropLane lease's move-in,
 * and a room-date block (hand-added booking or a linked-sheet import). A stay
 * present in more than one source on the same day and room is still one line
 * here, not two.
 */

export type BookingsTodayItem = {
  kind: "check-in" | "check-out";
  guestName: string;
  propertyLabel: string;
};

export type BookingsTodaySummary = {
  checkIns: number;
  checkOuts: number;
  items: BookingsTodayItem[];
};

function dedupeKey(stay: Stay, kind: "check-in" | "check-out"): string {
  return `${kind}:${stay.propertyId ?? stay.propertyLabel}:${stay.guestName.toLowerCase()}`;
}

/** Every manager's stays for today, in one pass over the three sources. */
export async function loadBookingsTodayByManager(
  db: SupabaseClient,
  todayKey: string,
): Promise<Map<string, BookingsTodaySummary>> {
  const [channel, lease, block] = await Promise.all([channelStays(db), leaseStays(db), roomDateBlockStays(db)]);
  const allStays = [...channel, ...lease, ...block];

  const byManager = new Map<string, BookingsTodaySummary>();
  const seenKeys = new Map<string, Set<string>>();
  for (const stay of allStays) {
    const kinds: ("check-in" | "check-out")[] = [];
    if (stay.checkInKey === todayKey) kinds.push("check-in");
    if (stay.checkOutKey === todayKey) kinds.push("check-out");
    if (kinds.length === 0) continue;

    let summary = byManager.get(stay.managerUserId);
    let seen = seenKeys.get(stay.managerUserId);
    if (!summary || !seen) {
      summary = { checkIns: 0, checkOuts: 0, items: [] };
      seen = new Set();
      byManager.set(stay.managerUserId, summary);
      seenKeys.set(stay.managerUserId, seen);
    }
    for (const kind of kinds) {
      const key = dedupeKey(stay, kind);
      if (seen.has(key)) continue;
      seen.add(key);
      summary.items.push({ kind, guestName: stay.guestName, propertyLabel: stay.propertyLabel });
      if (kind === "check-in") summary.checkIns += 1;
      else summary.checkOuts += 1;
    }
  }
  return byManager;
}

/** "Today at your houses: 3 check-ins, 1 check-out." plus one line per stay. */
export function renderBookingsTodayMessage(summary: BookingsTodaySummary): string {
  const parts = [
    summary.checkIns > 0 ? `${summary.checkIns} check-in${summary.checkIns === 1 ? "" : "s"}` : null,
    summary.checkOuts > 0 ? `${summary.checkOuts} check-out${summary.checkOuts === 1 ? "" : "s"}` : null,
  ].filter((part): part is string => Boolean(part));
  const headline = `Today at your houses: ${parts.join(", ")}.`;
  const lines = summary.items.map(
    (item) => `${item.kind === "check-in" ? "Check-in" : "Check-out"} · ${item.guestName} · ${item.propertyLabel}`,
  );
  return [headline, ...lines].join("\n");
}

export async function deliverBookingsTodayDigests(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<{ sent: number; skipped: number; errors: string[] }> {
  const todayKey = pacificTodayKey(now);
  const byManager = await loadBookingsTodayByManager(db, todayKey);

  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const [managerUserId, summary] of byManager) {
    // A quiet day sends nothing — this is informational, not a reminder with
    // a "nothing happened" state worth reporting.
    if (summary.items.length === 0) {
      skipped += 1;
      continue;
    }
    try {
      const message = renderBookingsTodayMessage(summary);
      const delivery = await traceSystemNotification({
        domain: "bookings_today_digest",
        managerUserId,
        entityId: todayKey,
        run: () =>
          notifyManagerFromAgent(db, {
            landlordId: managerUserId,
            subject: "Today at your houses",
            text: message,
            externalText: message,
            // `ManagerNotificationCategory` has no dedicated "bookings" entry
            // and this message has no per-event setting to gate on anyway
            // (Part 5's rule for a built-in message) — `attention_digest` is
            // the one category already meant for an unconditional daily
            // informational notice, same as `manager-attention-digest.server.ts`.
            category: "attention_digest",
            url: "/portal/bookings",
            // Once per manager per day — a re-run of the cron (or a second
            // scheduled invocation) must not send this twice.
            idempotencyKey: `bookings-today:${todayKey}:${managerUserId}`,
          }),
        summarize: (result) => ({ ok: result.delivered, suppressed: result.suppressed, counts: summary }),
      });
      if (delivery.delivered) sent += 1;
      else skipped += 1;
    } catch (cause) {
      errors.push(`${managerUserId}:${cause instanceof Error ? cause.message : "failed"}`);
    }
  }
  return { sent, skipped, errors };
}
