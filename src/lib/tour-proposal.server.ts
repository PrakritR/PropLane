/**
 * Approval-first automated tours. When a manager opts in
 * (`proposeTourConfirmations`), a new pending tour inquiry generates a PROPOSAL
 * to confirm it into the first matching open availability slot. The proposal is
 * a gated pending action (`agent_pending_actions`, tool `confirm_tour_inquiry`)
 * the manager must approve — nothing books or emails the tenant until then, and
 * on no slot match nothing is proposed at all (the inquiry is handled manually).
 */
import "server-only";

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { managerHasPublishedSlot } from "@/lib/public-tour-booking-guard";
import { formatRangeLabel } from "@/lib/tour-inquiry-confirm.server";
import { createPendingActionForUser, listProposedActionsForUser } from "@/lib/tools/pending-actions";
import type { ActionPreview } from "@/lib/tools/registry";
import {
  rowPayload,
  slotBlocked,
  slotIsBookable,
  windowsFromPayload,
  type TourBlock,
} from "@/lib/tour-slot-math";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export const CONFIRM_TOUR_INQUIRY_TOOL = "confirm_tour_inquiry";
/** Async approvals sit in the manager's queue far longer than a live chat turn. */
const PROPOSAL_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;

const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";
const INQUIRY_EVENT_RECORD_TYPE = "partner_inquiry_request";

export type RequestedTourWindow = { start: string; end: string; slotKey?: string; adminUserId?: string };

