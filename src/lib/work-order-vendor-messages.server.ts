import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { emitActionEvent } from "@/lib/action-events.server";
import type { ManagerTask } from "@/lib/manager-tasks";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { sendWorkOrderVendorOffers } from "@/lib/work-order-offers.server";
import { VENDOR_TRADE_OPTIONS, categoriesForVendorTrade } from "@/lib/work-order-taxonomy";
import { resolveOwnedVendor } from "@/lib/work-order-vendor.server";
import {
  managerSender,
  renderVendorTaskAssigned,
  vendorAssignedEventId,
  workOrderEvent,
} from "@/lib/work-order-events.server";

/**
 * Part C of comms-safety-0929: the two moments a vendor used to hear nothing
 * about. Both are sent AS the owning manager (their workspace number and work
 * address, never the resident), carry facts only (no resident name or phone
 * until the vendor accepts), and say "service".
 *
 *  - a resident files a service  -> the PREFERRED vendor for that house and
 *    trade is offered it (D3). No preferred vendor means nobody is messaged.
 *  - the manager, the Assistant or a one-tap dispatch puts a vendor on a
 *    service -> that vendor hears "You were assigned ...".
 *
 * Always on (D4): there is no switch. "Resident & vendor messages need my
 * approval first" still turns each into a draft on the action-event bus, and
 * the vendor's own Settings -> Notifications decides their text and email.
 */

type Db = SupabaseClient;

const VENDOR_SERVICES_PATH = "/vendor/work-orders";

function vendorServicesUrl(): string {
  return `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}${VENDOR_SERVICES_PATH}`;
}

function houseLabel(row: Pick<DemoManagerWorkOrderRow, "propertyName" | "unit">): string | undefined {
  const name = row.propertyName?.trim();
  if (!name) return undefined;
  const unit = row.unit?.trim();
  return unit && unit !== "—" ? `${name} · ${unit}` : name;
}

/**
 * True when an `accepted` or `scheduled` event for this service was already
 * recorded at or after the assignment instant. Those two events already tell
 * the vendor they have the job (a bid accept, a one-tap dispatch), so a second
 * "You were assigned" would be the duplicate the plan forbids.
 */
export function vendorAssignmentAlreadyAnnounced(
  priorEvents: ReadonlyArray<{ event_type?: unknown; occurred_at?: unknown }>,
  assignedAtIso: string,
): boolean {
  const assignedAt = Date.parse(assignedAtIso);
  return priorEvents.some((event) => {
    const type = String(event.event_type ?? "");
    if (type !== "accepted" && type !== "scheduled") return false;
    const at = Date.parse(String(event.occurred_at ?? ""));
    if (!Number.isFinite(at)) return false;
    return !Number.isFinite(assignedAt) || at >= assignedAt;
  });
}

export type EmitVendorAssignedInput = {
  workOrderId: string;
  /** The owning manager: the sender, and whose workspace number the text leaves from. */
  managerUserId: string;
  row: Pick<
    DemoManagerWorkOrderRow,
    "reference" | "title" | "propertyName" | "unit" | "priority" | "scheduled" | "scheduledAtIso" | "propertyId" | "assignedPropertyId"
  >;
  vendorDirectoryId: string;
  /** `row_data.vendorAssignedAt`; part of the delivery key so a later reassignment sends again. */
  assignedAt: string;
};

export type EmitVendorAssignedResult =
  | { sent: true; duplicate: boolean }
  | { sent: false; reason: "suppressed_already_announced" | "vendor_unavailable" | "no_manager_identity" };

/**
 * "You were assigned ..." to the vendor now on a service. One delivery key per
 * assignment (`<service>:vendor_assigned:<vendor>:<assignedAt>`), so a retry
 * sends nothing new; assigning someone else, or the same vendor again later,
 * carries a new `assignedAt` and does send.
 */
