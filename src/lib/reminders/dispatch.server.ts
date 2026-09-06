/**
 * The dispatcher — the only thing that sends a reminder.
 *
 * Runs every 5 minutes. Before this existed, every reminder drained from a
 * once-a-day cron, so any lead time shorter than a day was delivered on the
 * next daily tick — after the event it was announcing.
 *
 * Delivery goes through `deliverPortalInboxMessage`, the same layer the rest of
 * the product sends through, so a reminder lands in the recipient's
 * Communication thread AND mirrors outward by email in one call — and each
 * recipient's own notification preferences gate the outward copy. Writing a
 * second, reminder-only send path would have meant a second set of preference
 * rules to keep in sync, and reminders that live somewhere nobody replies.
 *
 * Each claimed row is settled exactly once: `sent` on success, back to
 * `scheduled` on a transient failure so the next run retries it, and `failed`
 * when the row can never succeed. The attempts ceiling lives in
 * `claim_due_reminders`, so a permanently broken row stops on its own.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { claimDueReminders, resolveReminder, type ReminderQueueRow } from "@/lib/reminders/queue.server";
import { renderReminder, type ReminderPayload } from "@/lib/reminders/render";
import {
  DEFAULT_REMINDER_SETTINGS,
  type ReminderSubjectKind,
} from "@/lib/reminders/rules";
import { loadReminderSettingsForManagers } from "@/lib/reminders/settings.server";
import type { NotificationCategory } from "@/lib/notification-preferences";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { managerNotificationCategoryForEvent } from "@/lib/manager-notification-preferences";
import { reminderIsCurrent } from "@/lib/reminders/current.server";

export type DispatchSummary = {
  claimed: number;
  sent: number;
  failed: number;
  retried: number;
  errors: string[];
};

/**
 * Which notification category each subject belongs to.
 *
 * This is what lets a recipient silence maintenance mail without also silencing
 * their lease — the categories already exist in `notification-preferences`, so
 * reminders reuse them rather than inventing a "reminders" switch that would
 * override the choices someone already made.
 */
const CATEGORY_BY_KIND: Record<ReminderSubjectKind, NotificationCategory> = {
  inspection: "leases",
  inspection_manager: "leases",
  tour: "leases",
  task: "messages",
  service_order: "maintenance",
  work_order: "maintenance",
  application: "leases",
  application_manager: "leases",
  application_post_tour: "leases",
  lease: "leases",
  lease_manager: "leases",
  payment_manager: "payments",
  outgoing_payment: "payments",
  // A stay is the occupancy side of a lease, so it silences with leases rather
  // than inventing a category that no existing preference row has an answer for.
  booking: "leases",
};

/**
 * Is this refusal one that retrying can never fix?
 *
 * `deliverPortalInboxMessage` reports an authorization refusal and a transient
 * outage the same way — `{ ok: false, error }` — so the message text is the only
 * signal available. Matching it is fragile, but the alternative is worse: a
 * recipient outside the sender's scope is a permanent state, and treating it as
 * transient burns the whole attempts budget re-attempting a send that is
 * refused identically every time. A miss here is merely a few wasted retries,
 * never a lost message.
 */
function isPermanentDeliveryRefusal(error: string): boolean {
  const text = error.toLowerCase();
  return (
    text.includes("connected to your account") ||
    text.includes("subject and text are required") ||
    text.includes("no valid recipients")
  );
}

/** Distinguishes a retryable outage from a row that can never be delivered. */
type SendOutcome = { ok: true } | { ok: false; permanent: boolean; error: string };

type SenderIdentity = { userId: string; email: string; name: string };

async function loadSenders(
  db: SupabaseClient,
  managerUserIds: readonly string[],
): Promise<Map<string, SenderIdentity>> {
  const out = new Map<string, SenderIdentity>();
  const ids = [...new Set(managerUserIds)].filter(Boolean);
  if (ids.length === 0) return out;
  const { data } = await db.from("profiles").select("id, email, full_name").in("id", ids);
  for (const row of data ?? []) {
    const email = String((row as { email?: unknown }).email ?? "").trim().toLowerCase();
    if (!email) continue;
    out.set(String((row as { id: string }).id), {
      userId: String((row as { id: string }).id),
      email,
      name: String((row as { full_name?: unknown }).full_name ?? "").trim() || "PropLane",
    });
  }
  return out;
}

