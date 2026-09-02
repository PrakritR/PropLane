import type { SupabaseClient } from "@supabase/supabase-js";
import { formatRangeLabel } from "@/lib/tour-inquiry-confirm.server";
import {
  loadManagerAutomationSettings,
  normalizeTourReminderMinutesBeforeList,
  type ManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import {
  createScheduledInboxMessage,
  generateScheduledInboxMessageId,
  type ScheduledInboxMessageRecord,
  updateScheduledInboxMessage,
} from "@/lib/scheduled-inbox-messages";
import {
  DEFAULT_TOUR_REMINDER_TEMPLATE,
  fillTourReminderTemplate,
  TOUR_REMINDER_MESSAGE_KIND,
  tourReminderSendAtIso,
  type TourReminderTemplateContext,
} from "@/lib/tour-reminder";

type Db = SupabaseClient;

type TourReminderDbRow = {
  id: string;
  manager_user_id: string;
  send_at: string;
  status: string;
  row_data: unknown;
  created_at: string;
};

function parseTourReminderRow(row: TourReminderDbRow): ScheduledInboxMessageRecord | null {
  const data = (row.row_data ?? {}) as Record<string, unknown>;
  if (data.messageKind !== TOUR_REMINDER_MESSAGE_KIND) return null;
  return {
    id: row.id,
    managerUserId: row.manager_user_id,
    sendAt: row.send_at,
    status: row.status as ScheduledInboxMessageRecord["status"],
    subject: String(data.subject ?? ""),
    body: String(data.body ?? ""),
    recipientEmail: String(data.recipientEmail ?? "").trim().toLowerCase(),
    recipientName: String(data.recipientName ?? "").trim(),
    recipientUserId: typeof data.recipientUserId === "string" ? data.recipientUserId : null,
    deliverViaEmail: data.deliverViaEmail !== false,
    deliverViaSms: data.deliverViaSms === true,
    messageKind: TOUR_REMINDER_MESSAGE_KIND,
    tourPlannedEventId: typeof data.tourPlannedEventId === "string" ? data.tourPlannedEventId : undefined,
    tourStartIso: typeof data.tourStartIso === "string" ? data.tourStartIso : undefined,
    tourReminderMinutesBefore:
      typeof data.tourReminderMinutesBefore === "number" && Number.isFinite(data.tourReminderMinutesBefore)
        ? data.tourReminderMinutesBefore
        : undefined,
    createdAt: row.created_at,
    sentAt: typeof data.sentAt === "string" ? data.sentAt : null,
    cancelledAt: typeof data.cancelledAt === "string" ? data.cancelledAt : null,
  };
}

async function loadTourReminderRows(
  db: Db,
  managerUserId: string,
  plannedEventId: string,
): Promise<TourReminderDbRow[]> {
  const { data, error } = await db
    .from("portal_scheduled_inbox_message_records")
    .select("id, manager_user_id, send_at, status, row_data, created_at")
    .eq("manager_user_id", managerUserId)
    .eq("row_data->>messageKind", TOUR_REMINDER_MESSAGE_KIND)
    .eq("row_data->>tourPlannedEventId", plannedEventId)
    .order("send_at", { ascending: true })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as TourReminderDbRow[];
}

function pickPreferredTourReminderRow(rows: ScheduledInboxMessageRecord[]): ScheduledInboxMessageRecord {
  const rank = (status: ScheduledInboxMessageRecord["status"]) =>
    status === "scheduled" ? 0 : status === "cancelled" ? 1 : 2;
  return [...rows].sort((a, b) => {
    const byStatus = rank(a.status) - rank(b.status);
    if (byStatus !== 0) return byStatus;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  })[0]!;
}

/** Cancel extra scheduled rows that share the same tour offset (legacy double-create cleanup). */
export async function reconcileDuplicateTourReminders(
  db: Db,
  managerUserId: string,
  plannedEventId: string,
): Promise<void> {
  const rows = (await loadTourReminderRows(db, managerUserId, plannedEventId))
    .map((row) => parseTourReminderRow(row))
    .filter((row): row is ScheduledInboxMessageRecord => row != null);
  const groups = new Map<number | "legacy", ScheduledInboxMessageRecord[]>();
  for (const row of rows) {
    const key = row.tourReminderMinutesBefore ?? "legacy";
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const now = new Date().toISOString();
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const winner = pickPreferredTourReminderRow(group);
    for (const row of group) {
      if (row.id === winner.id || row.status !== "scheduled") continue;
      await updateScheduledInboxMessage(db, managerUserId, row.id, {
        status: "cancelled",
        cancelledAt: now,
      });
    }
  }
}

export async function listTourRemindersForPlannedEvent(
  db: Db,
  managerUserId: string,
  plannedEventId: string,
): Promise<ScheduledInboxMessageRecord[]> {
  const rows = await loadTourReminderRows(db, managerUserId, plannedEventId);
  const parsed = rows
    .map((row) => parseTourReminderRow(row))
    .filter(
      (row): row is ScheduledInboxMessageRecord =>
        row != null && (row.status === "scheduled" || row.status === "cancelled" || row.status === "sent"),
    );
  const groups = new Map<number | "legacy", ScheduledInboxMessageRecord[]>();
  for (const row of parsed) {
    const key = row.tourReminderMinutesBefore ?? "legacy";
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.values()].map((group) => pickPreferredTourReminderRow(group));
}

export async function findTourReminderForPlannedEvent(
  db: Db,
  managerUserId: string,
  plannedEventId: string,
): Promise<ScheduledInboxMessageRecord | null> {
  const reminders = await listTourRemindersForPlannedEvent(db, managerUserId, plannedEventId);
  const scheduled = reminders.filter((row) => row.status === "scheduled");
  if (!scheduled.length) return reminders[0] ?? null;
  return scheduled.sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime())[0] ?? null;
}

