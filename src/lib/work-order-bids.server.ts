/**
 * Shared work-order bid logic (submit / schedule consultation / accept /
 * set price / mark done), extracted from the API routes so the agent tool layer
 * calls the exact same code path as the manager/vendor UI — one implementation,
 * not two. Functions return plain results ({ ok } | { ok:false, status, error });
 * the routes map them onto NextResponse, the tools onto ExecuteResult.
 *
 * Invariant carried over from the routes: an accepted bid's amount_cents is the
 * immutable payout anchor. setVendorPriceForWorkOrder refuses (409) to touch an
 * accepted bid, and its bid UPDATE re-checks status in the WHERE clause so a
 * concurrent accept can't be overwritten by a stale read.
 */
import { track } from "@/lib/analytics/posthog";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveVendorNextAvailableSlot } from "@/lib/vendor-availability-server";
import { buildVendorBidAcceptedEmail, buildVendorBidDeclinedEmail } from "@/lib/vendor-visit-email";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { generateWorkOrderPaymentReference } from "@/lib/payment-reference";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

/** Placeholder duration used only to keep a scheduled consultation from double-booking
 * against other pending consultations — the real job visit is scheduled separately once
 * priced (see scheduledAtIso on the work order). */
const CONSULTATION_VISIT_DURATION_MINUTES = 30;

export type QuoteMode = "upfront" | "after_consultation";

export type BidRecord = {
  id: string;
  work_order_id: string;
  vendor_user_id: string;
  vendor_directory_id: string | null;
  manager_user_id: string;
  quote_mode: QuoteMode;
  consultation_visit_at: string | null;
  amount_cents: number | null;
  materials_cents: number;
  proposed_time: string | null;
  note: string | null;
  status: "submitted" | "accepted" | "declined";
  created_at: string;
  updated_at: string;
};

/** The acting session identity. `userId` is always the authenticated user (or the
 * agent context's landlordId, which is the same id) — never client/model input. */
export type WorkOrderActor = {
  userId: string;
  email: string;
  fullName: string;
  admin: boolean;
  role: string;
};

export type WorkOrderActionFailure = { ok: false; status: number; error: string };

export async function vendorNamesById(db: Db, ids: string[]): Promise<Map<string, { name: string; email: string }>> {
  const out = new Map<string, { name: string; email: string }>();
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return out;
  const { data } = await db.from("manager_vendor_records").select("id, row_data").in("id", uniqueIds);
  for (const row of data ?? []) {
    const rowData = (row.row_data ?? {}) as Record<string, unknown>;
    out.set(row.id as string, { name: String(rowData.name ?? ""), email: String(rowData.email ?? "") });
  }
  return out;
}

async function vendorDirectoryIdsForUser(db: Db, vendorUserId: string, managerUserId?: string): Promise<string[]> {
  let query = db.from("manager_vendor_records").select("id").eq("vendor_user_id", vendorUserId);
  if (managerUserId) query = query.eq("manager_user_id", managerUserId);
  const { data } = await query;
  return (data ?? []).map((row) => String(row.id ?? "")).filter(Boolean);
}

type WorkOrderAccess = { managerUserId: string; rowData: DemoManagerWorkOrderRow };

/** A vendor may act on a work order if they're the currently assigned vendor, or if the
 * manager sent them a consultation/quote offer for it — while bidding is open, or while a
 * post-consultation price is still pending on their placeholder bid. */