export async function emitVendorAssigned(db: Db, input: EmitVendorAssignedInput): Promise<EmitVendorAssignedResult> {
  const { vendor, rejected } = await resolveOwnedVendor(db, input.vendorDirectoryId, input.managerUserId);
  if (rejected || !vendor) return { sent: false, reason: "vendor_unavailable" };

  const { data: prior } = await db
    .from("action_events")
    .select("event_type, occurred_at")
    .eq("domain", "work_order")
    .eq("entity_id", input.workOrderId)
    .in("event_type", ["accepted", "scheduled"]);
  if (vendorAssignmentAlreadyAnnounced((prior ?? []) as Array<{ event_type?: unknown; occurred_at?: unknown }>, input.assignedAt)) {
    return { sent: false, reason: "suppressed_already_announced" };
  }

  const manager = await managerSender(db, input.managerUserId);
  if (!manager) return { sent: false, reason: "no_manager_identity" };

  const emergency = input.row.priority === "Emergency";
  const result = await workOrderEvent(db, {
    eventId: vendorAssignedEventId(input.workOrderId, input.vendorDirectoryId, input.assignedAt),
    event: "vendor_assigned",
    managerUserId: input.managerUserId,
    workOrderId: input.workOrderId,
    senderUserId: manager.userId,
    senderEmail: manager.email,
    senderName: manager.name,
    facts: {
      reference: input.row.reference || "Service",
      propertyId: input.row.assignedPropertyId || input.row.propertyId || undefined,
      title: input.row.title || "Service",
      propertyLabel: houseLabel(input.row),
      scheduledFor: input.row.scheduledAtIso ? input.row.scheduled || undefined : undefined,
      vendorName: vendor.name || undefined,
      emergency,
      url: vendorServicesUrl(),
    },
    recipients: [{ audience: "vendor", userId: vendor.vendorUserId ?? undefined, email: vendor.email || undefined }],
  });
  return { sent: true, duplicate: result.duplicate };
}

/** Trade labels (`VENDOR_TRADE_OPTIONS`) whose preferred list applies to a service of this category. */
export function preferenceTradesForCategory(category: string | undefined | null): string[] {
  const wanted = String(category ?? "").trim();
  if (!wanted) return [];
  return VENDOR_TRADE_OPTIONS.filter((trade) => (categoriesForVendorTrade(trade) as string[]).includes(wanted));
}

export type OfferToPreferredVendorResult =
  | { offered: true; vendorDirectoryId: string }
  | {
      offered: false;
      reason:
        | "not_found"
        | "not_eligible"
        | "no_house"
        | "no_trade"
        | "no_preferred_vendor"
        | "already_offered"
        | "offer_failed";
    };

/**
 * A freshly filed resident service is offered to the manager's PREFERRED
 * vendor for that house and trade (the first of their ordered list that is
 * still on the roster). With none set nobody is messaged and the manager's
 * "unassigned service" alert stands. The offer is the ordinary one
 * (`sendWorkOrderVendorOffers`): the vendor gets a real offer to accept or
 * decline, and the message that tells them is `vendor_new_service`.
 */
