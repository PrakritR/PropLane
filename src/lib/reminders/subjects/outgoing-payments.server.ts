/**
 * Manager bills with due dates → the reminder queue.
 *
 * Reads `manager_bills` directly so outgoing-payment reminders stay on real AP
 * rows rather than the browser-built outgoing-payments panel snapshot.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { MANAGER_BILL_SELECT, mapManagerBillRow } from "@/lib/manager-bills";
import {
  loadManagerReminderRecipients,
  loadTeamReminderRecipients,
  teamReminderRecipients,
} from "@/lib/reminders/manager-recipients.server";
import { REMINDER_SUBJECT_CO_MANAGER_MODULE } from "@/lib/co-manager-notification-recipients.server";
import { materializeReminders } from "@/lib/reminders/queue.server";
import { loadReminderSettingsForManagers } from "@/lib/reminders/settings.server";
import { withinHorizon } from "@/lib/reminders/subjects/records.server";

const MAX_ROWS = 500;
const OPEN_STATUSES = ["draft", "pending_approval", "approved", "scheduled"] as const;

function dueAnchorIso(dueDate: string): string {
  const trimmed = dueDate.trim().slice(0, 10);
  const ms = Date.parse(`${trimmed}T12:00:00`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : trimmed;
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function dueDateLabel(dueDate: string): string {
  const ms = Date.parse(`${dueDate.trim().slice(0, 10)}T12:00:00`);
  if (!Number.isFinite(ms)) return dueDate;
  return new Date(ms).toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export async function sweepOutgoingPaymentReminders(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db
    .from("manager_bills")
    .select(MANAGER_BILL_SELECT)
    .in("status", [...OPEN_STATUSES])
    .not("due_date", "is", null)
    .order("due_date", { ascending: true })
    .limit(MAX_ROWS);
  if (error) throw error;

  const entries = (data ?? [])
    .map((row) => {
      const bill = mapManagerBillRow(row as Record<string, unknown>);
      const managerUserId = String((row as { manager_user_id?: unknown }).manager_user_id ?? "").trim();
      if (!managerUserId || !bill.dueDate) return null;
      const anchorIso = dueAnchorIso(bill.dueDate);
      if (!withinHorizon(anchorIso, now)) return null;
      return { bill, managerUserId, anchorIso };
    })
    .filter(Boolean) as Array<{ bill: ReturnType<typeof mapManagerBillRow>; managerUserId: string; anchorIso: string }>;
  if (entries.length === 0) return 0;

  const managerUserIds = entries.map((entry) => entry.managerUserId);
  const [settingsByManager, managerRecipients] = await Promise.all([
    loadReminderSettingsForManagers(db, managerUserIds),
    loadManagerReminderRecipients(db, managerUserIds),
  ]);
  const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");

  let queued = 0;
  for (const entry of entries) {
    const settings = settingsByManager.get(entry.managerUserId);
    if (!settings?.rules.outgoing_payment.enabled) continue;
    const managerRecipient = managerRecipients.get(entry.managerUserId);
    const teamRecipients = teamReminderRecipients(
      await loadTeamReminderRecipients(
        db,
        entry.managerUserId,
        settings.rules.outgoing_payment.teamUserIds ?? [],
        {
          module: REMINDER_SUBJECT_CO_MANAGER_MODULE.outgoing_payment,
          propertyId: entry.bill.propertyId ?? null,
        },
      ),
    );

    queued += await materializeReminders(
      db,
      {
        managerUserId: entry.managerUserId,
        kind: "outgoing_payment",
        subjectId: entry.bill.id,
        anchorIso: entry.anchorIso,
        recipients: [
          ...(managerRecipient
            ? [
                {
                  email: managerRecipient.email,
                  role: "manager" as const,
                  name: managerRecipient.name,
                  userId: entry.managerUserId,
                },
              ]
            : []),
          ...teamRecipients,
        ],
        payload: {
          title: entry.bill.description,
          paymentTitle: entry.bill.description,
          amountLabel: formatMoney(entry.bill.amountCents),
          dueDateLabel: dueDateLabel(entry.bill.dueDate!),
          propertyLabel: entry.bill.propertyId ?? null,
          url: `${origin}/portal/payments/outgoing/pending`,
          notificationCategory: "payments",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}