async function resolveVendorWorkOrderAccess(
  db: Db,
  actor: WorkOrderActor,
  workOrderId: string,
): Promise<{ ok: true; access: WorkOrderAccess } | WorkOrderActionFailure> {
  const { data: workOrder } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, vendor_user_id, row_data")
    .eq("id", workOrderId)
    .maybeSingle();
  if (!workOrder) return { ok: false, status: 403, error: "Forbidden." };

  const isAssignedVendor = workOrder.vendor_user_id === actor.userId;
  let isOfferedVendor = false;
  if (!isAssignedVendor) {
    const vendorDirectoryIds = await vendorDirectoryIdsForUser(db, actor.userId);
    const { data: offerByUser } = await db
      .from("work_order_vendor_offers")
      .select("id")
      .eq("work_order_id", workOrderId)
      .eq("vendor_user_id", actor.userId)
      .eq("status", "sent")
      .maybeSingle();
    isOfferedVendor = Boolean(offerByUser);
    if (!isOfferedVendor && vendorDirectoryIds.length > 0) {
      const { data: offerByDirectory } = await db
        .from("work_order_vendor_offers")
        .select("id")
        .eq("work_order_id", workOrderId)
        .in("vendor_directory_id", vendorDirectoryIds)
        .eq("status", "sent")
        .limit(1);
      isOfferedVendor = Boolean(offerByDirectory?.length);
    }
  }
  if (!isAssignedVendor && !isOfferedVendor) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const rowData = (workOrder.row_data ?? {}) as DemoManagerWorkOrderRow;
  if (!rowData.biddingOpen) {
    const { data: pendingBid } = await db
      .from("work_order_bids")
      .select("quote_mode, amount_cents, consultation_visit_at, status")
      .eq("work_order_id", workOrderId)
      .eq("vendor_user_id", actor.userId)
      .maybeSingle();
    const pricingPending =
      pendingBid?.status === "submitted" &&
      pendingBid.quote_mode === "after_consultation" &&
      pendingBid.consultation_visit_at &&
      pendingBid.amount_cents == null;
    if (!pricingPending) {
      return { ok: false, status: 400, error: "Bidding is not open for this service." };
    }
  }
  return { ok: true, access: { managerUserId: workOrder.manager_user_id as string, rowData } };
}

export async function submitWorkOrderBid(
  db: Db,
  actor: WorkOrderActor,
  body: { workOrderId?: string; amountCents?: number; materialsCents?: number; proposedTime?: string; note?: string },
): Promise<{ ok: true } | WorkOrderActionFailure> {
  if (actor.role !== "vendor") return { ok: false, status: 403, error: "Forbidden." };

  const workOrderId = String(body.workOrderId ?? "").trim();
  const amountCents = Math.round(Number(body.amountCents));
  const materialsCents = body.materialsCents === undefined ? 0 : Math.round(Number(body.materialsCents));
  const proposedTime = String(body.proposedTime ?? "").trim();
  const note = String(body.note ?? "").trim().slice(0, 2000);

  if (!workOrderId) return { ok: false, status: 400, error: "Work order id required." };
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { ok: false, status: 400, error: "Enter a valid labor cost." };
  }
  if (!Number.isFinite(materialsCents) || materialsCents < 0) {
    return { ok: false, status: 400, error: "Enter a valid equipment/materials cost." };
  }
  const proposedDate = new Date(proposedTime);
  if (Number.isNaN(proposedDate.getTime())) {
    return { ok: false, status: 400, error: "Enter a valid proposed date/time." };
  }

  const access = await resolveVendorWorkOrderAccess(db, actor, workOrderId);
  if (!access.ok) return access;

  const { data: existing } = await db
    .from("work_order_bids")
    .select("id, status, quote_mode, consultation_visit_at")
    .eq("work_order_id", workOrderId)
    .eq("vendor_user_id", actor.userId)
    .maybeSingle();
  if (existing && existing.status !== "submitted") {
    return { ok: false, status: 403, error: "This bid has already been resolved." };
  }

  const { data: vendorDirectoryRow } = await db
    .from("manager_vendor_records")
    .select("id")
    .eq("vendor_user_id", actor.userId)
    .eq("manager_user_id", access.access.managerUserId)
    .maybeSingle();

  const record = {
    work_order_id: workOrderId,
    vendor_user_id: actor.userId,
    vendor_directory_id: (vendorDirectoryRow?.id as string | undefined) ?? null,
    manager_user_id: access.access.managerUserId,
    quote_mode: (existing?.quote_mode as QuoteMode | undefined) ?? "upfront",
    consultation_visit_at: existing?.consultation_visit_at ?? null,
    amount_cents: amountCents,
    materials_cents: materialsCents,
    proposed_time: proposedDate.toISOString(),
    note: note || null,
    status: "submitted" as const,
    updated_at: new Date().toISOString(),
  };

  // The `existing.status` read above is a stale read by the time we write. A
  // manager accepting the bid in between used to lose: an unconditional upsert
  // overwrote the accepted amount and flipped the row back to "submitted",
  // which then made the payout's `status = "accepted"` anchor lookup miss and
  // fall through to a caller-supplied number. Re-check the status in the WHERE
  // clause, the same compare-and-swap `setVendorPriceForWorkOrder` already
  // uses, and treat zero rows affected as the conflict it is.
  if (existing) {
    const { data: updated, error } = await db
      .from("work_order_bids")
      .update(record)
      .eq("id", existing.id)
      .eq("status", "submitted")
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, status: 500, error: error.message };
    if (!updated) {
      return { ok: false, status: 409, error: "This bid was just accepted — it can no longer be re-priced." };
    }
  } else {
    const { error } = await db.from("work_order_bids").insert(record);
    if (error) return { ok: false, status: 500, error: error.message };
  }

  track("work_order_bid_submitted", actor.userId, { work_order_id: workOrderId });
  return { ok: true };
}

