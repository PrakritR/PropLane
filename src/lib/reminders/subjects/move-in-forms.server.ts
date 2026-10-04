import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { emitMoveInFormEvent } from "@/lib/move-in-forms/move-in-form-events.server";
import type { MoveInFormDispatchResult } from "@/lib/move-in-forms/server";
import { readMoveInFormSettings } from "@/lib/move-in-forms/templates";
import { addDaysToIsoDate, pacificTodayKey } from "@/lib/sheet-sync/dates";
import { systemAuditActor, updateAuditResult, writeAuditLog } from "@/lib/tools/audit";

/**
 * Automatic move-in form reminders: each property's `moveInFormSettings.remind` decides.
 *
 *   before-and-due  2 days before the due date, and on the due date (Pacific)
 *   due-only        on the due date
 *   never           nothing
 *
 * Runs on the existing 5-minute reminder tick (`/api/cron/dispatch-reminders`). It is not a
 * `reminders/rules.ts` subject (those carry per-event lead-time rules that are fixed workspace-wide);
 * the timing here is the property's own choice. Each reminder is claimed on the row first
 * (`reminders_sent.<kind>`, compare-and-swap on "not yet sent"), so a re-run, an overlapping run, or a
 * retry after a delivery failure never sends the same reminder twice. A submitted or cancelled row is
 * never reminded. The send is the manager's own Remind: same event, same path.
 */

export type MoveInFormReminderKind = "before" | "due";

type SweepRow = {
  id: string;
  manager_user_id: string;
  property_id: string;
  property_label: string;
  room_label: string;
  resident_name: string;
  resident_email: string;
  resident_user_id: string | null;
  form_name: string;
  due_at: string | null;
  sent_at: string;
  reminders_sent: Record<string, string> | null;
};

/** Which reminder (if any) is due today for a form due on `dueKey`, under the property's setting. */
export function moveInFormReminderKindFor(
  remind: "before-and-due" | "due-only" | "never",
  todayKey: string,
  dueKey: string,
): MoveInFormReminderKind | null {
  if (remind === "never") return null;
  if (todayKey === dueKey) return "due";
  if (remind === "before-and-due" && todayKey === addDaysToIsoDate(dueKey, -2)) return "before";
  return null;
}

async function propertySettings(db: SupabaseClient, propertyIds: string[]) {
  const byProperty = new Map<string, ReturnType<typeof readMoveInFormSettings>>();
  for (let start = 0; start < propertyIds.length; start += 100) {
    const { data, error } = await db.from("manager_property_records")
      .select("id,settings:property_data->listingSubmission->moveInFormSettings")
      .in("id", propertyIds.slice(start, start + 100));
    if (error) throw new Error(error.message);
    for (const record of (data ?? []) as unknown as { id: string; settings: unknown }[]) {
      byProperty.set(String(record.id), readMoveInFormSettings({ moveInFormSettings: record.settings }));
    }
  }
  return byProperty;
}

/** Returns how many reminders went out. */
export async function sweepMoveInFormReminders(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  const todayKey = pacificTodayKey(now);
  // A due date is at most "today" for the due reminder and "today + 2" for the early one; a day of
  // slack below covers a due time earlier today and a due date written in a different offset.
  const from = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const until = new Date(now.getTime() + 4 * 24 * 3_600_000).toISOString();
  const rows: SweepRow[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db.from("resident_move_in_forms")
      .select("id,manager_user_id,property_id,property_label,room_label,resident_name,resident_email,resident_user_id,form_name,due_at,sent_at,reminders_sent")
      .eq("status", "sent")
      .gte("due_at", from)
      .lte("due_at", until)
      .order("id")
      .range(offset, offset + 499);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as unknown as SweepRow[]));
    if ((data ?? []).length < 500) break;
  }
  if (rows.length === 0) return 0;

  const settings = await propertySettings(db, [...new Set(rows.map((row) => row.property_id))]);
  let sent = 0;
  for (const row of rows) {
    if (!row.due_at) continue;
    const remind = (settings.get(row.property_id) ?? readMoveInFormSettings(null)).remind;
    const kind = moveInFormReminderKindFor(remind, todayKey, pacificTodayKey(new Date(row.due_at)));
    if (!kind) continue;
    // The "sent" message went out today: reminding in the same breath is noise, not a reminder.
    if (pacificTodayKey(new Date(row.sent_at)) === todayKey) continue;
    if (row.reminders_sent?.[kind]) continue;
    // Claim first: only the run that flips "not yet sent" to sent delivers.
    const { data: claimed, error } = await db.from("resident_move_in_forms")
      .update({ reminders_sent: { ...(row.reminders_sent ?? {}), [kind]: nowIso }, reminded_at: nowIso, updated_at: nowIso })
      .eq("id", row.id)
      .eq("status", "sent")
      .is(`reminders_sent->>${kind}`, null)
      .select("id")
      .maybeSingle();
    if (error || !claimed) continue;
    sent++;
    // Deterministic nonce: the bus is idempotent on it too.
    await emitMoveInFormEvent(db, { row, event: "reminder", nonce: `auto-${kind}` }).catch(() => undefined);
  }
  return sent;
}

