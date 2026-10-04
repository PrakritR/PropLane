/**
 * Shared work-order bid logic (estimate / estimate visit / bid / approve /
 * set price / mark done), extracted from the API routes so the agent tool layer
 * calls the exact same code path as the manager/vendor UI — one implementation,
 * not two. Functions return plain results ({ ok } | { ok:false, status, error });
 * the routes map them onto NextResponse, the tools onto ExecuteResult.
 *
 * ESTIMATE vs BID (docs/agents/vendor-portal.md): `estimate_cents` is a rough price that can never
 * be approved and never becomes a payment; only a row with `amount_cents` AND `bid_submitted_at`
 * (a submitted bid) can be approved. An estimate visit may carry a fee the manager pays once
 * `estimate_visit_done_at` is set - as its own vendor invoice, never inside the job payout.
 *
 * Invariant carried over from the routes: an accepted bid's amount_cents is the
 * immutable payout anchor. setVendorPriceForWorkOrder refuses (409) to touch an
 * accepted bid, and its bid UPDATE re-checks status in the WHERE clause so a
 * concurrent accept can't be overwritten by a stale read.
 */
import { track } from "@/lib/analytics/posthog";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { workOrderEvent } from "@/lib/work-order-events.server";
import { fillSiblingOffers } from "@/lib/work-order-offer-expiry.server";
import { requestResidentConfirmation } from "@/lib/work-order-resident-confirmation.server";
import { resolvePropertyScopedManagerRecipientIds } from "@/lib/co-manager-notification-recipients.server";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveVendorNextAvailableSlot } from "@/lib/vendor-availability-server";
import { buildVendorBidDeclinedEmail } from "@/lib/vendor-visit-email";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { stampSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";
import { rateLimit } from "@/lib/rate-limit";
import { ensureSubmittedVendorInvoiceForMarkedDone } from "@/lib/work-order-vendor-invoice.server";
import { bidCanBeApproved } from "@/lib/work-order-bid-approval";
import { parseVisitFeeCents } from "@/lib/work-order-visit-fee";
import { ensureVisitFeeInvoice } from "@/lib/work-order-visit-fee-invoice.server";
import { safeFormatDateTime } from "@/lib/pacific-time";

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
  estimate_cents: number | null;
  estimate_given_at: string | null;
  bid_submitted_at: string | null;
  estimate_visit_fee_cents: number;
  estimate_visit_done_at: string | null;
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

/**
 * How this vendor reached the work order — the vendor is the currently
 * assigned vendor, or the manager specifically offered them the job.
 */
export type WorkOrderAccessKind = "assigned" | "offered";

type WorkOrderAccess = {
  managerUserId: string;
  rowData: DemoManagerWorkOrderRow;
  accessKind: WorkOrderAccessKind;
};

/** A vendor may act on a work order if they're the currently assigned vendor, or if the
 * manager sent them a consultation/quote offer for it — while bidding is open, or while
 * a post-consultation price is still pending on their placeholder bid. `allow` narrows
 * which of those access kinds the CALLER is willing to accept; the default is both. */
async function resolveVendorWorkOrderAccess(
  db: Db,
  actor: WorkOrderActor,
  workOrderId: string,
  opts: { allow?: readonly WorkOrderAccessKind[] } = {},
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

  const accessKind: WorkOrderAccessKind = isAssignedVendor ? "assigned" : "offered";
  const allow = opts.allow ?? (["assigned", "offered"] as const);
  if (!allow.includes(accessKind)) {
    return { ok: false, status: 403, error: "Forbidden." };
  }

  const rowData = (workOrder.row_data ?? {}) as DemoManagerWorkOrderRow;
  if (!rowData.biddingOpen) {
    const { data: pendingBid } = await db
      .from("work_order_bids")
      .select("quote_mode, amount_cents, consultation_visit_at, estimate_cents, status")
      .eq("work_order_id", workOrderId)
      .eq("vendor_user_id", actor.userId)
      .maybeSingle();
    // A vendor who already gave an estimate or booked a visit may still answer with a bid
    // even if the manager has since closed the general bidding window.
    const pricingPending =
      pendingBid?.status === "submitted" &&
      pendingBid.amount_cents == null &&
      Boolean(pendingBid.consultation_visit_at || pendingBid.estimate_cents != null);
    if (!pricingPending) {
      return { ok: false, status: 400, error: "Bidding is not open for this service." };
    }
  }
  return { ok: true, access: { managerUserId: workOrder.manager_user_id as string, rowData, accessKind } };
}

/**
 * Resolve — or create — the `manager_vendor_records` row linking this vendor
 * to this manager. Called ONLY from `acceptWorkOrderBid`, as a defensive
 * fallback for the (normally already-present) directory row an invited/offered
 * vendor's offer targets. Built ONLY from the vendor's OWN public business
 * profile / account — never from the work order's private resident/property
 * fields — mirroring `POST /api/manager/vendor-directory/add`'s directory-linking shape.
 */
async function ensureVendorDirectoryIdForManager(db: Db, vendorUserId: string, managerUserId: string): Promise<string | null> {
  const { data: existing } = await db
    .from("manager_vendor_records")
    .select("id")
    .eq("vendor_user_id", vendorUserId)
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const [{ data: profile }, { data: biz }] = await Promise.all([
    db.from("profiles").select("full_name, email, phone").eq("id", vendorUserId).maybeSingle(),
    db.from("vendor_business_profiles").select("business_name, work_email, work_phone, trades").eq("user_id", vendorUserId).maybeSingle(),
  ]);
  const trades = Array.isArray(biz?.trades) ? (biz?.trades as string[]) : [];
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const row = {
    id,
    managerUserId,
    name: (biz?.business_name as string | null | undefined)?.trim() || (profile?.full_name as string | null | undefined)?.trim() || "Vendor",
    trade: trades[0] ?? "",
    trades: trades.length ? trades : undefined,
    phone: (biz?.work_phone as string | null | undefined)?.trim() || (profile?.phone as string | null | undefined)?.trim() || "",
    email: (biz?.work_email as string | null | undefined)?.trim() || (profile?.email as string | null | undefined)?.trim() || "",
    notes: "",
    active: true,
    catalogId: `vendor-bid-${vendorUserId}`,
    vendorUserId,
    createdAt: now,
    updatedAt: now,
  };
  const { error } = await db
    .from("manager_vendor_records")
    .insert({ id, manager_user_id: managerUserId, vendor_user_id: vendorUserId, row_data: row, updated_at: now });
  if (error) return null;
  return id;
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

  // Cross-workspace bid submission is spammable (any vendor, any open listing,
  // any workspace) in a way an invited/offered bid never was — throttle per
  // vendor regardless of path.
  const limited = await rateLimit(`work-order-bid-submit:${actor.userId}`, 20, 60 * 60 * 1000);
  if (!limited.ok) {
    return { ok: false, status: 429, error: "Too many bids submitted — try again in a bit." };
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
    bid_submitted_at: new Date().toISOString(),
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

  // "Can't do it" after a paid estimate visit must keep the row: the visit fee invoice is verified
  // against it. Everything else is simply removed so the manager is not left waiting.
  const { data: current } = await db
    .from("work_order_bids")
    .select("id, status, estimate_visit_done_at, estimate_visit_fee_cents")
    .eq("work_order_id", workOrderId)
    .eq("vendor_user_id", actor.userId)
    .maybeSingle();
  if (!current || current.status !== "submitted") {
    return { ok: false, status: 409, error: "This bid was already accepted or declined." };
  }
  const feeOwed = Boolean(current.estimate_visit_done_at) && Number(current.estimate_visit_fee_cents) > 0;
  if (feeOwed) {
    const { data: declined, error: declineError } = await db
      .from("work_order_bids")
      .update({ status: "declined", updated_at: new Date().toISOString() })
      .eq("id", current.id)
      .eq("status", "submitted")
      .select("id")
      .maybeSingle();
    if (declineError) return { ok: false, status: 500, error: declineError.message };
    if (!declined) return { ok: false, status: 409, error: "This bid was already accepted or declined." };
    return { ok: true };
  }
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

/** Vendor books (or manually sets) an ESTIMATE VISIT and saves a pricing-pending placeholder row,
 * optionally with a visit fee the manager pays once the visit happened. The vendor submits a bid
 * afterward via submitWorkOrderBid, which preserves quote_mode/consultation_visit_at and the fee.
 * The fee is fixed once the visit is marked done (the fee invoice is built from the stored value). */
export async function scheduleWorkOrderConsultation(
  db: Db,
  actor: WorkOrderActor,
  body: { workOrderId?: string; mode?: "auto" | "manual"; consultationVisitAt?: string; note?: string; visitFeeCents?: number },
): Promise<{ ok: true; consultationVisitAt: string } | WorkOrderActionFailure> {
  if (actor.role !== "vendor") return { ok: false, status: 403, error: "Forbidden." };

  const workOrderId = String(body.workOrderId ?? "").trim();
  if (!workOrderId) return { ok: false, status: 400, error: "Work order id required." };

  const access = await resolveVendorWorkOrderAccess(db, actor, workOrderId);
  if (!access.ok) return access;

  const { data: existing } = await db
    .from("work_order_bids")
    .select("id, status, amount_cents, materials_cents, proposed_time, note, estimate_visit_done_at, estimate_visit_fee_cents")
    .eq("work_order_id", workOrderId)
    .eq("vendor_user_id", actor.userId)
    .maybeSingle();
  if (existing && existing.status !== "submitted") {
    return { ok: false, status: 403, error: "This bid has already been resolved." };
  }
  if (existing?.estimate_visit_done_at) {
    return { ok: false, status: 409, error: "The estimate visit already happened." };
  }
  const visitFeeCents = body.visitFeeCents === undefined ? Number(existing?.estimate_visit_fee_cents ?? 0) : parseVisitFeeCents(body.visitFeeCents);
  if (visitFeeCents === null || !Number.isFinite(visitFeeCents)) {
    return { ok: false, status: 400, error: "Enter a valid visit fee." };
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
    estimate_visit_fee_cents: visitFeeCents,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    // Compare-and-swap on status: a manager approving or removing between the read and here wins.
    const { data: updated, error } = await db
      .from("work_order_bids")
      .update(record)
      .eq("id", existing.id)
      .eq("status", "submitted")
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, status: 500, error: error.message };
    if (!updated) return { ok: false, status: 409, error: "This request changed before your visit saved." };
  } else {
    const { error } = await db.from("work_order_bids").insert(record);
    if (error) return { ok: false, status: 500, error: error.message };
  }

  track("work_order_consultation_scheduled", actor.userId, { work_order_id: workOrderId });
  return { ok: true, consultationVisitAt };
}

/** Sanity ceiling on a single estimate or bid figure ($1,000,000). */
const MAX_ESTIMATE_CENTS = 100_000_000;

/**
 * Vendor gives a rough ESTIMATE ("about $180") before seeing the job. It is stored apart from the
 * bid, can never be approved, and never becomes a payment. The vendor may follow it with a bid.
 */
export async function giveWorkOrderEstimate(
  db: Db,
  actor: WorkOrderActor,
  body: { workOrderId?: string; estimateCents?: number; note?: string },
): Promise<{ ok: true } | WorkOrderActionFailure> {
  if (actor.role !== "vendor") return { ok: false, status: 403, error: "Forbidden." };

  const workOrderId = String(body.workOrderId ?? "").trim();
  const estimateCents = Math.round(Number(body.estimateCents));
  const note = String(body.note ?? "").trim().slice(0, 2000);
  if (!workOrderId) return { ok: false, status: 400, error: "Work order id required." };
  if (!Number.isFinite(estimateCents) || estimateCents <= 0 || estimateCents > MAX_ESTIMATE_CENTS) {
    return { ok: false, status: 400, error: "Enter a valid estimate." };
  }

  const limited = await rateLimit(`work-order-estimate:${actor.userId}`, 40, 60 * 60 * 1000);
  if (!limited.ok) return { ok: false, status: 429, error: "Too many requests - try again in a bit." };

  const access = await resolveVendorWorkOrderAccess(db, actor, workOrderId);
  if (!access.ok) return access;

  const { data: existing } = await db
    .from("work_order_bids")
    .select("id, status, bid_submitted_at")
    .eq("work_order_id", workOrderId)
    .eq("vendor_user_id", actor.userId)
    .maybeSingle();
  if (existing && existing.status !== "submitted") {
    return { ok: false, status: 403, error: "This bid has already been resolved." };
  }
  if (existing?.bid_submitted_at) {
    return { ok: false, status: 409, error: "You already submitted a bid - update it instead." };
  }

  const now = new Date().toISOString();
  if (existing) {
    const { data: updated, error } = await db
      .from("work_order_bids")
      .update({ estimate_cents: estimateCents, estimate_given_at: now, ...(note ? { note } : {}), updated_at: now })
      .eq("id", existing.id)
      .eq("status", "submitted")
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, status: 500, error: error.message };
    if (!updated) return { ok: false, status: 409, error: "This request changed before your estimate saved." };
  } else {
    const { data: vendorDirectoryRow } = await db
      .from("manager_vendor_records")
      .select("id")
      .eq("vendor_user_id", actor.userId)
      .eq("manager_user_id", access.access.managerUserId)
      .maybeSingle();
    const { error } = await db.from("work_order_bids").insert({
      work_order_id: workOrderId,
      vendor_user_id: actor.userId,
      vendor_directory_id: (vendorDirectoryRow?.id as string | undefined) ?? null,
      manager_user_id: access.access.managerUserId,
      quote_mode: "upfront",
      consultation_visit_at: null,
      amount_cents: null,
      materials_cents: 0,
      proposed_time: null,
      note: note || null,
      status: "submitted",
      estimate_cents: estimateCents,
      estimate_given_at: now,
      updated_at: now,
    });
    if (error) return { ok: false, status: 500, error: error.message };
  }

  track("work_order_estimate_given", actor.userId, { work_order_id: workOrderId });
  return { ok: true };
}

/**
 * Vendor marks the estimate visit as having happened. From here the visit fee (if any) is owed:
 * it becomes its own vendor invoice - one per bid, built from the stored fee, never a body amount -
 * which the manager pays through the normal Approve & pay rail. Safe to retry.
 */
export async function completeEstimateVisit(
  db: Db,
  actor: WorkOrderActor,
  body: { workOrderId?: string },
): Promise<{ ok: true; feeCents: number } | WorkOrderActionFailure> {
  if (actor.role !== "vendor") return { ok: false, status: 403, error: "Forbidden." };

  const workOrderId = String(body.workOrderId ?? "").trim();
  if (!workOrderId) return { ok: false, status: 400, error: "Work order id required." };

  const access = await resolveVendorWorkOrderAccess(db, actor, workOrderId);
  if (!access.ok) return access;

  const { data: bid } = await db
    .from("work_order_bids")
    .select("id, status, manager_user_id, consultation_visit_at, estimate_visit_done_at, estimate_visit_fee_cents")
    .eq("work_order_id", workOrderId)
    .eq("vendor_user_id", actor.userId)
    .maybeSingle();
  if (!bid || !bid.consultation_visit_at) {
    return { ok: false, status: 422, error: "Book an estimate visit first." };
  }
  if (bid.status !== "submitted") {
    return { ok: false, status: 403, error: "This bid has already been resolved." };
  }
  if (bid.manager_user_id !== access.access.managerUserId) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  if (!bid.estimate_visit_done_at && new Date(String(bid.consultation_visit_at)).getTime() > Date.now()) {
    return { ok: false, status: 422, error: "The estimate visit hasn't happened yet." };
  }

  if (!bid.estimate_visit_done_at) {
    const now = new Date().toISOString();
    const { error } = await db
      .from("work_order_bids")
      .update({ estimate_visit_done_at: now, updated_at: now })
      .eq("id", bid.id)
      .eq("status", "submitted")
      .is("estimate_visit_done_at", null);
    if (error) return { ok: false, status: 500, error: error.message };
  }

  const feeCents = Number(bid.estimate_visit_fee_cents) || 0;
  if (feeCents > 0) {
    try {
      await ensureVisitFeeInvoice(db as never, {
        bidId: String(bid.id),
        workOrderId,
        managerUserId: access.access.managerUserId,
        vendorUserId: actor.userId,
        feeCents,
        title: access.access.rowData.title || "Service",
        reference: access.access.rowData.reference,
      });
    } catch (e) {
      return { ok: false, status: 500, error: e instanceof Error ? e.message : "Could not file the visit fee." };
    }
  }

  track("work_order_estimate_visit_done", actor.userId, { work_order_id: workOrderId });
  return { ok: true, feeCents };
}

/**
 * Manager removes one vendor from the request. The vendor's open offer is withdrawn and their
 * unresolved row removed - except when an estimate-visit fee is owed, where the row is kept
 * (declined) because the fee invoice is verified against it. An approved bid is never removable.
 */
export async function removeVendorRequest(
  db: Db,
  actor: WorkOrderActor,
  body: { workOrderId?: string; bidId?: string; offerId?: string },
): Promise<{ ok: true } | WorkOrderActionFailure> {
  if (!actor.admin && actor.role !== "manager" && actor.role !== "pro") {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const workOrderId = String(body.workOrderId ?? "").trim();
  const bidId = String(body.bidId ?? "").trim();
  const offerId = String(body.offerId ?? "").trim();
  if (!workOrderId || (!bidId && !offerId)) return { ok: false, status: 400, error: "Pick a vendor to remove." };

  const { data: workOrder } = await db
    .from("portal_work_order_records")
    .select("manager_user_id")
    .eq("id", workOrderId)
    .maybeSingle();
  if (!workOrder || (!actor.admin && workOrder.manager_user_id !== actor.userId)) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const now = new Date().toISOString();

  let vendorDirectoryId: string | null = null;
  if (bidId) {
    const { data: bid } = await db
      .from("work_order_bids")
      .select("id, work_order_id, status, vendor_directory_id, estimate_visit_done_at, estimate_visit_fee_cents")
      .eq("id", bidId)
      .maybeSingle();
    if (!bid || bid.work_order_id !== workOrderId) return { ok: false, status: 404, error: "Request not found." };
    if (bid.status === "accepted") {
      return { ok: false, status: 409, error: "An approved bid can't be removed." };
    }
    vendorDirectoryId = (bid.vendor_directory_id as string | null) ?? null;
    if (bid.status === "submitted") {
      const feeOwed = Boolean(bid.estimate_visit_done_at) && Number(bid.estimate_visit_fee_cents) > 0;
      const { error } = feeOwed
        ? await db.from("work_order_bids").update({ status: "declined", updated_at: now }).eq("id", bidId).eq("status", "submitted")
        : await db.from("work_order_bids").delete().eq("id", bidId).eq("status", "submitted");
      if (error) return { ok: false, status: 500, error: error.message };
    }
  }

  let offerQuery = db
    .from("work_order_vendor_offers")
    .update({ status: "withdrawn", updated_at: now })
    .eq("work_order_id", workOrderId)
    .eq("status", "sent");
  if (offerId) offerQuery = offerQuery.eq("id", offerId);
  else if (vendorDirectoryId) offerQuery = offerQuery.eq("vendor_directory_id", vendorDirectoryId);
  else return { ok: true };
  const { error: offerError } = await offerQuery;
  if (offerError) return { ok: false, status: 500, error: offerError.message };
  return { ok: true };
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
 * Manager APPROVES a vendor's submitted bid: marks it accepted, declines every other
 * submitted bid on the work order, withdraws outstanding offers, patches the
 * work order's row_data (vendorId/vendorName/cost/biddingOpen false, and the bid's proposed time
 * booked as the scheduled visit) directly, and notifies the winner plus each declined vendor
 * (best-effort). The bid's amount_cents is never taken from the caller - the stored row is the
 * anchor - and ownership is re-derived from the work order row, not from the request.
 *
 * Only a SUBMITTED BID qualifies (`bidCanBeApproved`): an estimate or a booked visit alone is
 * refused with a 422, so an estimate can never become a payment.
 */
export async function acceptWorkOrderBid(
  db: Db,
  actor: WorkOrderActor,
  body: { bidId?: string; workOrderId?: string },
): Promise<AcceptBidSuccess | WorkOrderActionFailure> {
  if (!actor.admin && actor.role !== "manager" && actor.role !== "pro") {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const bidId = String(body.bidId ?? "").trim();
  if (!bidId) return { ok: false, status: 400, error: "Bid id required." };

  const { data: bid } = await db.from("work_order_bids").select("*").eq("id", bidId).maybeSingle();
  if (!bid) return { ok: false, status: 404, error: "Bid not found." };
  const record = bid as BidRecord;
  // The bid must belong to the service the caller named, and that service must belong to the
  // caller's workspace - re-derived from the work order row, never from the bid's denormalized copy alone.
  const claimedWorkOrderId = String(body.workOrderId ?? "").trim();
  if (claimedWorkOrderId && claimedWorkOrderId !== record.work_order_id) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const { data: ownerRow } = await db
    .from("portal_work_order_records")
    .select("manager_user_id")
    .eq("id", record.work_order_id)
    .maybeSingle();
  if (!ownerRow) return { ok: false, status: 403, error: "Forbidden." };
  if (!actor.admin && (ownerRow.manager_user_id !== actor.userId || record.manager_user_id !== actor.userId)) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  if (record.status !== "submitted") {
    return { ok: false, status: 400, error: "This bid has already been resolved." };
  }
  if (
    !bidCanBeApproved({
      status: record.status,
      amountCents: record.amount_cents,
      bidSubmittedAt: record.bid_submitted_at ?? null,
    })
  ) {
    return {
      ok: false,
      status: 422,
      error: "This vendor hasn't submitted a bid yet - an estimate can't be approved.",
    };
  }
  const approvedAmountCents = record.amount_cents as number;

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

  // Defensive fallback: create a directory row for the winning bidder if one
  // somehow doesn't already exist, then stamp it onto the bid so vendorNamesById
  // and the row_data assignment below resolve a real name/contact.
  if (!record.vendor_directory_id) {
    const createdDirectoryId = await ensureVendorDirectoryIdForManager(db, record.vendor_user_id, record.manager_user_id);
    if (createdDirectoryId) {
      record.vendor_directory_id = createdDirectoryId;
      await db.from("work_order_bids").update({ vendor_directory_id: createdDirectoryId }).eq("id", bidId);
    }
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

  const { data: workOrder } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, resident_email, property_id, assigned_property_id, row_data")
    .eq("id", record.work_order_id)
    .maybeSingle();

  // Once a vendor is assigned, no other offered vendor should keep seeing this work
  // order in their portal (same "loses read access on reassignment" behavior as the
  // single-vendor Phase 2 flow). Offers still open are marked `filled` and those
  // vendors told once; vendors who actually bid get the richer declined-bid email
  // below, so they are excluded here rather than messaged twice.
  if (workOrder) {
    await fillSiblingOffers(db, {
      workOrderId: record.work_order_id,
      managerUserId: String(workOrder.manager_user_id),
      acceptedVendorDirectoryId: record.vendor_directory_id,
      acceptedVendorUserId: record.vendor_user_id,
      excludeVendorUserIds: declined.map((b) => b.vendor_user_id),
      row: (workOrder.row_data ?? {}) as DemoManagerWorkOrderRow,
      sender: { userId: actor.userId, email: actor.email, name: actor.fullName },
    }).catch(() => undefined);
  }
  await db
    .from("work_order_vendor_offers")
    .update({ status: "withdrawn", updated_at: now })
    .eq("work_order_id", record.work_order_id)
    .eq("status", "sent");

  const vendors = await vendorNamesById(db, [record.vendor_directory_id ?? "", ...declined.map((b) => b.vendor_directory_id ?? "")]);
  const winningVendor = record.vendor_directory_id ? vendors.get(record.vendor_directory_id) : undefined;
  let vendorName = winningVendor?.name || "";

  if (workOrder) {
    const rowData = (workOrder.row_data ?? {}) as DemoManagerWorkOrderRow;
    const totalCents = approvedAmountCents + record.materials_cents;
    const nextRowData: DemoManagerWorkOrderRow = {
      ...rowData,
      vendorId: record.vendor_directory_id ?? undefined,
      vendorName: winningVendor?.name || rowData.vendorName,
      vendorAssignedAt: now,
      // A fresh accept — including a re-offer's own eventual accept — is a
      // clean slate for the "vendor silent after accept" escalation.
      vendorSilentEscalatedAt: undefined,
      selfAssigned: false,
      cost: `$${(totalCents / 100).toFixed(2)}`,
      vendorCostCents: approvedAmountCents,
      materialsCostCents: record.materials_cents,
      biddingOpen: false,
      biddingResolvedAt: now,
      // The approved bid's proposed time is booked as the visit; either side can still move it.
      ...(record.proposed_time && rowData.bucket !== "completed"
        ? {
            bucket: "scheduled" as const,
            status: "Scheduled",
            scheduledAtIso: record.proposed_time,
            scheduled: safeFormatDateTime(record.proposed_time),
          }
        : {}),
    };
    await db
      .from("portal_work_order_records")
      .update({ vendor_user_id: record.vendor_user_id, row_data: stampSmsTestProvenance(nextRowData as unknown as Record<string, unknown>), updated_at: now })
      .eq("id", record.work_order_id);

    const propertyLabel = rowData.propertyName || "";
    const unit = rowData.unit || "";
    const workOrderTitle = rowData.title || "";
    vendorName = winningVendor?.name || rowData.vendorName || "";

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

    const managerRecipients = await resolvePropertyScopedManagerRecipientIds(db, {
      ownerManagerUserId: String(workOrder.manager_user_id),
      propertyId: String(workOrder.assigned_property_id ?? workOrder.property_id ?? "") || undefined,
      channel: "services",
    });
    await workOrderEvent(db, {
      eventId: `${record.work_order_id}:accepted:${bidId}`,
      event: "accepted",
      managerUserId: String(workOrder.manager_user_id),
      workOrderId: record.work_order_id,
      senderUserId: actor.userId,
      senderEmail: actor.email,
      senderName: actor.fullName,
      facts: {
        reference: rowData.reference || "Work order",
        propertyId: String(workOrder.assigned_property_id ?? workOrder.property_id ?? "") || undefined,
        title: workOrderTitle || "Work order",
        propertyLabel: propertyLabel || undefined,
        scheduledFor: record.proposed_time ?? undefined,
        vendorName: vendorName || undefined,
        amountCents: approvedAmountCents + record.materials_cents,
      },
      recipients: [
        { audience: "vendor", userId: record.vendor_user_id },
        ...(workOrder.resident_email ? [{ audience: "resident" as const, email: String(workOrder.resident_email) }] : []),
        ...managerRecipients.map((userId) => ({ audience: "manager" as const, userId })),
      ],
    }).catch(() => undefined);
  }

  track("work_order_bid_accepted", actor.userId, { work_order_id: record.work_order_id });
  return {
    ok: true,
    workOrderId: record.work_order_id,
    vendorName,
    amountCents: approvedAmountCents,
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
    .update({ row_data: stampSmsTestProvenance(nextRowData as unknown as Record<string, unknown>), updated_at: now })
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
  };

  const { error } = await db
    .from("portal_work_order_records")
    .update({ row_data: stampSmsTestProvenance(nextRowData as unknown as Record<string, unknown>), updated_at: now })
    .eq("id", workOrderId);
  if (error) return { ok: false, status: 500, error: error.message };

  // "Was this fixed?" — a signed link for the resident when the manager has the
  // step on. The stamp lives on the row so the answer can be matched back.
  const confirmation = await requestResidentConfirmation(db, workOrderId, String(workOrder.manager_user_id), nextRowData).catch(() => null);
  const finalRowData = confirmation?.rowData ?? nextRowData;

  await workOrderEvent(db, {
    eventId: `${workOrderId}:completed:${now}`,
    event: "completed",
    senderAudience: "vendor",
    managerUserId: String(workOrder.manager_user_id),
    workOrderId,
    senderUserId: actor.userId,
    senderEmail: actor.email,
    senderName: actor.fullName,
    facts: {
      reference: rowData.reference || "Work order",
      propertyId: rowData.assignedPropertyId || rowData.propertyId || undefined,
      title: rowData.title || "Work order",
      propertyLabel: rowData.propertyName || undefined,
      vendorName: actor.fullName || rowData.vendorName || undefined,
      confirmUrl: confirmation?.confirmUrl,
    },
    recipients: [
      { audience: "manager", userId: String(workOrder.manager_user_id) },
      ...(rowData.residentEmail ? [{ audience: "resident" as const, email: rowData.residentEmail }] : []),
    ],
  }).catch(() => undefined);

  try {
    await ensureSubmittedVendorInvoiceForMarkedDone(db, {
      workOrderId,
      managerUserId: String(workOrder.manager_user_id),
      vendorUserId: String(workOrder.vendor_user_id),
      row: finalRowData,
    });
  } catch (error) {
    console.error("Failed to create submitted vendor invoice for marked-done service", error);
  }

  track("work_order_vendor_marked_done", actor.userId, { work_order_id: workOrderId });
  return { ok: true, workOrder: finalRowData };
}

/** Same function, named for what the manager does with it. */
export const approveWorkOrderBid = acceptWorkOrderBid;