/** Vendor withdraws their own unaccepted bid so the manager is not waiting on a quote they will not send. */
export async function withdrawWorkOrderBid(
  db: Db,
  actor: WorkOrderActor,
  body: { workOrderId?: string },
): Promise<{ ok: true } | WorkOrderActionFailure> {
  if (actor.role !== "vendor") return { ok: false, status: 403, error: "Forbidden." };

  const workOrderId = String(body.workOrderId ?? "").trim();
  if (!workOrderId) return { ok: false, status: 400, error: "Work order id required." };

  const access = await resolveVendorWorkOrderAccess(db, actor, workOrderId);
  if (!access.ok) return access;

  const { data, error } = await db
    .from("work_order_bids")
    .delete()
    .eq("work_order_id", workOrderId)
    .eq("vendor_user_id", actor.userId)
    .eq("status", "submitted")
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) {
    return { ok: false, status: 409, error: "This bid was already accepted or declined." };
  }
  return { ok: true };
}

/** Vendor's first step of the "quote after consultation" mode: book (or manually set) a
 * consultation visit and save a pricing-pending placeholder bid row. The vendor prices the
 * job afterward via submitWorkOrderBid, which preserves quote_mode/consultation_visit_at. */
export async function scheduleWorkOrderConsultation(
  db: Db,
  actor: WorkOrderActor,
  body: { workOrderId?: string; mode?: "auto" | "manual"; consultationVisitAt?: string; note?: string },
): Promise<{ ok: true; consultationVisitAt: string } | WorkOrderActionFailure> {
  if (actor.role !== "vendor") return { ok: false, status: 403, error: "Forbidden." };

  const workOrderId = String(body.workOrderId ?? "").trim();
  if (!workOrderId) return { ok: false, status: 400, error: "Work order id required." };

  const access = await resolveVendorWorkOrderAccess(db, actor, workOrderId);
  if (!access.ok) return access;

  const { data: existing } = await db
    .from("work_order_bids")
    .select("id, status, amount_cents, materials_cents, proposed_time, note")
    .eq("work_order_id", workOrderId)
    .eq("vendor_user_id", actor.userId)
    .maybeSingle();
  if (existing && existing.status !== "submitted") {
    return { ok: false, status: 403, error: "This bid has already been resolved." };
  }

  let consultationVisitAt: string;
  if (body.mode === "manual") {
    const parsed = new Date(String(body.consultationVisitAt ?? ""));
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, status: 400, error: "Enter a valid consultation date/time." };
    }
    consultationVisitAt = parsed.toISOString();
  } else {
    const { data: otherConsultations } = await db
      .from("work_order_bids")
      .select("consultation_visit_at")
      .eq("vendor_user_id", actor.userId)
      .eq("status", "submitted")
      .not("consultation_visit_at", "is", null)
      .neq("work_order_id", workOrderId);
    const extraBusy = (otherConsultations ?? [])
      .map((r) => r.consultation_visit_at as string | null)
      .filter((iso): iso is string => Boolean(iso))
      .map((iso) => ({
        startIso: iso,
        endIso: new Date(new Date(iso).getTime() + CONSULTATION_VISIT_DURATION_MINUTES * 60_000).toISOString(),
      }));
    const { iso, reason } = await resolveVendorNextAvailableSlot(db, actor.userId, {
      durationMinutes: CONSULTATION_VISIT_DURATION_MINUTES,
      extraBusy,
      excludeWorkOrderId: workOrderId,
    });
    if (!iso) {
      return {
        ok: false,
        status: 400,
        error:
          reason === "no_availability"
            ? "Set your availability first, then try again."
            : "No open slot found in your availability.",
      };
    }
    consultationVisitAt = iso;
  }

  const note = String(body.note ?? existing?.note ?? "").trim().slice(0, 2000);

  const { data: vendorDirectoryRow } = await db
    .from("manager_vendor_records")
    .select("id")
    .eq("vendor_user_id", actor.userId)
    .eq("manager_user_id", access.access.managerUserId)
    .maybeSingle();

  const record = {
    work_order_id: workOrderId,
    vendor_user_id: actor.userId,
    vendor_directory_id: (vendorDirectoryRow?.id as string | undefined) ?? null,
    manager_user_id: access.access.managerUserId,
    quote_mode: "after_consultation" as const,
    consultation_visit_at: consultationVisitAt,
    amount_cents: existing?.amount_cents ?? null,
    materials_cents: existing?.materials_cents ?? 0,
    proposed_time: existing?.proposed_time ?? null,
    note: note || null,
    status: "submitted" as const,
    updated_at: new Date().toISOString(),
  };

  const { error } = await db
    .from("work_order_bids")
    .upsert(existing ? { id: existing.id, ...record } : record, { onConflict: "work_order_id,vendor_user_id" });
  if (error) return { ok: false, status: 500, error: error.message };

  track("work_order_consultation_scheduled", actor.userId, { work_order_id: workOrderId });
  return { ok: true, consultationVisitAt };
}

