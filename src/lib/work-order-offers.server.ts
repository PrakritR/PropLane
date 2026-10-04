/**
 * Shared "offer this work order to vendors for bids" logic, extracted from the
 * work-order-vendor-offers route so the agent tool layer runs the exact same
 * offer upsert + bid-offer email + inbox notification + biddingOpen transition
 * as the manager UI — no second notification path.
 */
import { track } from "@/lib/analytics/posthog";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { stampSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";
import { sendVendorNotification } from "@/lib/vendor-notification-delivery";
import { notifyWorkOrderEvent } from "@/lib/work-order-notification.server";
import { buildVendorBidOfferEmail } from "@/lib/vendor-visit-email";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderActionFailure, WorkOrderActor } from "@/lib/work-order-bids.server";
import { workOrderEvent } from "@/lib/work-order-events.server";
import { resolvePropertyScopedManagerRecipientIds } from "@/lib/co-manager-notification-recipients.server";
import { resolveServiceAutomationSettingsForRow } from "@/lib/service-automation-settings.server";
import { createSettingsScopeCache } from "@/lib/settings/scope-resolver.server";
import { offerExpiresAt } from "@/lib/service-automation-settings";
import {
  loadMarketplaceVendorUserIds,
  resolveWorkOrderPropertyZip,
  workOrderCategoryForMarketplace,
} from "@/lib/work-order-marketplace-match.server";
import { parseMoneyAmount } from "@/lib/parse-money";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