function text(row: Record<string, unknown> | null | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export type ManagerTourBlocksLookup = { ok: true; blocks: TourBlock[] } | { ok: false };

/**
 * Every window this manager is currently unavailable for: competing pending
 * tour inquiries (excluding the one being proposed, so it never blocks itself)
 * plus already-booked tours. Mirrors the public availability route's exclusion
 * set so a proposal can only land on a slot the grid would still offer.
 *
 * Reports a failed read as `{ ok: false }` rather than as an empty block set:
 * "we could not read what is booked" and "nothing is booked" are opposite
 * facts, and a caller that offers a window on the strength of the second while
 * the first is true offers a slot someone already holds. Callers that only
 * need the lenient shape use {@link loadManagerTourBlocks}.
 */
export async function loadManagerTourBlocksResult(
  db: Db,
  managerUserId: string,
  excludeInquiryId?: string,
): Promise<ManagerTourBlocksLookup> {
  const blocks: TourBlock[] = [];

  const { data: pendingRows, error: pendingError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("record_type", INQUIRY_EVENT_RECORD_TYPE)
    .eq("manager_user_id", managerUserId);
  if (pendingError) {
    console.error("loadManagerTourBlocks pending inquiries read failed", pendingError.message);
    return { ok: false };
  }
  for (const pending of (pendingRows ?? []) as { row_data?: unknown }[]) {
    const payload = rowPayload(pending.row_data);
    if (!payload) continue;
    if (text(payload, "status").toLowerCase() !== "pending") continue;
    if (excludeInquiryId && text(payload, "id") === excludeInquiryId) continue;
    blocks.push(...windowsFromPayload(payload));
  }

  const { data: plannedRow, error: plannedError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", PLANNED_RECORD_ID)
    .maybeSingle();
  if (plannedError) {
    console.error("loadManagerTourBlocks planned tours read failed", plannedError.message);
    return { ok: false };
  }
  const plannedPayload = asObject(plannedRow?.row_data)?.payload;
  const plannedEvents = Array.isArray(plannedPayload) ? plannedPayload.map(asObject).filter(Boolean) : [];
  for (const event of plannedEvents as Record<string, unknown>[]) {
    if (text(event, "kind") !== "tour") continue;
    if (text(event, "managerUserId") !== managerUserId) continue;
    const start = text(event, "start");
    const end = text(event, "end");
    if (!start || !end) continue;
    blocks.push({ start, end, slotKey: text(event, "slotKey") || undefined });
  }

  return { ok: true, blocks };
}

/** {@link loadManagerTourBlocksResult}, with an unreadable state flattened to "no blocks". */
export async function loadManagerTourBlocks(
  db: Db,
  managerUserId: string,
  excludeInquiryId?: string,
): Promise<TourBlock[]> {
  const result = await loadManagerTourBlocksResult(db, managerUserId, excludeInquiryId);
  return result.ok ? result.blocks : [];
}

/**
 * The first requested window that is still a genuinely open slot for this
 * manager: published in their availability, in the future, and not blocked by a
 * competing inquiry or booked tour. Returns null when none matches — the caller
 * then leaves the inquiry for manual handling.
 */
export async function findFirstOpenTourSlot(
  db: Db,
  args: {
    managerUserId: string;
    propertyId?: string | null;
    requestedWindows: RequestedTourWindow[];
    excludeInquiryId?: string;
    now?: number;
  },
): Promise<{ slotKey: string; start: string; end: string } | null> {
  const windows = args.requestedWindows.filter((w) => w.slotKey && w.start && w.end);
  if (windows.length === 0) return null;

  const blocks = await loadManagerTourBlocks(db, args.managerUserId, args.excludeInquiryId);
  const now = args.now ?? Date.now();

  for (const window of windows) {
    const slotKey = window.slotKey!;
    if (!slotIsBookable(slotKey, now)) continue;
    if (slotBlocked(slotKey, blocks)) continue;
    const published = await managerHasPublishedSlot(db, {
      managerUserId: args.managerUserId,
      slotKey,
      propertyId: args.propertyId ?? null,
    });
    if (!published) continue;
    return { slotKey, start: window.start, end: window.end };
  }
  return null;
}

/** The approval card shown to the manager for a proposed tour confirmation. */
export function buildTourConfirmPreview(
  inquiry: Record<string, unknown>,
  slot: { start: string; end: string },
): ActionPreview {
  const guest = text(inquiry, "name") || "Guest";
  const property = text(inquiry, "propertyTitle") || "Property";
  const room = text(inquiry, "roomLabel");
  const fields: { label: string; value: string }[] = [
    { label: "Guest", value: guest },
    { label: "Property", value: property },
  ];
  if (room) fields.push({ label: "Room", value: room });
  fields.push({ label: "Proposed time", value: formatRangeLabel(slot.start, slot.end) });
  return {
    kind: "confirm_tour_inquiry",
    title: `Confirm tour with ${guest}`,
    confirmLabel: "Confirm tour",
    fields,
    warnings: ["Confirming books this time on your calendar and notifies the guest."],
  };
}

/**
 * Generate an approval item for a newly-arrived pending tour inquiry, if the
 * manager opted in AND a matching open slot exists. Best-effort and idempotent:
 * a second call for the same inquiry (e.g. a resubmit) is a no-op while a
 * proposal is still open. Never books or emails anything — that only happens
 * when the manager approves the returned pending action.
 */
export async function proposeTourConfirmation(
  db: Db,
  args: { inquiry: Record<string, unknown>; managerUserId: string; requestedWindows: RequestedTourWindow[] },
): Promise<{ proposed: boolean; actionId?: string; reason?: "no_slot" | "already_proposed" }> {
  const inquiryId = text(args.inquiry, "id");
  if (!inquiryId || !args.managerUserId) return { proposed: false, reason: "no_slot" };

  const existing = await listProposedActionsForUser(db, {
    userId: args.managerUserId,
    toolName: CONFIRM_TOUR_INQUIRY_TOOL,
  });
  if (existing.some((action) => text(asObject(action.input) ?? {}, "inquiryId") === inquiryId)) {
    return { proposed: false, reason: "already_proposed" };
  }

  const slot = await findFirstOpenTourSlot(db, {
    managerUserId: args.managerUserId,
    propertyId: text(args.inquiry, "propertyId") || null,
    requestedWindows: args.requestedWindows,
    excludeInquiryId: inquiryId,
  });
  if (!slot) return { proposed: false, reason: "no_slot" };

  const preview = buildTourConfirmPreview(args.inquiry, slot);
  const actionId = await createPendingActionForUser(db, {
    landlordId: args.managerUserId,
    userId: args.managerUserId,
    toolName: CONFIRM_TOUR_INQUIRY_TOOL,
    input: { inquiryId, start: slot.start, end: slot.end },
    preview,
    expiresInMs: PROPOSAL_EXPIRES_MS,
  });
  if (!actionId) return { proposed: false, reason: "no_slot" };
  return { proposed: true, actionId };
}