export type AcceptBidSuccess = {
  ok: true;
  workOrderId: string;
  vendorName: string;
  /** The accepted bid's immutable labor amount — the payout anchor. */
  amountCents: number;
  materialsCents: number;
  declinedCount: number;
};

/**
 * Manager accepts a vendor's bid: marks it accepted, declines every other
 * submitted bid on the work order, withdraws outstanding offers, patches the
 * work order's row_data (vendorId/vendorName/cost/biddingOpen false) directly,
 * and notifies the winner plus each declined vendor (best-effort). The bid's
 * amount_cents is never taken from the caller — the stored row is the anchor.
 */
export async function acceptWorkOrderBid(
  db: Db,
  actor: WorkOrderActor,
  body: { bidId?: string },
): Promise<AcceptBidSuccess | WorkOrderActionFailure> {
  if (!actor.admin && actor.role !== "manager" && actor.role !== "pro") {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const bidId = String(body.bidId ?? "").trim();
  if (!bidId) return { ok: false, status: 400, error: "Bid id required." };

  const { data: bid } = await db.from("work_order_bids").select("*").eq("id", bidId).maybeSingle();
  if (!bid) return { ok: false, status: 404, error: "Bid not found." };
  const record = bid as BidRecord;
  if (!actor.admin && record.manager_user_id !== actor.userId) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  if (record.status !== "submitted") {
    return { ok: false, status: 400, error: "This bid has already been resolved." };
  }
  if (record.amount_cents == null) {
    return {
      ok: false,
      status: 400,
      error: "This vendor hasn't priced the job yet — it's still pending their consultation.",
    };
  }

  const now = new Date().toISOString();
  // The `record.status !== "submitted"` check above is an in-memory read of a
  // row fetched earlier, so on its own it does not stop two near-simultaneous
  // accepts from both landing. That matters more than a duplicate row: every
  // payout-anchor read (`payoutVendorForWorkOrder`,
  // `approveAndPayWorkOrder`) resolves the accepted bid with `.maybeSingle()`,
  // which ERRORS on two rows and yields null — and the payout then falls back to
  // `amountCents` from the REQUEST BODY, defeating the immutable-anchor rule.
  //
  // Re-asserting `status = 'submitted'` in the WHERE clause makes the transition
  // atomic: the loser matches zero rows and is refused. `setVendorPriceForWorkOrder`
  // already guards its own update the same way.
  const { data: acceptedRows, error: acceptError } = await db
    .from("work_order_bids")
    .update({ status: "accepted", updated_at: now })
    .eq("id", bidId)
    .eq("status", "submitted")
    .select("id");
  if (acceptError) return { ok: false, status: 500, error: acceptError.message };
  if (!acceptedRows || acceptedRows.length === 0) {
    return { ok: false, status: 400, error: "This bid has already been resolved." };
  }

  const { data: otherBids } = await db
    .from("work_order_bids")
    .select("*")
    .eq("work_order_id", record.work_order_id)
    .neq("id", bidId)
    .eq("status", "submitted");
  const declined = (otherBids ?? []) as BidRecord[];
  if (declined.length > 0) {
    await db
      .from("work_order_bids")
      .update({ status: "declined", updated_at: now })
      .in("id", declined.map((b) => b.id));
  }

  // Once a vendor is assigned, no other offered vendor should keep seeing this work
  // order in their portal (same "loses read access on reassignment" behavior as the
  // single-vendor Phase 2 flow) — withdraw every offer on this work order.
  await db
    .from("work_order_vendor_offers")
    .update({ status: "withdrawn", updated_at: now })
    .eq("work_order_id", record.work_order_id)
    .eq("status", "sent");

  const { data: workOrder } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, resident_email, property_id, assigned_property_id, row_data")
    .eq("id", record.work_order_id)
    .maybeSingle();

  const vendors = await vendorNamesById(db, [record.vendor_directory_id ?? "", ...declined.map((b) => b.vendor_directory_id ?? "")]);
  const winningVendor = record.vendor_directory_id ? vendors.get(record.vendor_directory_id) : undefined;
  let vendorName = winningVendor?.name || "";

  if (workOrder) {
    const rowData = (workOrder.row_data ?? {}) as DemoManagerWorkOrderRow;
    const totalCents = record.amount_cents + record.materials_cents;
    const nextRowData: DemoManagerWorkOrderRow = {
      ...rowData,
      vendorId: record.vendor_directory_id ?? undefined,
      vendorName: winningVendor?.name || rowData.vendorName,
      vendorAssignedAt: now,
      selfAssigned: false,
      cost: `$${(totalCents / 100).toFixed(2)}`,
      vendorCostCents: record.amount_cents,
      materialsCostCents: record.materials_cents,
      biddingOpen: false,
      biddingResolvedAt: now,
    };
    await db
      .from("portal_work_order_records")
      .update({ vendor_user_id: record.vendor_user_id, row_data: nextRowData, updated_at: now })
      .eq("id", record.work_order_id);

    const propertyLabel = rowData.propertyName || "";
    const unit = rowData.unit || "";
    const workOrderTitle = rowData.title || "";
    vendorName = winningVendor?.name || rowData.vendorName || "";

    if (winningVendor?.email?.includes("@")) {
      const { subject, body: messageBody } = buildVendorBidAcceptedEmail({
        vendorName: winningVendor.name,
        workOrderTitle,
        propertyLabel,
        unit,
      });
      // Best-effort notification: the bid + work-order reassignment above have already
      // committed, so a delivery failure here must not surface as an "accept failed" error.
      await deliverPortalInboxMessage(db, {
        senderUserId: actor.userId,
        senderEmail: actor.email,
        fromName: actor.fullName || "PropLane Portal",
        subject,
        text: messageBody,
        toUserIds: [record.vendor_user_id],
        deliverToPortalInbox: true,
        deliverViaEmail: false,
        deliverViaSms: false,
      }).catch(() => undefined);
    }

    for (const other of declined) {
      const otherVendor = other.vendor_directory_id ? vendors.get(other.vendor_directory_id) : undefined;
      if (!otherVendor) continue;
      const { subject, body: messageBody } = buildVendorBidDeclinedEmail({
        vendorName: otherVendor.name,
        workOrderTitle,
        propertyLabel,
        unit,
      });
      await deliverPortalInboxMessage(db, {
        senderUserId: actor.userId,
        senderEmail: actor.email,
        fromName: actor.fullName || "PropLane Portal",
        subject,
        text: messageBody,
        toUserIds: [other.vendor_user_id],
        deliverToPortalInbox: true,
        deliverViaEmail: false,
        deliverViaSms: false,
      }).catch(() => undefined);
    }
  }

  track("work_order_bid_accepted", actor.userId, { work_order_id: record.work_order_id });
  return {
    ok: true,
    workOrderId: record.work_order_id,
    vendorName,
    amountCents: record.amount_cents,
    materialsCents: record.materials_cents,
    declinedCount: declined.length,
  };
}

/** Vendor sets labor + materials on a scheduled work order before marking done.
 * Updates the work order row the manager uses for outgoing vendor payment.
 * Refuses (409) once the vendor's bid has been accepted — the accepted
 * amount_cents is the immutable payout anchor and must never be overwritten. */
export async function setVendorPriceForWorkOrder(
  db: Db,
  actor: WorkOrderActor,
  body: { workOrderId?: string; amountCents?: number; materialsCents?: number },
): Promise<{ ok: true; workOrder: DemoManagerWorkOrderRow } | WorkOrderActionFailure> {
  if (!actor.admin && actor.role !== "vendor") {
    return { ok: false, status: 403, error: "Forbidden." };
  }

  const workOrderId = String(body.workOrderId ?? "").trim();
  const amountCents = Math.round(Number(body.amountCents));
  const materialsCents = body.materialsCents === undefined ? 0 : Math.round(Number(body.materialsCents));

  if (!workOrderId) return { ok: false, status: 400, error: "Work order id required." };
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { ok: false, status: 400, error: "Enter a valid labor cost." };
  }
  if (!Number.isFinite(materialsCents) || materialsCents < 0) {
    return { ok: false, status: 400, error: "Enter a valid equipment/materials cost." };
  }

  const { data: workOrder } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, vendor_user_id, row_data")
    .eq("id", workOrderId)
    .maybeSingle();
  if (!workOrder) return { ok: false, status: 403, error: "Forbidden." };
  if (!actor.admin && workOrder.vendor_user_id !== actor.userId) {
    return { ok: false, status: 403, error: "Forbidden." };
  }

  const rowData = (workOrder.row_data ?? {}) as DemoManagerWorkOrderRow;
  if (rowData.bucket !== "scheduled") {
    return { ok: false, status: 400, error: "Price can only be set on scheduled services." };
  }
  if (rowData.automationStatus) {
    return { ok: false, status: 400, error: "This service has already been marked done." };
  }

  const vendorUserId = String(workOrder.vendor_user_id ?? actor.userId);
  const { data: bid } = await db
    .from("work_order_bids")
    .select("id, status")
    .eq("work_order_id", workOrderId)
    .eq("vendor_user_id", vendorUserId)
    .maybeSingle();
  if (bid && bid.status === "accepted") {
    return {
      ok: false,
      status: 409,
      error: "This bid was already accepted by the manager. Its price is locked and can't be changed here.",
    };
  }

  const totalCents = amountCents + materialsCents;
  const now = new Date().toISOString();
  const nextRowData: DemoManagerWorkOrderRow = {
    ...rowData,
    vendorCostCents: amountCents,
    materialsCostCents: materialsCents,
    cost: `$${(totalCents / 100).toFixed(2)}`,
  };

  const { error } = await db
    .from("portal_work_order_records")
    .update({ row_data: nextRowData, updated_at: now })
    .eq("id", workOrderId);
  if (error) return { ok: false, status: 500, error: error.message };

  if (bid && bid.status === "submitted") {
    // Re-check status in the WHERE clause (not just the earlier in-memory read) so a
    // manager's concurrent accept between the SELECT above and this UPDATE can't have
    // its accepted amount silently overwritten by this stale-read vendor request.
    await db
      .from("work_order_bids")
      .update({
        amount_cents: amountCents,
        materials_cents: materialsCents,
        updated_at: now,
      })
      .eq("id", bid.id)
      .eq("status", "submitted");
  }

  track("work_order_vendor_price_set", actor.userId, { work_order_id: workOrderId });
  return { ok: true, workOrder: nextRowData };
}