/* ------------------------------------------------------------------ move-out */

/** How far ahead of a lease end any form can be set to go out (the longest "Before move-out" choice). */
const MOVE_OUT_LOOKAHEAD_DAYS = 30;
const MOVE_OUT_PAGE_SIZE = 500;

function daysBetween(fromKey: string, toKey: string): number {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

const MOVE_OUT_SWEEP_ACTION = "move_in_form_move_out_sweep";
/** How many fleet-wide passes one Pacific day may cost: the pass, plus two retries after a failure. */
export const MOVE_OUT_SWEEP_MAX_ATTEMPTS = 3;
/** Enough failed ids to act on, few enough to keep the audit row small. */
const MOVE_OUT_SWEEP_LOGGED_FAILURES = 20;
const moveOutAttemptKey = (dayKey: string, attempt: number) => `${MOVE_OUT_SWEEP_ACTION}:${dayKey}:${attempt}`;

type SweepActor = ReturnType<typeof systemAuditActor>;

/** Takes the day's remaining attempt slots, so a settled day is never passed over again. */
async function settleMoveOutDay(actor: SweepActor, dayKey: string, fromAttempt: number): Promise<void> {
  for (let attempt = fromAttempt; attempt <= MOVE_OUT_SWEEP_MAX_ATTEMPTS; attempt++) {
    await writeAuditLog(actor, {
      action: MOVE_OUT_SWEEP_ACTION,
      toolName: "move-in-forms",
      inputSummary: { day: dayKey, attempt },
      resultSummary: { status: "settled" },
      dedupeKey: moveOutAttemptKey(dayKey, attempt),
    });
  }
}

/**
 * The daily "Before move-out" send: for every fully signed, not voided lease whose end date is within
 * the next 30 days, dispatch the forms whose trigger is "Before move-out" and whose "N days before the
 * lease ends" has been reached. The due date is anchored on the lease end (`move-out-day`,
 * `N-days-before-move-out`).
 *
 * A Pacific day holds three attempt slots, and each is claimed by one audit insert
 * (`audit_log.dedupe_key` is unique), so a tick runs the pass only if it wins a slot that is still
 * free. The first tick in the 8 o'clock Pacific hour takes slot 1; a pass that comes back clean
 * settles the remaining slots so the dozen later ticks of that hour read no leases at all —
 * paginating every signed lease twelve times is egress this project cannot spend. A pass that threw
 * or reported a failure leaves the next slot free, so a later tick retries it and the failed
 * residencies are logged; once the three slots are gone the day is closed whatever is left over,
 * which bounds a deterministically poisoned row to three passes instead of one every tick.
 *
 * The retry is a cushion rather than a guarantee: dispatch sends a form on any morning the lease
 * still sits in its window, so a lost day only matters for a lease ending that same day. Dispatch
 * also skips any form a residency already holds (`liveFormIds`), so a retry, a missed day or an
 * overlapping run never sends the same form twice. Returns how many forms went out.
 */
export async function sweepMoveOutForms(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", hour12: false }).format(now)) % 24;
  if (hour !== 8) return 0;
  const actor = systemAuditActor(db);
  const dayKey = pacificTodayKey(now);
  for (let attempt = 1; attempt <= MOVE_OUT_SWEEP_MAX_ATTEMPTS; attempt++) {
    const dedupeKey = moveOutAttemptKey(dayKey, attempt);
    const claim = await writeAuditLog(actor, {
      action: MOVE_OUT_SWEEP_ACTION,
      toolName: "move-in-forms",
      inputSummary: { day: dayKey, attempt },
      dedupeKey,
    });
    if (!claim.recorded) {
      if (claim.duplicate) continue;
      throw new Error(claim.error);
    }
    try {
      const { sent, failed, failedApplicationIds } = await runMoveOutDispatch(db, now);
      const loggedFailures = failedApplicationIds.slice(0, MOVE_OUT_SWEEP_LOGGED_FAILURES);
      if (failed > 0) {
        console.error("[move-in-forms] move-out dispatch failed for some residencies", { day: dayKey, attempt, applicationIds: loggedFailures });
      }
      await updateAuditResult(actor, dedupeKey, { status: failed > 0 ? "failed" : "success", sent, failed, failed_application_ids: loggedFailures });
      if (failed === 0) await settleMoveOutDay(actor, dayKey, attempt + 1);
      return sent;
    } catch (error) {
      await updateAuditResult(actor, dedupeKey, { status: "failed" });
      throw error;
    }
  }
  return 0;
}

/** What one fleet-wide pass did: the dispatch totals, plus which residencies reported a failure. */
export type MoveOutSweepResult = MoveInFormDispatchResult & { failedApplicationIds: string[] };

/** The pass itself, without the hour gate or the day claim (the cron tick calls `sweepMoveOutForms`). */
export async function runMoveOutDispatch(db: SupabaseClient, now: Date = new Date()): Promise<MoveOutSweepResult> {
  // Loaded here, not at the top: the reminder sweep above stays light (and testable) without the send machinery.
  const { dispatchMoveInFormsForResidency } = await import("@/lib/move-in-forms/server");
  const todayKey = pacificTodayKey(now);
  // Only leases that end inside the longest "N days before" window can send anything, so the
  // database narrows to those (the end is compared as text: a date or an ISO timestamp both sort
  // correctly) instead of the sweep loading every signed lease on the platform.
  const windowStart = todayKey;
  const windowEndExclusive = addDaysToIsoDate(todayKey, MOVE_OUT_LOOKAHEAD_DAYS + 1);
  type LeaseRow = { manager_user_id: string | null; property_id: string | null; axis_id: string | null; members: unknown };
  const leases: LeaseRow[] = [];
  for (let offset = 0; ; offset += MOVE_OUT_PAGE_SIZE) {
    const { data, error } = await db.from("portal_lease_pipeline_records")
      .select("manager_user_id,property_id,axis_id:row_data->>axisId,members:row_data->jointLeaseMembers")
      .not("row_data->>fullySignedAt", "is", null)
      .is("row_data->>voidedAt", null)
      .gte("row_data->application->>leaseEnd", windowStart)
      .lt("row_data->application->>leaseEnd", windowEndExclusive)
      .order("id")
      .range(offset, offset + MOVE_OUT_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    leases.push(...((data ?? []) as unknown as LeaseRow[]));
    if ((data ?? []).length < MOVE_OUT_PAGE_SIZE) break;
  }
  // The application ids come from client-writable lease JSON, so each is paired with the manager
  // and property the lease ROW itself carries; the dispatch refuses a residency that is not theirs.
  type Target = { id: string; secondary: boolean; managerUserId: string; propertyId: string | null };
  const targets = new Map<string, Target>();
  const add = (id: unknown, secondary: boolean, lease: LeaseRow) => {
    if (typeof id !== "string" || !id || !lease.manager_user_id) return;
    const key = `${lease.manager_user_id}|${lease.property_id ?? ""}|${id}`;
    const existing = targets.get(key);
    // A member of one lease who signs another as primary is primary.
    if (existing && (!existing.secondary || secondary)) return;
    targets.set(key, { id, secondary, managerUserId: lease.manager_user_id, propertyId: lease.property_id });
  };
  for (const lease of leases) {
    add(lease.axis_id, false, lease);
    if (Array.isArray(lease.members)) {
      for (const member of lease.members as { applicationId?: unknown }[]) add(member?.applicationId, true, lease);
    }
  }
  const byApplication = new Map<string, Target[]>();
  for (const target of targets.values()) byApplication.set(target.id, [...(byApplication.get(target.id) ?? []), target]);
  const ids = [...byApplication.keys()];
  let sent = 0;
  let failed = 0;
  const failedApplicationIds: string[] = [];
  for (let start = 0; start < ids.length; start += 100) {
    const { data, error } = await db.from("manager_application_records")
      .select("id,lease_end:row_data->application->>leaseEnd")
      .in("id", ids.slice(start, start + 100));
    if (error) throw new Error(error.message);
    for (const record of (data ?? []) as unknown as { id: string; lease_end: string | null }[]) {
      const endKey = /^\d{4}-\d{2}-\d{2}/.exec((record.lease_end ?? "").trim())?.[0];
      if (!endKey) continue;
      const daysLeft = daysBetween(todayKey, endKey);
      if (daysLeft < 0 || daysLeft > MOVE_OUT_LOOKAHEAD_DAYS) continue;
      for (const target of byApplication.get(String(record.id)) ?? []) {
        const result = await dispatchMoveInFormsForResidency(String(record.id), "before-move-out", {
          db, daysUntilLeaseEnd: daysLeft, secondaryMember: target.secondary,
          expect: { managerUserId: target.managerUserId, propertyId: target.propertyId },
        });
        sent += result.sent;
        failed += result.failed;
        if (result.failed > 0) failedApplicationIds.push(String(record.id));
      }
    }
  }
  return { sent, failed, failedApplicationIds };
}
