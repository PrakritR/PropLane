import "server-only";

import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import {
  resolveManagerRecipientProfiles,
  resolvePropertyScopedManagerRecipientIds,
} from "@/lib/co-manager-notification-recipients.server";
import { notifyWorkOrderEvent } from "@/lib/work-order-notification.server";
import { residentBelongsToManager } from "@/lib/resident-manager-scope";
import { buildResidentWorkOrderReminderEmail } from "@/lib/resident-work-order-reminder-email";
import { RESIDENT_WORK_ORDER_REMINDER_COOLDOWN_MS } from "@/lib/resident-work-order-reminder-email";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { stampSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

function workOrderPropertyId(row: DemoManagerWorkOrderRow): string | undefined {
  return String(row.assignedPropertyId ?? row.propertyId ?? "").trim() || undefined;
}

function isPendingResidentWorkOrder(row: DemoManagerWorkOrderRow): boolean {
  return row.bucket === "open";
}

function reminderCooldownRemainingMs(row: DemoManagerWorkOrderRow, now = Date.now()): number {
  const sentAt = row.residentReminderSentAt?.trim();
  if (!sentAt) return 0;
  const ts = Date.parse(sentAt);
  if (!Number.isFinite(ts)) return 0;
  const elapsed = now - ts;
  if (elapsed >= RESIDENT_WORK_ORDER_REMINDER_COOLDOWN_MS) return 0;
  return RESIDENT_WORK_ORDER_REMINDER_COOLDOWN_MS - elapsed;
}

export async function deliverResidentWorkOrderReminder(
  db: ServiceClient,
  input: {
    workOrderId: string;
    residentUserId: string;
    residentEmail: string;
    residentName: string;
  },
): Promise<{ ok: true; recipientCount: number } | { ok: false; error: string }> {
  const workOrderId = input.workOrderId.trim();
  const residentEmail = input.residentEmail.trim().toLowerCase();
  if (!workOrderId) return { ok: false, error: "Work order id required." };
  if (!residentEmail) return { ok: false, error: "Resident email required." };

  const { data: workOrder } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, resident_email, row_data")
    .eq("id", workOrderId)
    .maybeSingle();
  if (!workOrder) return { ok: false, error: "Work order not found." };

  const recordEmail = String(workOrder.resident_email ?? "").trim().toLowerCase();
  if (recordEmail !== residentEmail) {
    return { ok: false, error: "Forbidden." };
  }

  const managerUserId = String(workOrder.manager_user_id ?? "").trim();
  if (!managerUserId) return { ok: false, error: "Work order has no manager." };

  const belongs = await residentBelongsToManager(db, { residentEmail, managerUserId });
  if (!belongs) return { ok: false, error: "Forbidden." };

  const rowData = (workOrder.row_data ?? {}) as DemoManagerWorkOrderRow;
  if (!isPendingResidentWorkOrder(rowData)) {
    return { ok: false, error: "Only pending work orders can be reminded." };
  }

  const cooldownMs = reminderCooldownRemainingMs(rowData);
  if (cooldownMs > 0) {
    const hours = Math.max(1, Math.ceil(cooldownMs / (60 * 60 * 1000)));
    return { ok: false, error: `You can send another reminder in about ${hours} hour${hours === 1 ? "" : "s"}.` };
  }

  const propertyId = workOrderPropertyId(rowData);
  const recipientIds = await resolvePropertyScopedManagerRecipientIds(db, {
    ownerManagerUserId: managerUserId,
    propertyId,
    channel: "inbox",
  });
  const uniqueRecipientIds = [...new Set(recipientIds.filter(Boolean))];
  if (uniqueRecipientIds.length === 0) {
    return { ok: false, error: "No manager recipients found." };
  }

  const profiles = await resolveManagerRecipientProfiles(db, uniqueRecipientIds);
  if (profiles.length === 0) {
    return { ok: false, error: "No manager recipients found." };
  }

  const { subject, text } = buildResidentWorkOrderReminderEmail({
    residentName: input.residentName || rowData.residentName || "Resident",
    workOrderTitle: rowData.title ?? "Maintenance request",
    propertyLabel: rowData.propertyName ?? "Property",
    unit: rowData.unit,
    priority: rowData.priority ?? "Medium",
    preferredArrival: rowData.preferredArrival,
    description: rowData.description ?? "",
    workOrderId,
  });

  await notifyWorkOrderEvent(db, {
    event: "reminder",
    senderUserId: input.residentUserId,
    senderEmail: residentEmail,
    senderName: input.residentName || rowData.residentName || "Resident",
    subject,
    text,
    title: rowData.title ?? "Maintenance request",
    propertyLabel: rowData.propertyName,
    toUserIds: profiles.map((profile) => profile.userId),
  });

  const nextRow: DemoManagerWorkOrderRow = {
    ...rowData,
    residentReminderSentAt: new Date().toISOString(),
  };
  await db.from("portal_work_order_records").upsert(
    {
      id: workOrderId,
      manager_user_id: managerUserId,
      resident_email: recordEmail,
      property_id: rowData.propertyId || null,
      assigned_property_id: rowData.assignedPropertyId || null,
      row_data: stampSmsTestProvenance(nextRow as unknown as Record<string, unknown>),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );

  return { ok: true, recipientCount: profiles.length };
}