export async function offerNewServiceToPreferredVendor(
  db: Db,
  input: { workOrderId: string },
): Promise<OfferToPreferredVendorResult> {
  const { data: record } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, row_data")
    .eq("id", input.workOrderId)
    .maybeSingle();
  const managerUserId = String(record?.manager_user_id ?? "").trim();
  const row = (record?.row_data ?? null) as DemoManagerWorkOrderRow | null;
  if (!record || !managerUserId || !row) return { offered: false, reason: "not_found" };
  if (row.managerInitiated === true || row.bucket !== "open") return { offered: false, reason: "not_eligible" };
  if (row.vendorId || row.selfAssigned || row.biddingOpen) return { offered: false, reason: "not_eligible" };

  const propertyId = (row.assignedPropertyId || row.propertyId || "").trim();
  if (!propertyId) return { offered: false, reason: "no_house" };
  const trades = preferenceTradesForCategory(row.category);
  if (trades.length === 0) return { offered: false, reason: "no_trade" };

  const { data: preferences } = await db
    .from("manager_vendor_preferences")
    .select("vendor_id, priority")
    .eq("manager_user_id", managerUserId)
    .eq("property_id", propertyId)
    .in("trade", trades)
    .order("priority", { ascending: true });

  let chosen: string | null = null;
  for (const preference of (preferences ?? []) as Array<{ vendor_id?: unknown }>) {
    const vendorId = String(preference.vendor_id ?? "").trim();
    if (!vendorId) continue;
    const { vendor, rejected } = await resolveOwnedVendor(db, vendorId, managerUserId);
    if (rejected || !vendor) continue;
    chosen = vendorId;
    break;
  }
  if (!chosen) return { offered: false, reason: "no_preferred_vendor" };

  // One offer per (service, vendor): a replay of the create never re-offers a
  // service the vendor already answered.
  const { data: existingOffer } = await db
    .from("work_order_vendor_offers")
    .select("id")
    .eq("work_order_id", input.workOrderId)
    .eq("vendor_directory_id", chosen)
    .maybeSingle();
  if (existingOffer) return { offered: false, reason: "already_offered" };

  const manager = await managerSender(db, managerUserId);
  if (!manager) return { offered: false, reason: "offer_failed" };
  const result = await sendWorkOrderVendorOffers(
    db as Parameters<typeof sendWorkOrderVendorOffers>[0],
    { userId: managerUserId, email: manager.email, fullName: manager.name ?? "", admin: false, role: "manager" },
    { workOrderId: input.workOrderId, vendorIds: [chosen], marketplace: { enabled: false }, newService: true },
  );
  if (!result.ok || !result.sent.includes(chosen)) return { offered: false, reason: "offer_failed" };
  return { offered: true, vendorDirectoryId: chosen };
}

export type EmitVendorTaskAssignedResult =
  | { sent: true; duplicate: boolean }
  | { sent: false; reason: "not_a_vendor_task" | "vendor_unavailable" | "no_manager_identity" };

/**
 * "New task from <manager>" to the vendor a task was just assigned to
 * (`task_assigned_vendor`). Sent as the owning manager; the task's title, house
 * and due time only. `changedAt` is part of the delivery key, so saving the
 * same assignment again sends nothing and moving the task to another vendor (or
 * back later) does.
 */
export async function emitVendorTaskAssigned(
  db: Db,
  input: { managerUserId: string; task: ManagerTask; changedAt: string },
): Promise<EmitVendorTaskAssignedResult> {
  const assignee = input.task.assignee;
  if (!assignee || assignee.type !== "vendor" || !assignee.id.trim()) return { sent: false, reason: "not_a_vendor_task" };
  const { vendor, rejected } = await resolveOwnedVendor(db, assignee.id.trim(), input.managerUserId);
  if (rejected || !vendor) return { sent: false, reason: "vendor_unavailable" };
  const manager = await managerSender(db, input.managerUserId);
  if (!manager) return { sent: false, reason: "no_manager_identity" };

  const due = input.task.dueDate || input.task.start;
  const rendered = renderVendorTaskAssigned({
    managerName: manager.name,
    title: input.task.title,
    propertyLabel: input.task.propertyTitle,
    dueLabel: due ? formatPacificDateTime(due) : undefined,
    url: `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/vendor/work-orders/pending`,
  });
  const result = await emitActionEvent(db, {
    eventId: `task:${input.task.id}:task_assigned_vendor:${assignee.id.trim()}:${input.changedAt}`,
    domain: "task",
    event: "task_assigned_vendor",
    managerUserId: input.managerUserId,
    entityId: input.task.id,
    category: "maintenance",
    senderUserId: manager.userId,
    senderEmail: manager.email,
    senderName: manager.name,
    payload: { propertyId: input.task.propertyId?.trim() || null },
    recipients: [{ audience: "vendor", userId: vendor.vendorUserId ?? undefined, email: vendor.email || undefined, rendered }],
    templateContext: {
      title: input.task.title,
      propertyTitle: input.task.propertyTitle ?? "",
      dueDateLabel: due ? formatPacificDateTime(due) : "",
      managerName: manager.name ?? "",
      url: `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/vendor/work-orders/pending`,
    },
  });
  return { sent: true, duplicate: result.duplicate };
}
