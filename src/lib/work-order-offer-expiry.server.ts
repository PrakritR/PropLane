import "server-only";

/**
 * Vendor offers expire (PLAN-0915).
 *
 * `sendWorkOrderVendorOffers` stamps `expires_at` from the manager's Services
 * setting. This sweep, run on the dispatcher tick, flips every unanswered
 * offer past that moment to `expired`, tells each vendor once, and — when the
 * work order still has nobody — tells the manager once so they can re-offer
 * or widen the list. Idempotent: the status flip is the claim, so two
 * overlapping ticks cannot double-notify.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { resolvePropertyScopedManagerRecipientIds } from "@/lib/co-manager-notification-recipients.server";
import { loadServiceAutomationSettingsForManagers } from "@/lib/service-automation-settings.server";
import { workOrderEvent } from "@/lib/work-order-events.server";

type OfferRow = {
  id: string;
  work_order_id: string;
  vendor_directory_id: string;
  vendor_user_id: string | null;
  manager_user_id: string;
  expires_at: string;
};

export async function expireVendorOffers(db: SupabaseClient, now: Date = new Date()): Promise<{ expired: number; managersTold: number }> {
  const { data, error } = await db
    .from("work_order_vendor_offers")
    .select("id, work_order_id, vendor_directory_id, vendor_user_id, manager_user_id, expires_at")
    .eq("status", "sent")
    .not("expires_at", "is", null)
    .lte("expires_at", now.toISOString())
    .limit(200);
  if (error) throw error;
  const due = (data ?? []) as OfferRow[];
  if (due.length === 0) return { expired: 0, managersTold: 0 };

  // Claim by flipping status; only rows we actually flipped are notified.
  const claimed: OfferRow[] = [];
  for (const offer of due) {
    const { data: flipped } = await db
      .from("work_order_vendor_offers")
      .update({ status: "expired", updated_at: now.toISOString() })
      .eq("id", offer.id)
      .eq("status", "sent")
      .select("id")
      .maybeSingle();
    if (flipped) claimed.push(offer);
  }
  if (claimed.length === 0) return { expired: 0, managersTold: 0 };

  const workOrderIds = [...new Set(claimed.map((offer) => offer.work_order_id))];
  const { data: workOrders } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, row_data")
    .in("id", workOrderIds);
  const workOrderById = new Map<string, { managerUserId: string; row: DemoManagerWorkOrderRow }>();
  for (const row of workOrders ?? []) {
    workOrderById.set(String(row.id), { managerUserId: String(row.manager_user_id), row: row.row_data as DemoManagerWorkOrderRow });
  }
  const vendorIds = [...new Set(claimed.map((offer) => offer.vendor_directory_id))];
  const { data: vendors } = await db.from("manager_vendor_records").select("id, row_data").in("id", vendorIds);
  const vendorById = new Map<string, { email: string; name: string }>();
  for (const row of vendors ?? []) {
    const rowData = (row.row_data ?? {}) as Record<string, unknown>;
    vendorById.set(String(row.id), { email: String(rowData.email ?? "").trim().toLowerCase(), name: String(rowData.name ?? "").trim() });
  }
  const managerIds = [...new Set(claimed.map((offer) => offer.manager_user_id))];
  const [serviceSettings, { data: profiles }] = await Promise.all([
    loadServiceAutomationSettingsForManagers(db, managerIds),
    db.from("profiles").select("id, email, full_name").in("id", managerIds),
  ]);
  const senderById = new Map<string, { email: string; name: string }>();
  for (const row of profiles ?? []) {
    senderById.set(String(row.id), { email: String(row.email ?? "").trim().toLowerCase(), name: String(row.full_name ?? "").trim() || "PropLane Portal" });
  }

  const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");
  let managersTold = 0;
  const byWorkOrder = new Map<string, OfferRow[]>();
  for (const offer of claimed) {
    const list = byWorkOrder.get(offer.work_order_id) ?? [];
    list.push(offer);
    byWorkOrder.set(offer.work_order_id, list);
  }

  for (const [workOrderId, offers] of byWorkOrder) {
    const workOrder = workOrderById.get(workOrderId);
    if (!workOrder) continue;
    const sender = senderById.get(workOrder.managerUserId);
    if (!sender?.email) continue;
    const facts = {
      reference: workOrder.row.reference || "Work order",
      title: workOrder.row.title || "Work order",
      propertyLabel: workOrder.row.propertyName || undefined,
      url: `${origin}/portal/services/work-orders`,
    };
    // The vendors: each told their offer lapsed, whether or not the job was
    // taken by someone else — that case has its own `offer_filled` message.
    const stillOpen = workOrder.row.bucket === "open" && !workOrder.row.vendorId && !workOrder.row.vendorUserId;
    const vendorRecipients = offers.flatMap((offer) => {
      const vendor = vendorById.get(offer.vendor_directory_id);
      return vendor?.email.includes("@") || offer.vendor_user_id
        ? [{ audience: "vendor" as const, userId: offer.vendor_user_id ?? undefined, email: vendor?.email || undefined }]
        : [];
    });
    const tellManager = stillOpen && (serviceSettings.get(workOrder.managerUserId)?.notifyWhenNoVendorAnswers ?? true);
    const managerRecipients = tellManager
      ? (
          await resolvePropertyScopedManagerRecipientIds(db, {
            ownerManagerUserId: workOrder.managerUserId,
            propertyId: workOrder.row.assignedPropertyId || workOrder.row.propertyId || undefined,
            channel: "services",
          })
        ).map((userId) => ({ audience: "manager" as const, userId }))
      : [];
    if (managerRecipients.length) managersTold += 1;
    if (vendorRecipients.length === 0 && managerRecipients.length === 0) continue;
    await workOrderEvent(db, {
      eventId: `${workOrderId}:offer_expired:${offers.map((offer) => offer.id).sort().join(",")}`,
      event: "offer_expired",
      managerUserId: workOrder.managerUserId,
      workOrderId,
      senderUserId: workOrder.managerUserId,
      senderEmail: sender.email,
      senderName: sender.name,
      facts,
      recipients: [...vendorRecipients, ...managerRecipients],
      now,
    }).catch(() => undefined);
    // The round is over; a re-offer stamps a fresh expiry.
    if (workOrder.row.offerExpiresAt) {
      await db
        .from("portal_work_order_records")
        .update({ row_data: { ...workOrder.row, offerExpiresAt: undefined }, updated_at: now.toISOString() })
        .eq("id", workOrderId);
    }
  }
  return { expired: claimed.length, managersTold };
}

/**
 * When one vendor accepts, every other open offer on the job is `filled` and
 * those vendors are told once. Called from the accept path.
 */
