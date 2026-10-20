import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadPropertyStayClock } from "@/lib/bookings/property-stay-times.server";
import { recordDispatchEvent } from "@/lib/vendor-dispatch/audit.server";
import { loadAttempts, loadVendorContacts } from "@/lib/vendor-dispatch/engine.server";
import { sendVendorDispatchText } from "@/lib/vendor-dispatch/send.server";
import { composeVendorOfferText, type DispatchJobDetails } from "@/lib/vendor-dispatch/text";
import type { TurnoverStay } from "@/lib/vendor-dispatch/triggers.server";
import { nextStayAfter, turnoverWindow } from "@/lib/vendor-dispatch/turnover-window";
import type { DispatchRunRow } from "@/lib/vendor-dispatch/types";

/** A run is still "open" until the job is done, declined, or canceled. */
const OPEN_RUN_STATUSES = ["awaiting_approval", "offering", "exhausted", "accepted"];

async function loadTurnoverStays(db: SupabaseClient, propertyId: string): Promise<TurnoverStay[]> {
  const bookings = await import("@/lib/reminders/subjects/bookings.server");
  const [channel, lease, blocks] = await Promise.all([
    bookings.channelStays(db).catch(() => []),
    bookings.leaseStays(db).catch(() => []),
    bookings.roomDateBlockStays(db).catch(() => []),
  ]);
  return [...channel, ...lease, ...blocks]
    .filter((stay) => stay.propertyId === propertyId)
    .map((stay) => ({
      managerUserId: stay.managerUserId,
      subjectId: stay.subjectId,
      checkInKey: stay.checkInKey,
      checkOutKey: stay.checkOutKey,
      propertyId: stay.propertyId,
      propertyLabel: stay.propertyLabel,
      roomId: stay.roomId,
      roomLabel: stay.roomLabel,
      checkInTime: stay.checkInTime,
      checkOutTime: stay.checkOutTime,
    }));
}

/**
 * Re-time the open turnover cleaning runs on one room after a stay's times moved (a paid early
 * check-in or late checkout, or a manager editing a time). Best-effort: never throws.
 *
 * A move can touch two runs: the stay's OWN run (its checkout moved) and the PREVIOUS stay's run
 * (the next check-in it must beat moved). Both belong to the same room, so every open `cleaning`
 * run on that room is recomputed from the same window the sweep uses
 * (`turnoverWindow`) and rewritten only when its window actually changed. A run still waiting on a
 * decision gets its offer text rebuilt; one a vendor already accepted gets the new window texted to
 * that vendor (through the dispatch send path, idempotent per window) and an audit row.
 */
export async function refreshTurnoverCleaningTimes(
  db: SupabaseClient,
  args: { ownerUserId: string; propertyId: string; roomId: string; checkOutDate: string },
): Promise<void> {
  try {
    const propertyId = args.propertyId.trim();
    if (!propertyId || !args.ownerUserId.trim()) return;
    const stays = (await loadTurnoverStays(db, propertyId)).filter(
      (stay) => !args.roomId || (stay.roomId ?? "") === args.roomId,
    );
    const bySource = new Map<string, TurnoverStay>();
    for (const stay of stays) if (stay.checkOutKey) bySource.set(`${stay.subjectId}:${stay.checkOutKey}`, stay);
    if (bySource.size === 0) return;

    const { data, error } = await db
      .from("vendor_dispatch_runs")
      .select("*")
      .eq("source_type", "cleaning")
      .eq("owner_user_id", args.ownerUserId)
      .in("source_id", [...bySource.keys()])
      .in("status", OPEN_RUN_STATUSES);
    if (error || !Array.isArray(data) || data.length === 0) return;

    const clock = await loadPropertyStayClock(db, propertyId);
    for (const run of data as DispatchRunRow[]) {
      try {
        const stay = bySource.get(run.source_id);
        if (!stay || !stay.checkOutKey) continue;
        const turnover = turnoverWindow({ ...stay, checkOutKey: stay.checkOutKey }, nextStayAfter(stays, stay), clock);
        const before = run.details ?? {};
        const sameDeadline = (run.deadline_at ? Date.parse(run.deadline_at) : null) === (turnover.deadlineIso ? Date.parse(turnover.deadlineIso) : null);
        if (before.whenLabel === turnover.whenLabel && sameDeadline) continue;

        const rest = { ...before };
        delete rest.summary;
        const details: DispatchJobDetails & Record<string, unknown> = {
          ...rest,
          whenLabel: turnover.whenLabel,
          deadlineLabel: turnover.deadlineLabel,
          deadlineIso: turnover.deadlineIso,
          ...(turnover.note ? { summary: turnover.note } : {}),
        };
        const accepted = run.status === "accepted";
        const update: Record<string, unknown> = {
          details,
          deadline_at: turnover.deadlineIso ?? null,
          updated_at: new Date().toISOString(),
        };
        // An offer nobody has accepted yet reads the new window; an accepted job keeps the text it was accepted on.
        if (!accepted) {
          update.offer_text = composeVendorOfferText({
            handle: run.handle,
            details,
            payCents: run.pay_cents,
            payModel: typeof details.payModel === "string" ? details.payModel : null,
            deadlineLabel: turnover.deadlineLabel ?? null,
          });
        }
        const { error: updateError } = await db.from("vendor_dispatch_runs").update(update).eq("id", run.id);
        if (updateError) continue;
        const windowKey = `${turnover.startAt}-${turnover.endAt}`.replace(/[^0-9A-Za-z]/g, "");
        await recordDispatchEvent(db, {
          ownerUserId: run.owner_user_id,
          runId: run.id,
          handle: run.handle,
          event: "window_changed",
          key: windowKey,
          channel: "system",
          detail: { whenLabel: turnover.whenLabel, deadlineIso: turnover.deadlineIso ?? null, shortGap: turnover.shortGap },
        }).catch(() => false);

        if (accepted && run.accepted_vendor_directory_id) {
          const attempts = await loadAttempts(db, run.id);
          const vendorId = attempts.find((attempt) => attempt.status === "accepted")?.vendor_directory_id ?? run.accepted_vendor_directory_id;
          const contact = (await loadVendorContacts(db, run.owner_user_id, [vendorId])).get(vendorId);
          if (contact?.phone) {
            await sendVendorDispatchText(db, {
              ownerUserId: run.owner_user_id,
              workspaceId: run.workspace_id,
              approvedByUserId: run.approved_by,
              vendorDirectoryId: contact.id,
              phone: contact.phone,
              vendorUserId: contact.vendorUserId,
              text: `Update #${run.handle}: the clean window is now ${turnover.whenLabel}.${turnover.note ? " Tight turnover." : ""}`,
              idempotencyKey: `cleaning-window-${run.id}-${windowKey}`,
            }).catch(() => undefined);
          }
        }
      } catch {
        // One run failing to re-time never blocks the next.
      }
    }
  } catch {
    // Best-effort by contract: a stay's time change never fails because a cleaning run could not follow it.
  }
}
