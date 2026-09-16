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
  const recipientIds = await resolvePropertyScopedManagerRecipientIds(db, {
    ownerManagerUserId: workOrder.manager_user_id,
    propertyId,
    channel: "inbox",
  });

  const { data: offerRows } = await db
    .from("work_order_vendor_offers")
    .select("manager_user_id")
    .eq("work_order_id", workOrderId)
    .eq("vendor_user_id", input.vendorUserId);
  for (const offer of offerRows ?? []) {
    const offerManagerId = String(offer.manager_user_id ?? "").trim();
    if (offerManagerId) recipientIds.push(offerManagerId);
  }

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

  const unit = rowData.unit?.trim();
  const { subject, text } = buildVendorWorkOrderPaymentNotifyEmail({
    vendorName: input.vendorName,
    workOrderTitle: rowData.title ?? "Work order",
    propertyLabel: rowData.propertyName ?? "Property",
    unit,
    amountLabel: workOrderAmountLabel(rowData),
    kind: input.kind,
  });
  const textWithPaymentMethods =
    paymentMethodLines.length > 0
      ? `${text}\n\nPreferred payment methods:\n${paymentMethodLines.map((line) => `• ${line}`).join("\n")}`
      : text;

  const delivery = await deliverPortalInboxMessage(db, {
    senderUserId: input.vendorUserId,
    senderEmail: input.vendorEmail,
    senderRole: "vendor",
    fromName: input.vendorName || "PropLane Portal",
    subject,
    text: textWithPaymentMethods,
    toUserIds: profiles.map((profile) => profile.userId),
    eventCategory: "maintenance",
  });

  if (!delivery.ok) return delivery;
  return { ok: true, recipientCount: delivery.recipientCount };
}