export async function fillSiblingOffers(
  db: SupabaseClient,
  input: {
    workOrderId: string;
    managerUserId: string;
    acceptedVendorDirectoryId?: string | null;
    acceptedVendorUserId?: string | null;
    /** Vendors who already hear a richer message elsewhere (declined bids). */
    excludeVendorUserIds?: (string | null | undefined)[];
    row: DemoManagerWorkOrderRow;
    sender: { userId: string; email: string; name?: string };
    now?: Date;
  },
): Promise<number> {
  const now = input.now ?? new Date();
  const { data } = await db
    .from("work_order_vendor_offers")
    .select("id, vendor_directory_id, vendor_user_id")
    .eq("work_order_id", input.workOrderId)
    .eq("status", "sent");
  const siblings = ((data ?? []) as { id: string; vendor_directory_id: string; vendor_user_id: string | null }[]).filter(
    (offer) =>
      offer.vendor_directory_id !== (input.acceptedVendorDirectoryId ?? "") &&
      (!input.acceptedVendorUserId || offer.vendor_user_id !== input.acceptedVendorUserId) &&
      !(offer.vendor_user_id && (input.excludeVendorUserIds ?? []).includes(offer.vendor_user_id)),
  );
  if (siblings.length === 0) return 0;
  const { data: flipped } = await db
    .from("work_order_vendor_offers")
    .update({ status: "filled", updated_at: now.toISOString() })
    .in("id", siblings.map((offer) => offer.id))
    .eq("status", "sent")
    .select("id, vendor_directory_id, vendor_user_id");
  const told = (flipped ?? []) as { id: string; vendor_directory_id: string; vendor_user_id: string | null }[];
  if (told.length === 0) return 0;
  const { data: vendors } = await db.from("manager_vendor_records").select("id, row_data").in("id", told.map((offer) => offer.vendor_directory_id));
  const emailById = new Map<string, string>();
  for (const row of vendors ?? []) emailById.set(String(row.id), String((row.row_data as { email?: string })?.email ?? "").trim().toLowerCase());
  await workOrderEvent(db, {
    eventId: `${input.workOrderId}:offer_filled:${told.map((offer) => offer.id).sort().join(",")}`,
    event: "offer_filled",
    managerUserId: input.managerUserId,
    workOrderId: input.workOrderId,
    senderUserId: input.sender.userId,
    senderEmail: input.sender.email,
    senderName: input.sender.name,
    facts: { reference: input.row.reference || "Work order", title: input.row.title || "Work order", propertyLabel: input.row.propertyName || undefined },
    recipients: told.map((offer) => ({ audience: "vendor" as const, userId: offer.vendor_user_id ?? undefined, email: emailById.get(offer.vendor_directory_id) || undefined })),
    now,
  }).catch(() => undefined);
  return told.length;
}
