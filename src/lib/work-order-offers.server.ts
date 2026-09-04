/**
 * Shared "offer this work order to vendors for bids" logic, extracted from the
 * work-order-vendor-offers route so the agent tool layer runs the exact same
 * offer upsert + bid-offer email + inbox notification + biddingOpen transition
 * as the manager UI — no second notification path.
 */
import { track } from "@/lib/analytics/posthog";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { sendVendorNotification } from "@/lib/vendor-notification-delivery";
import { resolvePropertyScopedManagerRecipientIds } from "@/lib/co-manager-notification-recipients.server";
import { notifyWorkOrderEvent } from "@/lib/work-order-notification.server";
import { buildVendorBidOfferEmail } from "@/lib/vendor-visit-email";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderActionFailure, WorkOrderActor } from "@/lib/work-order-bids.server";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export const MAX_VENDORS_PER_SEND = 10;

export type VendorDirectorySummary = {
  name: string;
  email: string;
  trade: string;
  managerUserId: string | null;
  shared: boolean;
  vendorUserId: string | null;
};

export async function vendorDirectoryRowsById(db: Db, ids: string[]): Promise<Map<string, VendorDirectorySummary>> {
  const out = new Map<string, VendorDirectorySummary>();
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return out;
  const { data } = await db
    .from("manager_vendor_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .in("id", uniqueIds);
  for (const row of data ?? []) {
    const rowData = (row.row_data ?? {}) as Record<string, unknown>;
    out.set(row.id as string, {
      name: String(rowData.name ?? ""),
      email: String(rowData.email ?? ""),
      trade: String(rowData.trade ?? ""),
      managerUserId: (row.manager_user_id as string | null) ?? null,
      shared: rowData.sharedWithManagers === true,
      vendorUserId: (row.vendor_user_id as string | null) ?? null,
    });
  }
  return out;
}

/**
 * The manager's confirm-send action: only this path ever offers a work order
 * to a vendor for consultation — nothing is sent automatically. Creates one
 * offer row per selected vendor and notifies each (email + inbox), reusing the
 * same bid-offer copy and delivery path as the single-vendor "Invite for bids"
 * flow, then opens bidding so responses can come back from any of them.
 */
export async function sendWorkOrderVendorOffers(
  db: Db,
  actor: WorkOrderActor,
  body: { workOrderId?: string; vendorIds?: string[] },
): Promise<{ ok: true; sent: string[]; skipped: string[] } | WorkOrderActionFailure> {
  if (!actor.admin && actor.role !== "manager" && actor.role !== "pro") {
    return { ok: false, status: 403, error: "Forbidden." };
  }

  const workOrderId = String(body.workOrderId ?? "").trim();
  const vendorIds = [...new Set((Array.isArray(body.vendorIds) ? body.vendorIds : []).map((v) => String(v).trim()).filter(Boolean))].slice(
    0,
    MAX_VENDORS_PER_SEND,
  );
  if (!workOrderId) return { ok: false, status: 400, error: "Work order id required." };
  if (vendorIds.length === 0) return { ok: false, status: 400, error: "Select at least one vendor." };

  const { data: workOrder } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, row_data")
    .eq("id", workOrderId)
    .maybeSingle();
  if (!workOrder || (!actor.admin && workOrder.manager_user_id !== actor.userId)) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const rowData = (workOrder.row_data ?? {}) as DemoManagerWorkOrderRow;

  const vendors = await vendorDirectoryRowsById(db, vendorIds);
  const sent: string[] = [];
  const skipped: string[] = [];

  for (const vendorId of vendorIds) {
    const vendor = vendors.get(vendorId);
    const owned = Boolean(vendor) && (actor.admin || vendor!.managerUserId === (workOrder.manager_user_id as string) || vendor!.shared);
    if (!vendor || !owned) {
      skipped.push(vendorId);
      continue;
    }

    const now = new Date().toISOString();
    const { error: offerError } = await db.from("work_order_vendor_offers").upsert(
      {
        work_order_id: workOrderId,
        vendor_directory_id: vendorId,
        vendor_user_id: vendor.vendorUserId,
        manager_user_id: workOrder.manager_user_id,
        status: "sent",
        updated_at: now,
      },
      { onConflict: "work_order_id,vendor_directory_id" },
    );
    if (offerError) {
      skipped.push(vendorId);
      continue;
    }
    sent.push(vendorId);

    if (vendor.email.includes("@")) {
      const { subject, body: messageBody } = buildVendorBidOfferEmail({
        vendorName: vendor.name,
        workOrderTitle: rowData.title || "",
        propertyLabel: rowData.propertyName || "",
        unit: rowData.unit || "",
        visitLabel: rowData.scheduled && rowData.scheduled !== "—" ? rowData.scheduled : "",
        description: rowData.description,
      });
      await sendVendorNotification(db, actor, {
        vendorEmail: vendor.email,
        vendorDirectoryId: vendorId,
        vendorUserId: vendor.vendorUserId,
        subject,
        body: messageBody,
      }).catch(() => undefined);
    }
  }

  if (sent.length > 0) {
    const nextRowData: DemoManagerWorkOrderRow = {
      ...rowData,
      biddingOpen: true,
      biddingOpenedAt: rowData.biddingOpenedAt ?? new Date().toISOString(),
    };
    await db
      .from("portal_work_order_records")
      .update({ row_data: nextRowData, updated_at: new Date().toISOString() })
      .eq("id", workOrderId);
  }

  track("work_order_vendor_offer_sent", actor.userId, { work_order_id: workOrderId, vendor_count: sent.length });
  return { ok: true, sent, skipped };
}

/**
 * A vendor's answer to an offer: no, and optionally why.
 *
 * Before this the offer had exactly two states, and 'withdrawn' is the MANAGER pulling it
 * back — so a vendor who was booked, or did not cover that trade, had no way to say no. The
 * offer sat in their list indefinitely while the manager waited for a reply the product gave
 * no way to send, unable to tell "not interested" from "hasn't looked yet".
 *
 * The vendor is read-only on `work_order_vendor_offers` at the database layer, so this runs
 * service-role and re-derives ownership here: an offer is theirs when it names their user id,
 * or names a directory row that does. Never by the offer id alone.
 */
export async function declineWorkOrderVendorOffer(
  db: Db,
  actor: { userId: string; role: string; admin: boolean; fullName?: string; email?: string },
  body: { offerId?: string; reason?: string },
): Promise<{ ok: true } | WorkOrderActionFailure> {
  if (actor.role !== "vendor" && !actor.admin) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const offerId = body.offerId?.trim();
  if (!offerId) return { ok: false, status: 400, error: "Offer id required." };

  const { data: offer, error } = await db
    .from("work_order_vendor_offers")
    .select("id, work_order_id, vendor_directory_id, vendor_user_id, manager_user_id, status")
    .eq("id", offerId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!offer) return { ok: false, status: 404, error: "Offer not found." };

  if (!actor.admin) {
    let mine = offer.vendor_user_id === actor.userId;
    if (!mine) {
      // An offer sent to a directory row before the vendor claimed their account still names
      // the row rather than the user, so ownership has to be checked both ways.
      const { data: directoryRows } = await db
        .from("manager_vendor_records")
        .select("id")
        .eq("vendor_user_id", actor.userId);
      mine = (directoryRows ?? []).some((row) => String(row.id) === String(offer.vendor_directory_id));
    }
    // Not-mine reads as missing rather than forbidden: the id comes from the client and must
    // never confirm that someone else's offer exists.
    if (!mine) return { ok: false, status: 404, error: "Offer not found." };
  }

  if (offer.status !== "sent") {
    return { ok: false, status: 409, error: `This offer is already ${offer.status}.` };
  }

  const reason = body.reason?.trim().slice(0, 500) || null;
  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await db
    .from("work_order_vendor_offers")
    .update({ status: "declined", declined_reason: reason, declined_at: now, updated_at: now })
    .eq("id", offerId)
    // Re-asserted in the write: a manager withdrawing the offer between the read and here
    // makes this a no-op rather than reviving it as declined.
    .eq("status", "sent")
    .select("id")
    .maybeSingle();
  if (updateError) return { ok: false, status: 500, error: updateError.message };
  if (!updated) return { ok: false, status: 409, error: "This offer changed before your reply saved." };

  await notifyManagerOfDeclinedOffer(db, actor, {
    workOrderId: String(offer.work_order_id),
    managerUserId: String(offer.manager_user_id),
    reason,
  });

  return { ok: true };
}

/** Best-effort: the decline is recorded whether or not the manager's notification lands. */
async function notifyManagerOfDeclinedOffer(
  db: Db,
  actor: { userId: string; fullName?: string; email?: string },
  input: { workOrderId: string; managerUserId: string; reason: string | null },
): Promise<void> {
  try {
    const { data: workOrder } = await db
      .from("portal_work_order_records")
      .select("row_data")
      .eq("id", input.workOrderId)
      .maybeSingle();
    const rowData = (workOrder?.row_data ?? {}) as { title?: string; propertyLabel?: string };
    const title = String(rowData.title ?? "").trim() || "Service";

    const recipientIds = await resolvePropertyScopedManagerRecipientIds(db, {
      ownerManagerUserId: input.managerUserId,
      channel: "services",
    });
    if (recipientIds.length === 0) return;

    await notifyWorkOrderEvent(db, {
      event: "vendor_declined",
      senderUserId: actor.userId,
      senderEmail: actor.email ?? "",
      senderName: actor.fullName || undefined,
      subject: `Vendor declined: ${title}`,
      text: `${actor.fullName || "A vendor"} declined "${title}".${input.reason ? ` Reason: ${input.reason}` : ""}`,
      title,
      propertyLabel: String(rowData.propertyLabel ?? "").trim() || undefined,
      note: input.reason ?? undefined,
      toUserIds: recipientIds,
      audience: "manager",
    });
  } catch {
    // Swallowed on purpose: the vendor said no, and that answer must survive a mail outage.
  }
}