export async function cancelTourReminderForPlannedEvent(
  db: Db,
  managerUserId: string,
  plannedEventId: string,
): Promise<void> {
  const rows = await loadTourReminderRows(db, managerUserId, plannedEventId);
  const now = new Date().toISOString();
  for (const row of rows) {
    const parsed = parseTourReminderRow(row);
    if (!parsed || parsed.status !== "scheduled") continue;
    await updateScheduledInboxMessage(db, managerUserId, parsed.id, {
      status: "cancelled",
      cancelledAt: now,
    });
  }
}

export type UpsertTourReminderInput = {
  managerUserId: string;
  plannedEventId: string;
  tourStartIso: string;
  tourEndIso: string;
  recipientEmail: string;
  recipientName: string;
  propertyTitle?: string;
  instructions?: string;
  managerName: string;
  settings?: ManagerAutomationSettings;
  subject?: string;
  body?: string;
  sendAt?: string;
  deliverViaEmail?: boolean;
  deliverViaSms?: boolean;
  minutesBeforeList?: number[];
};

function buildTourReminderContent(
  input: UpsertTourReminderInput,
  settings: ManagerAutomationSettings,
): { subject: string; body: string } {
  const ctx: TourReminderTemplateContext = {
    guestName: input.recipientName.trim() || "Guest",
    propertyTitle: input.propertyTitle?.trim() ?? "",
    tourTime: formatRangeLabel(input.tourStartIso, input.tourEndIso),
    managerName: input.managerName.trim() || "Your property manager",
    instructions: input.instructions?.trim() ?? "",
  };
  const templated = fillTourReminderTemplate(settings.templates.tourReminder ?? DEFAULT_TOUR_REMINDER_TEMPLATE, ctx);
  return {
    subject: input.subject?.trim() || templated.subject,
    body: input.body?.trim() || templated.body,
  };
}

