/**
 * The dispatcher — the only thing that sends a reminder.
 *
 * Runs every 5 minutes. Before this existed, every reminder drained from a
 * once-a-day cron, so any lead time shorter than a day was delivered on the
 * next daily tick — after the event it was announcing.
 *
 * Each claimed row is settled exactly once: `sent` on success, back to
 * `scheduled` on a transient failure so the next run retries it, and `failed`
 * when the row can never succeed (no API key, no address). The attempts ceiling
 * lives in `claim_due_reminders`, so a permanently broken row stops on its own.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { claimDueReminders, resolveReminder, type ReminderQueueRow } from "@/lib/reminders/queue.server";
import { renderReminder, type ReminderPayload } from "@/lib/reminders/render";

export type DispatchSummary = {
  claimed: number;
  sent: number;
  failed: number;
  retried: number;
  errors: string[];
};

/** Distinguishes a retryable outage from a row that can never be delivered. */
type SendOutcome = { ok: true } | { ok: false; permanent: boolean; error: string };

async function sendReminderEmail(to: string, subject: string, text: string): Promise<SendOutcome> {
  const recipient = to.trim().toLowerCase();
  if (!recipient.includes("@")) {
    return { ok: false, permanent: true, error: "invalid recipient address" };
  }
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    // A deployment fact, not a per-row fault. Permanent for this run so the
    // queue is not hammered 288 times a day on a box with no mailer.
    return { ok: false, permanent: true, error: "mailer_unconfigured" };
  }
  const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [recipient], subject, text }),
    });
    if (res.ok) return { ok: true };
    // 4xx is our fault and will not fix itself; 5xx and 429 are worth retrying.
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    return { ok: false, permanent, error: `resend ${res.status}` };
  } catch (error) {
    return { ok: false, permanent: false, error: error instanceof Error ? error.message : "network error" };
  }
}

export async function dispatchReminderRow(
  db: SupabaseClient,
  workerId: string,
  row: ReminderQueueRow,
): Promise<"sent" | "failed" | "retried"> {
  const { subject, body } = renderReminder({
    kind: row.kind,
    leadMinutes: row.leadMinutes,
    recipientRole: row.recipientRole,
    payload: row.payload as ReminderPayload,
  });

  const outcome = await sendReminderEmail(row.recipientEmail, subject, body);
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
 * provider rate-limits, and a serial loop means one row's failure cannot take
 * the rest of the batch down with it.
 */
export async function dispatchDueReminders(
  db: SupabaseClient,
  workerId: string,
  limit = 100,
): Promise<DispatchSummary> {
  const claimed = await claimDueReminders(db, workerId, limit);
  const summary: DispatchSummary = { claimed: claimed.length, sent: 0, failed: 0, retried: 0, errors: [] };

  for (const row of claimed) {
    try {
      const result = await dispatchReminderRow(db, workerId, row);
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
