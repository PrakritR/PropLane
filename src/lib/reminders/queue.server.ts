/**
 * The reminder queue — materialize, claim, resolve, cancel.
 *
 * Rows are written when a subject CHANGES (a tour is booked, a task's due date
 * moves), never by scanning every entity on a tick. That keeps the 5-minute
 * dispatcher's cost flat: one indexed query on `(status, send_at)` that returns
 * nothing most of the time, which matters on the free Supabase egress plan.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_REMINDER_SETTINGS,
  reminderDedupeKey,
  reminderSendTimes,
  type ReminderSettings,
  type ReminderSubjectKind,
} from "@/lib/reminders/rules";

export type ReminderRecipient = {
  email: string;
  role: "manager" | "counterparty";
  userId?: string | null;
  /** Shown in the greeting. Falls back to a neutral phrase when unknown. */
  name?: string | null;
};

export type ReminderQueueRow = {
  id: string;
  managerUserId: string;
  kind: ReminderSubjectKind;
  subjectId: string;
  leadMinutes: number;
  recipientEmail: string;
  recipientRole: "manager" | "counterparty";
  sendAt: string;
  attempts: number;
  payload: Record<string, unknown>;
};

export type MaterializeInput = {
  managerUserId: string;
  kind: ReminderSubjectKind;
  subjectId: string;
  /** The moment being reminded about, ISO. */
  anchorIso: string;
  recipients: ReminderRecipient[];
  /** Everything the renderer needs at send time, captured now. */
  payload: Record<string, unknown>;
};

function rowFromDb(row: Record<string, unknown>): ReminderQueueRow {
  return {
    id: String(row.id),
    managerUserId: String(row.manager_user_id),
    kind: String(row.kind) as ReminderSubjectKind,
    subjectId: String(row.subject_id),
    leadMinutes: Number(row.lead_minutes),
    recipientEmail: String(row.recipient_email),
    recipientRole: String(row.recipient_role) as "manager" | "counterparty",
    sendAt: String(row.send_at),
    attempts: Number(row.attempts ?? 0),
    payload:
      row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {},
  };
}

/**
 * Queue every reminder a subject currently warrants.
 *
 * Idempotent by construction: `dedupe_key` is unique, so re-running this for an
 * unchanged subject is a no-op. Call it after any write that moves the anchor.
 *
 * The payload is snapshotted at queue time on purpose — a reminder should
 * describe the appointment as it was agreed, and the alternative (re-reading
 * the subject at send time) turns every send into another round of queries.
 */
export async function materializeReminders(
  db: SupabaseClient,
  input: MaterializeInput,
  settings: ReminderSettings = DEFAULT_REMINDER_SETTINGS,
  now: Date = new Date(),
): Promise<number> {
  const rule = settings.rules[input.kind];
  if (!rule) return 0;

  const sends = reminderSendTimes(rule, input.anchorIso, settings.quietHours, now);
  if (sends.length === 0) return 0;

  const recipients = input.recipients.filter((recipient) => {
    if (!recipient.email.trim()) return false;
    return recipient.role === "manager" ? rule.audience.manager : rule.audience.counterparty;
  });
  if (recipients.length === 0) return 0;

  const rows = sends.flatMap(({ leadMinutes, sendAt }) =>
    recipients.map((recipient) => ({
      manager_user_id: input.managerUserId,
      kind: input.kind,
      subject_id: input.subjectId,
      lead_minutes: leadMinutes,
      recipient_email: recipient.email.trim().toLowerCase(),
      recipient_role: recipient.role,
      send_at: sendAt.toISOString(),
      status: "scheduled",
      dedupe_key: reminderDedupeKey({
        kind: input.kind,
        subjectId: input.subjectId,
        leadMinutes,
        recipient: recipient.email,
      }),
      payload: {
        ...input.payload,
        recipientName: recipient.name ?? null,
        recipientUserId: recipient.userId ?? null,
        anchorIso: input.anchorIso,
        leadMinutes,
      },
    })),
  );

  // `ignoreDuplicates` is what makes a re-materialize free rather than an
  // error — an unchanged reminder is already queued and must not be disturbed,
  // because updating it would reset a row the dispatcher may be mid-send on.
  const { error } = await db
    .from("portal_reminder_records")
    .upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true });
  if (error) throw error;
  return rows.length;
}

/**
 * Drop pending reminders for a subject.
 *
 * Called when the anchor moves or the subject is cancelled — followed by a
 * fresh `materializeReminders` when it moved. Only `scheduled` rows are
 * touched: a row already `sending` is owned by a dispatcher run, and one
 * already `sent` is history.
 */
export async function cancelRemindersForSubject(
  db: SupabaseClient,
  kind: ReminderSubjectKind,
  subjectId: string,
): Promise<void> {
  const { error } = await db
    .from("portal_reminder_records")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("kind", kind)
    .eq("subject_id", subjectId)
    .eq("status", "scheduled");
  if (error) throw error;
}

/** Claim a batch of due reminders for this run. See `claim_due_reminders`. */
export async function claimDueReminders(
  db: SupabaseClient,
  workerId: string,
  limit = 100,
): Promise<ReminderQueueRow[]> {
  const { data, error } = await db.rpc("claim_due_reminders", {
    p_worker_id: workerId,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => rowFromDb(row));
}

/**
 * Close out a claimed reminder.
 *
 * A failure is returned to `scheduled` so the next run retries it; the
 * `attempts` ceiling in `claim_due_reminders` is what stops that being
 * forever. Returns false when the lease was lost, which is information the
 * caller should log rather than treat as success.
 */
export async function resolveReminder(
  db: SupabaseClient,
  id: string,
  workerId: string,
  status: "sent" | "failed" | "scheduled",
  error?: string,
): Promise<boolean> {
  const { data, error: rpcError } = await db.rpc("resolve_reminder", {
    p_id: id,
    p_worker_id: workerId,
    p_status: status,
    p_error: error ? error.slice(0, 500) : null,
  });
  if (rpcError) throw rpcError;
  return data === true;
}