export async function upsertTourReminderForPlannedEvent(
  db: Db,
  input: UpsertTourReminderInput,
): Promise<ScheduledInboxMessageRecord | null> {
  const settings = input.settings ?? (await loadManagerAutomationSettings(db, input.managerUserId));
  if (settings.tourReminderEnabled === false) {
    await cancelTourReminderForPlannedEvent(db, input.managerUserId, input.plannedEventId);
    return null;
  }

  const email = input.recipientEmail.trim().toLowerCase();
  if (!email.includes("@")) return null;

  const minutesBeforeList = normalizeTourReminderMinutesBeforeList(
    input.minutesBeforeList ?? settings.tourReminderMinutesBeforeList,
    settings.tourReminderMinutesBefore,
  );
  const { subject, body } = buildTourReminderContent(input, settings);
  const deliverViaEmail = input.deliverViaEmail ?? settings.tourReminderDeliverViaEmail !== false;
  const deliverViaSms = input.deliverViaSms ?? settings.tourReminderDeliverViaSms === true;

  const existing = await listTourRemindersForPlannedEvent(db, input.managerUserId, input.plannedEventId);
  const keyedRows = new Map(
    existing
      .filter((row) => row.tourReminderMinutesBefore != null)
      .map((row) => [row.tourReminderMinutesBefore as number, row]),
  );
  const legacyRows = existing.filter((row) => row.tourReminderMinutesBefore == null);
  const keptIds = new Set<string>();
  const now = new Date().toISOString();

  for (const minutesBefore of minutesBeforeList) {
    const sendAt =
      input.sendAt?.trim() && minutesBeforeList.length === 1
        ? input.sendAt.trim()
        : tourReminderSendAtIso(input.tourStartIso, minutesBefore);
    if (!sendAt) continue;

    const prior = keyedRows.get(minutesBefore) ?? legacyRows.shift();
    if (prior?.status === "sent") {
      keptIds.add(prior.id);
      continue;
    }

    if (prior) {
      await updateScheduledInboxMessage(db, input.managerUserId, prior.id, {
        sendAt,
        subject,
        body,
        recipientEmail: email,
        recipientName: input.recipientName.trim() || email,
        deliverViaEmail,
        deliverViaSms,
        tourReminderMinutesBefore: minutesBefore,
      });
      keptIds.add(prior.id);
      continue;
    }

    const id = generateScheduledInboxMessageId();
    const created = await createScheduledInboxMessage(db, {
      id,
      managerUserId: input.managerUserId,
      sendAt,
      status: "scheduled",
      subject,
      body,
      recipientEmail: email,
      recipientName: input.recipientName.trim() || email,
      deliverViaEmail,
      deliverViaSms,
      messageKind: TOUR_REMINDER_MESSAGE_KIND,
      tourPlannedEventId: input.plannedEventId,
      tourStartIso: input.tourStartIso,
      tourReminderMinutesBefore: minutesBefore,
    });
    keptIds.add(created.id);
  }

  for (const row of existing) {
    if (row.status !== "scheduled" || keptIds.has(row.id)) continue;
    await updateScheduledInboxMessage(db, input.managerUserId, row.id, {
      status: "cancelled",
      cancelledAt: now,
    });
  }

  await reconcileDuplicateTourReminders(db, input.managerUserId, input.plannedEventId);

  const refreshed = await listTourRemindersForPlannedEvent(db, input.managerUserId, input.plannedEventId);
  if (!refreshed.length) return null;
  return refreshed.sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime())[0] ?? null;
}

export async function scheduleTourReminderAfterConfirm(
  db: Db,
  input: {
    managerUserId: string;
    plannedEvent: Record<string, unknown>;
    inquiryRow: Record<string, unknown>;
    managerName: string;
  },
): Promise<ScheduledInboxMessageRecord | null> {
  const plannedEventId = String(input.plannedEvent.id ?? "").trim();
  const start = String(input.plannedEvent.start ?? "").trim();
  const end = String(input.plannedEvent.end ?? "").trim();
  const email = String(input.plannedEvent.attendeeEmail ?? input.inquiryRow.email ?? "").trim();
  const name = String(input.plannedEvent.attendeeName ?? input.inquiryRow.name ?? "").trim();
  if (!plannedEventId || !start || !end || !email) return null;

  return upsertTourReminderForPlannedEvent(db, {
    managerUserId: input.managerUserId,
    plannedEventId,
    tourStartIso: start,
    tourEndIso: end,
    recipientEmail: email,
    recipientName: name,
    propertyTitle: String(input.plannedEvent.propertyTitle ?? input.inquiryRow.propertyTitle ?? "").trim() || undefined,
    instructions: String(input.plannedEvent.instructions ?? input.inquiryRow.instructions ?? "").trim() || undefined,
    managerName: input.managerName,
  });
}