export async function dispatchReminderRow(
  db: SupabaseClient,
  workerId: string,
  row: ReminderQueueRow,
  sender: SenderIdentity | undefined,
  channels: { inbox: boolean; email: boolean; sms: boolean },
): Promise<"sent" | "failed" | "retried"> {
  // Without a sender identity there is no thread to write into and no From to
  // send as. That cannot fix itself on a retry, so stop rather than spin.
  if (!sender) {
    await resolveReminder(db, row.id, workerId, "failed", "manager profile has no email");
    return "failed";
  }
  if (!(await reminderIsCurrent(db, row))) {
    await resolveReminder(db, row.id, workerId, "failed", "subject changed or is no longer active");
    return "failed";
  }
  // The manager's own copy would be a message from themselves to themselves,
  // which `deliverPortalInboxMessage` drops as a self-send. Skip it cleanly
  // instead of letting it look like a delivery failure.
  if (
    row.recipientRole === "counterparty" &&
    row.recipientEmail.trim().toLowerCase() === sender.email
  ) {
    await resolveReminder(db, row.id, workerId, "sent");
    return "sent";
  }

  const { subject, body } = renderReminder({
    kind: row.kind,
    leadMinutes: row.leadMinutes,
    recipientRole: row.recipientRole,
    payload: row.payload as ReminderPayload,
  });

  // Manager and team reminders are a PropLane Assistant surface, not a manager sending
  // a message to themselves. Route them through the shared manager notifier so
  // Preferences decides Assistant, work-number SMS, both, or no updates.
  if (row.recipientRole === "manager" || row.recipientRole === "team") {
    try {
      const category = managerNotificationCategoryForEvent(
        String(row.payload.notificationCategory ?? CATEGORY_BY_KIND[row.kind]),
      );
      await notifyManagerFromAgent(db, {
        landlordId:
          typeof row.payload.recipientUserId === "string" && row.payload.recipientUserId.trim()
            ? row.payload.recipientUserId.trim()
            : row.managerUserId,
        subject,
        text: body,
        externalText: "Open PropLane to review this reminder.",
        threadType: "agent_reminder",
        url: typeof row.payload.url === "string" ? row.payload.url : undefined,
        category,
        idempotencyKey: row.id,
      });
      await resolveReminder(db, row.id, workerId, "sent");
      return "sent";
    } catch (error) {
      await resolveReminder(
        db,
        row.id,
        workerId,
        "scheduled",
        error instanceof Error ? error.message : "manager reminder delivery threw",
      );
      return "retried";
    }
  }

  const outcome: SendOutcome = await (async () => {
    try {
      const result = await deliverPortalInboxMessage(db, {
        senderUserId: sender.userId,
        senderEmail: sender.email,
        fromName: sender.name,
        subject,
        text: body,
        toEmails: [row.recipientEmail],
        deliverToPortalInbox: channels.inbox,
        deliverViaEmail: channels.email,
        deliverViaSms: channels.sms,
        eventCategory: CATEGORY_BY_KIND[row.kind],
        senderRole: "manager",
      });
      if (result.ok) return { ok: true as const };
      return { ok: false as const, permanent: isPermanentDeliveryRefusal(result.error), error: result.error };
    } catch (error) {
      return {
        ok: false as const,
        permanent: false,
        error: error instanceof Error ? error.message : "delivery threw",
      };
    }
  })();

  if (outcome.ok) {
    await resolveReminder(db, row.id, workerId, "sent");
    return "sent";
  }
  if (outcome.permanent) {
    await resolveReminder(db, row.id, workerId, "failed", outcome.error);
    return "failed";
  }
  await resolveReminder(db, row.id, workerId, "scheduled", outcome.error);
  return "retried";
}

/**
 * One dispatcher pass.
 *
 * Rows are sent sequentially rather than in parallel: the batch is small, the
 * providers rate-limit, and a serial loop means one row's failure cannot take
 * the rest of the batch down with it. Senders and rules are loaded once per
 * run rather than per row, so a busy tick is a couple of queries, not N.
 */
export async function dispatchDueReminders(
  db: SupabaseClient,
  workerId: string,
  limit = 100,
): Promise<DispatchSummary> {
  const claimed = await claimDueReminders(db, workerId, limit);
  const summary: DispatchSummary = { claimed: claimed.length, sent: 0, failed: 0, retried: 0, errors: [] };
  if (claimed.length === 0) return summary;

  const managerIds = claimed.map((row) => row.managerUserId);
  const [senders, settingsByManager] = await Promise.all([
    loadSenders(db, managerIds),
    loadReminderSettingsForManagers(db, managerIds),
  ]);

  for (const row of claimed) {
    try {
      const rule =
        settingsByManager.get(row.managerUserId)?.rules[row.kind] ??
        DEFAULT_REMINDER_SETTINGS.rules[row.kind];
      const result = await dispatchReminderRow(db, workerId, row, senders.get(row.managerUserId), {
        inbox: rule.inbox,
        email: rule.email,
        sms: rule.sms,
      });
      if (result === "sent") summary.sent += 1;
      else if (result === "failed") summary.failed += 1;
      else summary.retried += 1;
    } catch (error) {
      summary.retried += 1;
      summary.errors.push(`${row.id}: ${error instanceof Error ? error.message : "unknown"}`);
      // Release the lease so the row is retried rather than stranded in
      // `sending` until its lease expires.
      await resolveReminder(db, row.id, workerId, "scheduled", "dispatch threw").catch(() => undefined);
    }
  }
  return summary;
}