/** Vendor's one-tap "job done" signal — sets automationStatus only, never touches
 * bucket/status. The manager still owns the completion + expense-logging transition
 * via approve-pay. */
export async function markWorkOrderDoneByVendor(
  db: Db,
  actor: WorkOrderActor,
  body: { workOrderId?: string; note?: string },
): Promise<{ ok: true; workOrder: DemoManagerWorkOrderRow } | WorkOrderActionFailure> {
  if (!actor.admin && actor.role !== "vendor") {
    return { ok: false, status: 403, error: "Forbidden." };
  }

  const workOrderId = String(body.workOrderId ?? "").trim();
  if (!workOrderId) return { ok: false, status: 400, error: "Work order id required." };
  const note = String(body.note ?? "").trim().slice(0, 2000);

  const { data: workOrder } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, vendor_user_id, row_data")
    .eq("id", workOrderId)
    .maybeSingle();
  if (!workOrder) return { ok: false, status: 403, error: "Forbidden." };
  if (!actor.admin && workOrder.vendor_user_id !== actor.userId) {
    return { ok: false, status: 403, error: "Forbidden." };
  }

  const rowData = (workOrder.row_data ?? {}) as DemoManagerWorkOrderRow;
  if (rowData.bucket !== "scheduled") {
    return { ok: false, status: 400, error: "This service isn't ready to be marked done." };
  }
  if (rowData.automationStatus) {
    return { ok: false, status: 400, error: "This service has already been marked done." };
  }

  const now = new Date().toISOString();
  const nextRowData: DemoManagerWorkOrderRow = {
    ...rowData,
    automationStatus: "vendor_marked_done",
    vendorMarkedDoneAt: now,
    vendorMarkedDoneNote: note || undefined,
    paymentReference: rowData.paymentReference?.trim() || generateWorkOrderPaymentReference(workOrderId),
  };

  const { error } = await db
    .from("portal_work_order_records")
    .update({ row_data: nextRowData, updated_at: now })
    .eq("id", workOrderId);
  if (error) return { ok: false, status: 500, error: error.message };

  await deliverPortalInboxMessage(db, {
    senderUserId: actor.userId,
    senderEmail: actor.email,
    fromName: actor.fullName || "PropLane Portal",
    subject: `${rowData.title || "Service"} marked done — approval needed`,
    text: `${actor.fullName || "Your vendor"} marked "${rowData.title || "the service"}"${
      rowData.propertyName ? ` at ${rowData.propertyName}` : ""
    } as done.${note ? ` Note: ${note}` : ""} Review and approve payment in Work Orders.`,
    toUserIds: [workOrder.manager_user_id],
    deliverToPortalInbox: true,
    deliverViaEmail: false,
    deliverViaSms: false,
  }).catch(() => undefined);

  track("work_order_vendor_marked_done", actor.userId, { work_order_id: workOrderId });
  return { ok: true, workOrder: nextRowData };
}
