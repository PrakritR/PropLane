/**
 * Manager's "Approve + Pay" core, extracted from the approve-pay route so the
 * agent tool layer runs the exact same completion + expense-logging +
 * markWorkOrderPaid + best-effort Stripe payout + notifications as the manager
 * UI. Caller owns authentication and the financials tier gate.
 *
 * Payout anchoring: the real Stripe transfer inside payoutVendorForWorkOrder
 * always prefers the accepted bid's amount_cents when one exists — the
 * caller-supplied vendorCostCents is only a fallback for jobs assigned without
 * formal bidding, so a forged amount can never inflate a payout beyond the
 * agreed bid.
 */
import { track } from "@/lib/analytics/posthog";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import type { WorkOrderCategory } from "@/lib/reports/categories";
import { createExpensesFromWorkOrder, markWorkOrderPaid, mergeWorkOrderCompletion } from "@/lib/work-order-expenses";
import { payoutVendorForWorkOrder } from "@/lib/stripe-vendor-payout";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { WorkOrderActionFailure } from "@/lib/work-order-bids.server";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export type ApprovePayActor = { userId: string; email: string; isAdmin: boolean };

export type ApprovePayInput = {
  workOrder?: DemoManagerWorkOrderRow;
  category?: WorkOrderCategory;
  vendorCostCents?: number;
  materialsCostCents?: number;
  materialsMemo?: string;
  workDoneSummary?: string;
  paymentChannel?: "ach" | "zelle" | "venmo";
};

export type ApprovePaySuccess = {
  ok: true;
  workOrder: DemoManagerWorkOrderRow;
  expenseEntryIds: string[];
};

/** Runs the same completion + expense-logging as /work-orders/complete, marks the
 * vendor paid, and (best-effort) transfers the vendor's labor cost to their connected
 * Stripe account if they've finished Connect onboarding — see payoutVendorForWorkOrder.
 * Notifies the resident and vendor. */
