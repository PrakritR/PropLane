import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { emitMoveInFormEvent } from "@/lib/move-in-forms/move-in-form-events.server";
import { readMoveInFormSettings } from "@/lib/move-in-forms/templates";
import { addDaysToIsoDate, pacificTodayKey } from "@/lib/sheet-sync/dates";

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
