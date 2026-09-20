/**
 * `message_unanswered` — a resident wrote and nobody on the management side
 * has replied (PLAN-0915 phase 3).
 *
 * Manager-scope inbox threads keep their messages as an array on the row;
 * each entry carries `outbound: true` when the manager side sent it. The
 * anchor is the thread's `updated_at` at the moment the last message was an
 * inbound one, so "24 hours after" reads from the resident's message. A reply
 * moves `updated_at` and flips the last message outbound, which the currency
 * check reads as "answered" and the queued row is dropped.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { materializeReminders, type ReminderRecipient } from "@/lib/reminders/queue.server";
import { loadReminderSettingsResolver } from "@/lib/reminders/settings.server";
import { loadManagerReminderRecipients, loadTeamReminderRecipients, teamReminderRecipients } from "@/lib/reminders/manager-recipients.server";
import { REMINDER_SUBJECT_CO_MANAGER_MODULE } from "@/lib/co-manager-notification-recipients.server";

export const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";
const MAX_ROWS = 500;

type ThreadRow = { id: string; owner_user_id: string | null; participant_email: string | null; thread_type: string | null; updated_at: string; row_data: Record<string, unknown> };

type ThreadMessage = { from?: unknown; body?: unknown; outbound?: unknown };

/** The last human message on a thread, or null when the thread is empty or automated. */
export function lastInboundMessage(rowData: Record<string, unknown>): { body: string; from: string } | null {
  const messages = Array.isArray(rowData.messages) ? (rowData.messages as ThreadMessage[]) : [];
  const last = messages[messages.length - 1];
  if (!last || last.outbound === true) return null;
  const from = String(last.from ?? "").trim();
  // Automated senders write through the same array; a notice is not a question.
  if (!from || /proplane/i.test(from)) return null;
  return { body: String(last.body ?? "").trim(), from };
}

export async function sweepUnansweredMessages(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString();
  const { data, error } = await db
    .from("portal_inbox_thread_records")
    .select("id, owner_user_id, participant_email, thread_type, updated_at, row_data")
    .eq("scope", MANAGER_INBOX_SCOPE)
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw error;
  const rows = ((data ?? []) as ThreadRow[]).filter((row) => row.owner_user_id && row.participant_email && lastInboundMessage(row.row_data ?? {}));
  if (rows.length === 0) return 0;
  const managerIds = rows.map((row) => String(row.owner_user_id));
  const [reminderResolver, managerRecipients] = await Promise.all([
    loadReminderSettingsResolver(db, managerIds),
    loadManagerReminderRecipients(db, managerIds),
  ]);
  const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");
  let queued = 0;
  for (const row of rows) {
    const managerUserId = String(row.owner_user_id);
    // An inbox thread has no property, so `message_unanswered` always resolves to
    // the workspace rule (PLAN-0916-1040) — no per-house override applies here.
    const settings = reminderResolver.resolve(managerUserId, null);
    if (!settings.rules.message_unanswered.enabled) continue;
    const last = lastInboundMessage(row.row_data ?? {})!;
    const manager = managerRecipients.get(managerUserId);
    const recipients: ReminderRecipient[] = manager ? [{ email: manager.email, role: "manager", name: manager.name, userId: managerUserId }] : [];
    if (settings.rules.message_unanswered.audience.team) {
      recipients.push(
        ...teamReminderRecipients(
          await loadTeamReminderRecipients(db, managerUserId, settings.rules.message_unanswered.teamUserIds ?? [], { module: REMINDER_SUBJECT_CO_MANAGER_MODULE.message_unanswered }),
        ),
      );
    }
    if (recipients.length === 0) continue;
    const anchorIso = new Date(Date.parse(row.updated_at)).toISOString();
    queued += await materializeReminders(
      db,
      {
        managerUserId,
        kind: "message_unanswered",
        subjectId: row.id,
        anchorIso,
        recipients,
        payload: {
          title: last.body.slice(0, 120) || "(no text)",
          counterpartyName: last.from,
          url: `${origin}/portal/communication`,
          notificationCategory: "messages",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}

/** Still unanswered: the thread has not moved and its last message is still inbound. */
export async function unansweredMessageIsCurrent(db: SupabaseClient, threadId: string, managerUserId: string, expectedAnchor: unknown): Promise<boolean> {
  const { data, error } = await db.from("portal_inbox_thread_records").select("owner_user_id, updated_at, row_data").eq("id", threadId).maybeSingle();
  if (error) throw error;
  if (!data || String(data.owner_user_id ?? "") !== managerUserId) return false;
  if (!lastInboundMessage((data.row_data ?? {}) as Record<string, unknown>)) return false;
  const expected = Date.parse(String(expectedAnchor ?? ""));
  const current = Date.parse(String(data.updated_at ?? ""));
  return Number.isFinite(expected) && Number.isFinite(current) && Math.abs(expected - current) < 1000;
}
