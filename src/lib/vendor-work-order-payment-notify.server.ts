import "server-only";

import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import {
  resolveManagerRecipientProfiles,
  resolvePropertyScopedManagerRecipientIds,
} from "@/lib/co-manager-notification-recipients.server";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  buildVendorWorkOrderPaymentNotifyEmail,
  type VendorWorkOrderPaymentNotifyKind,
} from "@/lib/vendor-work-order-payment-notify-email";
import { vendorPaymentMethodSummaryLines } from "@/lib/vendor-payment-methods";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

function workOrderPropertyId(row: DemoManagerWorkOrderRow): string | undefined {
  return String(row.assignedPropertyId ?? row.propertyId ?? "").trim() || undefined;
}

function workOrderAmountLabel(row: DemoManagerWorkOrderRow): string {
  const labor = row.vendorCostCents ?? 0;
  const materials = row.materialsCostCents ?? 0;
  if (labor + materials > 0) {
    return `$${((labor + materials) / 100).toFixed(2)}`;
  }
  const cost = row.cost?.trim();
  return cost && cost !== "—" ? cost : "the agreed amount";
}

function isVendorPaymentPending(row: DemoManagerWorkOrderRow): boolean {
  if (row.automationStatus === "paid") return false;
  return row.bucket === "completed" || row.automationStatus === "vendor_marked_done";
}

export async function deliverVendorWorkOrderPaymentNotify(
  db: ServiceClient,
  input: {
    workOrderId: string;
    vendorUserId: string;
    vendorEmail: string;
    vendorName: string;
    kind: VendorWorkOrderPaymentNotifyKind;
  },
): Promise<{ ok: true; recipientCount: number } | { ok: false; error: string }> {
  const workOrderId = input.workOrderId.trim();
  if (!workOrderId) return { ok: false, error: "Work order id required." };

  const { data: workOrder } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, vendor_user_id, row_data")
    .eq("id", workOrderId)
    .maybeSingle();
  if (!workOrder) return { ok: false, error: "Work order not found." };
  if (workOrder.vendor_user_id !== input.vendorUserId) {
    return { ok: false, error: "Forbidden." };
  }

  const rowData = (workOrder.row_data ?? {}) as DemoManagerWorkOrderRow;
  if (!isVendorPaymentPending(rowData)) {
    return { ok: false, error: "This payment is no longer pending." };
  }

  const propertyId = workOrderPropertyId(rowData);
  const { data: offerRows } = await db
    .from("work_order_vendor_offers")
    .select("manager_user_id")
    .eq("work_order_id", workOrderId)
    .eq("vendor_user_id", input.vendorUserId);

  const unit = rowData.unit?.trim();
  const { subject, text } = buildVendorWorkOrderPaymentNotifyEmail({
    vendorName: input.vendorName,
    workOrderTitle: rowData.title ?? "Work order",
    propertyLabel: rowData.propertyName ?? "Property",
    unit,
    amountLabel: workOrderAmountLabel(rowData),
    kind: input.kind,
  });

  return deliverVendorPaymentFollowUp(db, {
    ownerManagerUserId: workOrder.manager_user_id,
    propertyId,
    extraRecipientIds: (offerRows ?? []).map((offer) => String(offer.manager_user_id ?? "").trim()),
    vendorUserId: input.vendorUserId,
    vendorEmail: input.vendorEmail,
    vendorName: input.vendorName,
    subject,
    text,
  });
}

/**
 * The one delivery path for a vendor's payment follow-up: resolve the manager and the co-managers
 * who take inbox notices for the property, append the vendor's preferred payment methods, and
 * deliver a portal inbox message from the vendor. `send_reminder` on a work order and the invoice
 * reminder both go through here, so a manager sees the same message either way.
 */
export async function deliverVendorPaymentFollowUp(
  db: ServiceClient,
  input: {
    ownerManagerUserId: string | null;
    propertyId?: string;
    /** Extra manager ids that already deal with this vendor (the offer sender). */
    extraRecipientIds?: string[];
    vendorUserId: string;
    vendorEmail: string;
    vendorName: string;
    subject: string;
    text: string;
  },
): Promise<{ ok: true; recipientCount: number } | { ok: false; error: string }> {
  const recipientIds = await resolvePropertyScopedManagerRecipientIds(db, {
    ownerManagerUserId: input.ownerManagerUserId,
    propertyId: input.propertyId,
    channel: "inbox",
  });
  for (const id of input.extraRecipientIds ?? []) if (id) recipientIds.push(id);

  const uniqueRecipientIds = [...new Set(recipientIds.filter(Boolean))];
  if (uniqueRecipientIds.length === 0) {
    return { ok: false, error: "No manager recipients found." };
  }

  const profiles = await resolveManagerRecipientProfiles(db, uniqueRecipientIds);
  if (profiles.length === 0) {
    return { ok: false, error: "No manager recipients found." };
  }

  const { data: vendorDirectory } = await db
    .from("manager_vendor_records")
    .select("row_data")
    .eq("vendor_user_id", input.vendorUserId)
    .maybeSingle();
  const vendorRow = (vendorDirectory?.row_data ?? {}) as { achPaymentsEnabled?: boolean };
  const paymentMethodLines = vendorPaymentMethodSummaryLines(vendorRow);

  const textWithPaymentMethods =
    paymentMethodLines.length > 0
      ? `${input.text}\n\nPreferred payment methods:\n${paymentMethodLines.map((line) => `• ${line}`).join("\n")}`
      : input.text;

  const delivery = await deliverPortalInboxMessage(db, {
    senderUserId: input.vendorUserId,
    senderEmail: input.vendorEmail,
    senderRole: "vendor",
    fromName: input.vendorName || "PropLane Portal",
    subject: input.subject,
    text: textWithPaymentMethods,
    toUserIds: profiles.map((profile) => profile.userId),
    eventCategory: "maintenance",
  });

  if (!delivery.ok) return delivery;
  return { ok: true, recipientCount: delivery.recipientCount };
}