function expiresLabel(at: Date): string {
  return at.toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

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
async function ensureDirectoryVendorOnManagerRoster(
  db: Db,
  managerUserId: string,
  vendorUserId: string,
): Promise<string | null> {
  const { data: existing } = await db
    .from("manager_vendor_records")
    .select("id")
    .eq("manager_user_id", managerUserId)
    .eq("vendor_user_id", vendorUserId)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data: directoryRow } = await db
    .from("vendor_business_profiles")
    .select("business_name, work_email, work_phone, trades, directory_listed, onboarding_completed_at")
    .eq("user_id", vendorUserId)
    .maybeSingle();
  if (!directoryRow || directoryRow.directory_listed !== true || !directoryRow.onboarding_completed_at) {
    return null;
  }

  const trades = Array.isArray(directoryRow.trades) ? (directoryRow.trades as string[]) : [];
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const row = {
    id,
    managerUserId,
    name: (directoryRow.business_name as string | null)?.trim() || "PropLane vendor",
    trade: trades[0] ?? "",
    trades: trades.length ? trades : undefined,
    phone: (directoryRow.work_phone as string | null)?.trim() || "",
    email: (directoryRow.work_email as string | null)?.trim() || "",
    notes: "",
    active: true,
    catalogId: `self-serve-${vendorUserId}`,
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

export type SendWorkOrderVendorOffersBody = {
  workOrderId?: string;
  vendorIds?: string[];
  /**
   * A freshly filed resident service offered to the preferred vendor
   * (comms-safety-0929, D3): the vendor hears `vendor_new_service` instead of
   * the manager-sent `vendor_offered`, with a link to their Services.
   */
  newService?: boolean;
  marketplace?: {
    enabled?: boolean;
    trade?: string;
    radiusMi?: number;
    budget?: string;
    sharePhotos?: boolean;
    notes?: string;
  };
};

/**
 * How many directory vendors match this service's trade and radius, and how many of them one
 * send can actually reach. The two are different numbers — a send is capped at
 * `MAX_VENDORS_PER_SEND` — so both are returned rather than letting one stand for the other.
 */
export async function previewMarketplaceReach(
  db: Db,
  actor: WorkOrderActor,
  input: { workOrderId: string; trade: string; radiusMi: number },
): Promise<{ ok: true; count: number; contactable: number } | WorkOrderActionFailure> {
  if (!actor.admin && actor.role !== "manager" && actor.role !== "pro") {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const { data: workOrder } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, row_data")
    .eq("id", input.workOrderId)
    .maybeSingle();
  if (!workOrder || (!actor.admin && workOrder.manager_user_id !== actor.userId)) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const rowData = (workOrder.row_data ?? {}) as DemoManagerWorkOrderRow;
  const category = workOrderCategoryForMarketplace(rowData, input.trade);
  if (!category) return { ok: true, count: 0, contactable: 0 };
  const propertyZip = await resolveWorkOrderPropertyZip(db, rowData);
  if (!propertyZip) return { ok: true, count: 0, contactable: 0 };
  const userIds = await loadMarketplaceVendorUserIds(db, {
    propertyZip,
    publishRadiusMi: input.radiusMi,
    category,
  });
  return { ok: true, count: userIds.length, contactable: Math.min(userIds.length, MAX_VENDORS_PER_SEND) };
}

export async function sendWorkOrderVendorOffers(
  db: Db,
  actor: WorkOrderActor,
  body: SendWorkOrderVendorOffersBody,
): Promise<{ ok: true; sent: string[]; skipped: string[] } | WorkOrderActionFailure> {
  if (!actor.admin && actor.role !== "manager" && actor.role !== "pro") {
    return { ok: false, status: 403, error: "Forbidden." };
  }

  const workOrderId = String(body.workOrderId ?? "").trim();
  let vendorIds = [...new Set((Array.isArray(body.vendorIds) ? body.vendorIds : []).map((v) => String(v).trim()).filter(Boolean))];
  if (!workOrderId) return { ok: false, status: 400, error: "Work order id required." };

  const { data: workOrder } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, row_data")
    .eq("id", workOrderId)
    .maybeSingle();
  if (!workOrder || (!actor.admin && workOrder.manager_user_id !== actor.userId)) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const rowData = (workOrder.row_data ?? {}) as DemoManagerWorkOrderRow;

  // Re-opening bidding on a service that already has an approved bid would let a second bid be
  // approved on top of it, and two `accepted` rows break every payout-anchor read (they resolve
  // with `.maybeSingle()`, which errors on two rows and falls back to a caller-supplied amount).
  const { data: acceptedBid, error: acceptedBidError } = await db
    .from("work_order_bids")
    .select("id")
    .eq("work_order_id", workOrderId)
    .eq("status", "accepted")
    .limit(1);
  // Fail closed: a read that errored tells us nothing, and proceeding would re-open bidding on a
  // service that may already be awarded.
  if (acceptedBidError) return { ok: false, status: 500, error: acceptedBidError.message };
  if (acceptedBid && acceptedBid.length > 0) {
    return { ok: false, status: 409, error: "A bid is already approved on this service — remove the vendor first." };
  }

  const marketplace = body.marketplace;
  // Opt IN, never out. The broadcast fans an offer out to strangers matched by
  // trade and radius, so a caller that says nothing about the marketplace -
  // the assistant tool, any older client - sends only to the vendors the
  // manager actually named.
  const marketplaceEnabled = marketplace?.enabled === true;
  // Opt IN here too: a caller that says nothing about photos shares none with a vendor who has
  // only been offered the job. The manager's "Share photos" tick is what opens them.
  const sharePhotos = marketplace?.sharePhotos === true;
  const tradeLabel = (marketplace?.trade ?? rowData.category ?? "Maintenance").toString().trim();
  const radiusMi = Math.min(50, Math.max(1, Math.round(Number(marketplace?.radiusMi ?? 5))));
  let matchedCount = 0;

  if (marketplaceEnabled) {
    const category = workOrderCategoryForMarketplace(rowData, tradeLabel);
    const propertyZip = await resolveWorkOrderPropertyZip(db, rowData);
    if (category && propertyZip) {
      const marketplaceUserIds = await loadMarketplaceVendorUserIds(db, {
        propertyZip,
        publishRadiusMi: radiusMi,
        category,
      });
      matchedCount = marketplaceUserIds.length;
      const managerUserId = String(workOrder.manager_user_id);
      // Only the vendors this send can actually reach get a roster row: the cap
      // used to be applied AFTER the loop, so a match of 200 copied 200 vendors'
      // work email and phone into the manager's directory to contact 10.
      let room = Math.max(0, MAX_VENDORS_PER_SEND - new Set(vendorIds).size);
      for (const vendorUserId of marketplaceUserIds) {
        if (room <= 0) break;
        const directoryId = await ensureDirectoryVendorOnManagerRoster(db, managerUserId, vendorUserId);
        if (!directoryId || vendorIds.includes(directoryId)) continue;
        vendorIds.push(directoryId);
        room -= 1;
      }
    }
  }

  vendorIds = [...new Set(vendorIds)].slice(0, MAX_VENDORS_PER_SEND);
  if (vendorIds.length === 0) {
    return { ok: false, status: 400, error: "No vendors in range for this trade — widen the radius or add a roster vendor." };
  }

  const budgetRaw = marketplace?.budget?.trim();
  const budgetCents =
    budgetRaw && Number.isFinite(parseMoneyAmount(budgetRaw)) ? Math.round(parseMoneyAmount(budgetRaw) * 100) : null;

  const vendors = await vendorDirectoryRowsById(db, vendorIds);
  const sent: string[] = [];
  const skipped: string[] = [];
  // Offers expire on the manager's Services setting (a house with its own gets
  // it; otherwise workspace then account, phase C); a round sent now shares one deadline.
  const offerPropertyId = rowData.assignedPropertyId || rowData.propertyId || null;
  const serviceSettings = await resolveServiceAutomationSettingsForRow(db, createSettingsScopeCache(), String(workOrder.manager_user_id), offerPropertyId).catch(() => null);
  const expiresAt = serviceSettings ? offerExpiresAt(serviceSettings, new Date()) : null;

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
        expires_at: expiresAt ? expiresAt.toISOString() : null,
        updated_at: now,
      },
      { onConflict: "work_order_id,vendor_directory_id" },
    );
    if (offerError) {
      skipped.push(vendorId);
      continue;
    }
    sent.push(vendorId);

  }

  if (sent.length > 0) {
    const nextRowData: DemoManagerWorkOrderRow = {
      ...rowData,
      biddingOpen: true,
      biddingOpenedAt: rowData.biddingOpenedAt ?? new Date().toISOString(),
      offerExpiresAt: expiresAt ? expiresAt.toISOString() : undefined,
      offerSharePhotos: sharePhotos,
      marketplacePublish: marketplaceEnabled
        ? {
            trade: tradeLabel,
            radiusMi,
            budgetCents,
            matchedCount,
            sharePhotos,
            publishedAt: new Date().toISOString(),
          }
        : rowData.marketplacePublish,
    };
    await db
      .from("portal_work_order_records")
      .update({ row_data: stampSmsTestProvenance(nextRowData as unknown as Record<string, unknown>), updated_at: new Date().toISOString() })
      .eq("id", workOrderId);

    const offeredVendors = sent.map((id) => vendors.get(id)).filter((vendor): vendor is VendorDirectorySummary => Boolean(vendor));
    const managerRecipients = await resolvePropertyScopedManagerRecipientIds(db, {
      ownerManagerUserId: String(workOrder.manager_user_id),
      propertyId: rowData.assignedPropertyId || rowData.propertyId || undefined,
      channel: "services",
    });
    const newService = body.newService === true;
    await workOrderEvent(db, {
      eventId: `${workOrderId}:${newService ? "vendor_new_service" : "vendor_offered"}:${sent.slice().sort().join(",")}`,
      event: newService ? "vendor_new_service" : "vendor_offered",
      managerUserId: String(workOrder.manager_user_id),
      workOrderId,
      senderUserId: actor.userId,
      senderEmail: actor.email,
      senderName: actor.fullName,
      facts: {
        reference: rowData.reference || "Work order",
        title: rowData.title || "Work order",
        propertyLabel: rowData.propertyName || undefined,
        scheduledFor: rowData.scheduled || undefined,
        offerCount: sent.length,
        expiresLabel: expiresAt ? expiresLabel(expiresAt) : undefined,
        emergency: rowData.priority === "Emergency",
        ...(newService
          ? {
              propertyLabel: [rowData.propertyName, rowData.unit && rowData.unit !== "—" ? rowData.unit : ""].filter(Boolean).join(" · ") || undefined,
              scheduledFor: undefined,
              vendorName: offeredVendors[0]?.name || undefined,
              url: `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/vendor/work-orders`,
            }
          : {}),
      },
      recipients: [
        ...offeredVendors.map((vendor) => ({ audience: "vendor" as const, userId: vendor.vendorUserId ?? undefined, email: vendor.email || undefined })),
        ...managerRecipients.map((userId) => ({ audience: "manager" as const, userId })),
      ],
    }).catch(() => undefined);
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

/**
 * "Vendor silent after accept" (PLAN-0915 area 4): the accepted vendor never
 * scheduled the visit. Unassigns them and offers the job to the next-best
 * declined bid (lowest price first), reusing the exact `sendWorkOrderVendorOffers`
 * path a manager's own "Invite for bids" send uses — no second notification
 * path for what is still, from the vendor's side, an ordinary new offer.
 */
export async function reofferWorkOrderToNextVendor(
  db: Db,
  input: {
    workOrderId: string;
    managerUserId: string;
    managerEmail: string;
    managerName?: string;
    row: DemoManagerWorkOrderRow;
    now?: Date;
  },
): Promise<{ ok: true; vendorId: string } | { ok: false; reason: "no_candidate" }> {
  const now = input.now ?? new Date();
  const { data: declinedBids } = await db
    .from("work_order_bids")
    .select("vendor_directory_id, amount_cents")
    .eq("work_order_id", input.workOrderId)
    .eq("status", "declined")
    .not("vendor_directory_id", "is", null)
    .order("amount_cents", { ascending: true });
  const candidateId = ((declinedBids ?? []) as { vendor_directory_id: string | null }[])
    .map((bid) => String(bid.vendor_directory_id ?? "").trim())
    .find((id) => id && id !== input.row.vendorId);
  if (!candidateId) return { ok: false, reason: "no_candidate" };

  // Unassign the silent vendor first so the offer path reads the job as open —
  // exactly what a manager pulling the assignment by hand would leave behind.
  const unassignedRow: DemoManagerWorkOrderRow = {
    ...input.row,
    vendorId: undefined,
    vendorName: undefined,
    vendorAssignedAt: undefined,
    biddingOpen: false,
    biddingResolvedAt: undefined,
  };
  const { error } = await db
    .from("portal_work_order_records")
    .update({ vendor_user_id: null, row_data: unassignedRow, updated_at: now.toISOString() })
    .eq("id", input.workOrderId);
  if (error) throw error;

  // Releasing the vendor releases their accepted bid with them. Left standing it would stay the
  // payout anchor for a job they no longer hold, and the re-offer's own eventual approval would
  // make a SECOND accepted row on the same service.
  const { error: releaseError } = await db
    .from("work_order_bids")
    .update({ status: "declined", updated_at: now.toISOString() })
    .eq("work_order_id", input.workOrderId)
    .eq("status", "accepted");
  if (releaseError) throw new Error(releaseError.message);

  const actor: WorkOrderActor = {
    userId: input.managerUserId,
    email: input.managerEmail,
    fullName: input.managerName?.trim() || "PropLane Automation",
    admin: false,
    role: "manager",
  };
  const result = await sendWorkOrderVendorOffers(db, actor, { workOrderId: input.workOrderId, vendorIds: [candidateId] });
  if (!result.ok || result.sent.length === 0) return { ok: false, reason: "no_candidate" };
  return { ok: true, vendorId: candidateId };
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