export async function approveAndPayWorkOrder(
  db: Db,
  actor: ApprovePayActor,
  input: ApprovePayInput,
): Promise<ApprovePaySuccess | WorkOrderActionFailure> {
  const workOrder = input.workOrder;
  if (!workOrder?.id) return { ok: false, status: 400, error: "workOrder required." };
  if (!input.category) return { ok: false, status: 400, error: "category required." };

  const { data: existing } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, vendor_user_id, row_data")
    .eq("id", workOrder.id)
    .maybeSingle();
  if (!existing || (!actor.isAdmin && existing.manager_user_id !== actor.userId)) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const existingRow = (existing.row_data ?? {}) as DemoManagerWorkOrderRow;

  const ownerManagerUserId = String(existing.manager_user_id ?? actor.userId);
  const { data: acceptedBid } = await db
    .from("work_order_bids")
    .select("amount_cents, materials_cents, vendor_directory_id")
    .eq("work_order_id", workOrder.id)
    .eq("status", "accepted")
    .maybeSingle();
  const bidVendorCostCents = acceptedBid?.amount_cents == null ? NaN : Number(acceptedBid.amount_cents);
  // NaN is the "no accepted bid figure" sentinel, matching the labor line above.
  // This used to default to 0, and `Number.isFinite(0)` is true — so whenever
  // there was no accepted bid (a directly-assigned work order), the caller's
  // `materialsCostCents` was silently discarded: no materials expense row, no GL
  // posting, and `mergeWorkOrderCompletion` wrote the materials back as 0. The
  // agent's own preview printed the real figure and then booked nothing.
  const bidMaterialsCostCents = acceptedBid?.materials_cents == null ? NaN : Number(acceptedBid.materials_cents);
  const acceptedVendorCostCents =
    Number.isFinite(bidVendorCostCents) ? bidVendorCostCents : input.vendorCostCents;
  const acceptedMaterialsCostCents =
    Number.isFinite(bidMaterialsCostCents) ? bidMaterialsCostCents : input.materialsCostCents;
  const acceptedVendorId =
    typeof acceptedBid?.vendor_directory_id === "string" && acceptedBid.vendor_directory_id.trim()
      ? acceptedBid.vendor_directory_id
      : existingRow.vendorId;

  const paymentChannel = input.paymentChannel === "zelle" || input.paymentChannel === "venmo" || input.paymentChannel === "ach"
    ? input.paymentChannel
    : "ach";

  const { data: vendorDirectory } = acceptedVendorId
    ? await db
        .from("manager_vendor_records")
        .select("row_data")
        .eq("id", acceptedVendorId)
        .eq("manager_user_id", ownerManagerUserId)
        .maybeSingle()
    : { data: null };
  const vendorRow = (vendorDirectory?.row_data ?? null) as {
    zelleContact?: string;
    venmoContact?: string;
    zellePaymentsEnabled?: boolean;
    venmoPaymentsEnabled?: boolean;
  } | null;

  const expenseEntryIds = await createExpensesFromWorkOrder(db, ownerManagerUserId, {
    workOrderId: workOrder.id,
    category: input.category,
    vendorCostCents: acceptedVendorCostCents,
    materialsCostCents: acceptedMaterialsCostCents,
    materialsMemo: input.materialsMemo,
    workDoneSummary: input.workDoneSummary,
    propertyId: workOrder.propertyId || workOrder.assignedPropertyId,
    vendorId: acceptedVendorId,
  });

  const completed = mergeWorkOrderCompletion(
    { ...existingRow, ...workOrder },
    {
      workOrderId: workOrder.id,
      category: input.category,
      vendorCostCents: acceptedVendorCostCents,
      materialsCostCents: acceptedMaterialsCostCents,
      materialsMemo: input.materialsMemo,
      workDoneSummary: input.workDoneSummary,
      propertyId: workOrder.propertyId,
      vendorId: acceptedVendorId,
    },
    expenseEntryIds,
  );
  const paid = markWorkOrderPaid(completed, new Date().toISOString(), {
    channel: paymentChannel,
    zelleContactSnapshot:
      paymentChannel === "zelle" && vendorRow?.zellePaymentsEnabled ? vendorRow.zelleContact?.trim() : undefined,
    venmoContactSnapshot:
      paymentChannel === "venmo" && vendorRow?.venmoPaymentsEnabled ? vendorRow.venmoContact?.trim() : undefined,
  });

  const { error } = await db.from("portal_work_order_records").upsert(
    {
      id: workOrder.id,
      manager_user_id: ownerManagerUserId,
      property_id: workOrder.propertyId ?? null,
      resident_email: workOrder.residentEmail ?? null,
      row_data: paid,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) return { ok: false, status: 500, error: error.message };

  if (existing.vendor_user_id && paymentChannel === "ach") {
    // amountCents here is only a fallback for jobs assigned without formal bidding —
    // payoutVendorForWorkOrder anchors to the work order's accepted bid when one exists,
    // so a forged vendorCostCents can't inflate a payout beyond the agreed bid.
    await payoutVendorForWorkOrder(db, {
      workOrderId: workOrder.id,
      managerUserId: ownerManagerUserId,
      vendorUserId: existing.vendor_user_id,
      amountCents: acceptedVendorCostCents ?? 0,
    }).catch(() => undefined);
  }

  const propertyLabel = paid.propertyName ? `${paid.propertyName}${paid.unit ? ` · ${paid.unit}` : ""}` : "";
  const title = paid.title || "Service";
  const residentEmail = (paid.residentEmail ?? "").trim();
  if (residentEmail.includes("@")) {
    await deliverPortalInboxMessage(db, {
      senderUserId: actor.userId,
      senderEmail: actor.email,
      fromName: "PropLane Portal",
      subject: `${title} completed`,
      text: `Your service "${title}"${propertyLabel ? ` at ${propertyLabel}` : ""} has been completed.`,
      toEmails: [residentEmail],
      deliverToPortalInbox: true,
      deliverViaEmail: false,
      deliverViaSms: false,
    }).catch(() => undefined);
  }
  if (existing.vendor_user_id) {
    await deliverPortalInboxMessage(db, {
      senderUserId: actor.userId,
      senderEmail: actor.email,
      fromName: "PropLane Portal",
      subject: `${title} approved and paid`,
      text: `"${title}"${propertyLabel ? ` at ${propertyLabel}` : ""} has been approved and marked paid. Thanks for the work.`,
      toUserIds: [existing.vendor_user_id],
      deliverToPortalInbox: true,
      deliverViaEmail: false,
      deliverViaSms: false,
    }).catch(() => undefined);
  }

  track("work_order_completed", actor.userId, {
    work_order_id: workOrder.id,
    property_id: workOrder.propertyId ?? "",
    category: input.category ?? "",
  });
  track("work_order_paid", actor.userId, { work_order_id: workOrder.id, property_id: workOrder.propertyId ?? "" });
  return { ok: true, workOrder: paid, expenseEntryIds };
}
