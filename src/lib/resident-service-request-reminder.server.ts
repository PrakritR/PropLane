import "server-only";

import type { ServiceRequest } from "@/lib/service-requests-storage";
import {
  resolveManagerRecipientProfiles,
  resolvePropertyScopedManagerRecipientIds,
} from "@/lib/co-manager-notification-recipients.server";
import { residentSubjectManagerIds } from "@/lib/auth/resident-subject-evidence.server";
import { getPropertyById } from "@/lib/rental-application/data";
import {
  buildResidentServiceRequestReminderEmail,
  RESIDENT_SERVICE_REQUEST_REMINDER_COOLDOWN_MS,
} from "@/lib/resident-work-order-reminder-email";
import { notifyWorkOrderEvent } from "@/lib/work-order-notification.server";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

function reminderCooldownRemainingMs(row: ServiceRequest, now = Date.now()): number {
  const sentAt = row.residentReminderSentAt?.trim();
  if (!sentAt) return 0;
  const ts = Date.parse(sentAt);
  if (!Number.isFinite(ts)) return 0;
  const elapsed = now - ts;
  if (elapsed >= RESIDENT_SERVICE_REQUEST_REMINDER_COOLDOWN_MS) return 0;
  return RESIDENT_SERVICE_REQUEST_REMINDER_COOLDOWN_MS - elapsed;
}

function propertyLabelForRequest(row: ServiceRequest): string {
  const resolved = getPropertyById(row.propertyId.trim());
  if (!resolved) return "Property";
  const street = resolved.address.split(",")[0]?.trim();
  return street || resolved.buildingName || resolved.title || "Property";
}

function priceSummaryForRequest(row: ServiceRequest): string | undefined {
  if (row.price?.trim()) return row.price.trim();
  if (row.priceLimit?.trim()) return `Limit ${row.priceLimit.trim()}`;
  return undefined;
}

export async function deliverResidentServiceRequestReminder(
  db: ServiceClient,
  input: {
    requestId: string;
    residentUserId: string;
    residentEmail: string;
    residentName: string;
  },
): Promise<{ ok: true; recipientCount: number } | { ok: false; error: string }> {
  const requestId = input.requestId.trim();
  const residentEmail = input.residentEmail.trim().toLowerCase();
  if (!requestId) return { ok: false, error: "Request id required." };
  if (!residentEmail) return { ok: false, error: "Resident email required." };

  const { data: record } = await db
    .from("portal_service_request_records")
    .select("manager_user_id, resident_user_id, resident_email, property_id, row_data")
    .eq("id", requestId)
    .maybeSingle();
  if (!record) return { ok: false, error: "Request not found." };

  const residentSubjectId = record.resident_user_id;
  if (residentSubjectId !== input.residentUserId) return { ok: false, error: "Forbidden." };

  const managerUserId = String(record.manager_user_id ?? "").trim();
  if (!managerUserId) return { ok: false, error: "Request has no manager." };

  const managers = await residentSubjectManagerIds(db, input.residentUserId, residentEmail);
  if (!managers.includes(managerUserId)) return { ok: false, error: "Forbidden." };

  const rowData = (record.row_data ?? {}) as ServiceRequest;
  if (rowData.status !== "pending") {
    return { ok: false, error: "Only pending requests can be reminded." };
  }

  const cooldownMs = reminderCooldownRemainingMs(rowData);
  if (cooldownMs > 0) {
    const hours = Math.max(1, Math.ceil(cooldownMs / (60 * 60 * 1000)));
    return {
      ok: false,
      error: `You can send another reminder in about ${hours} hour${hours === 1 ? "" : "s"}.`,
    };
  }

  const propertyId = String(record.property_id ?? rowData.propertyId ?? "").trim() || undefined;
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

  const title = rowData.offerName?.trim() || "Add-on request";
  const propertyLabel = propertyLabelForRequest(rowData);
  const { subject, text } = buildResidentServiceRequestReminderEmail({
    residentName: input.residentName || rowData.residentName || "Resident",
    requestTitle: title,
    propertyLabel,
    priceSummary: priceSummaryForRequest(rowData),
    notes: rowData.notes || rowData.offerDescription,
    requestId,
  });

  await notifyWorkOrderEvent(db, {
    event: "reminder",
    senderUserId: input.residentUserId,
    senderEmail: residentEmail,
    senderName: input.residentName || rowData.residentName || "Resident",
    subject,
    text,
    title,
    propertyLabel,
    toUserIds: profiles.map((profile) => profile.userId),
    itemKind: "service-request",
    audience: "manager",
  });

  const recordEmail = (record.resident_email ?? "").trim().toLowerCase() || null;
  const nextRow: ServiceRequest = {
    ...rowData,
    residentReminderSentAt: new Date().toISOString(),
  };
  await db.from("portal_service_request_records").upsert(
    {
      id: requestId,
      manager_user_id: managerUserId,
      resident_email: recordEmail,
      property_id: propertyId || null,
      status: nextRow.status || null,
      row_data: nextRow,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );

  return { ok: true, recipientCount: profiles.length };
}
