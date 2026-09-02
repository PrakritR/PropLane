/**
 * Creating a tour request — the ONE implementation.
 *
 * This was the body of `POST /api/public/partner-inquiries`. It moved here when
 * the agent gained tour tools, because a tool must never `fetch()` an internal
 * route (docs/ai-assistant.md, "How to add a new tool"). The public web form,
 * the resident assistant, and the prospect-facing leasing SMS agent now file an
 * inquiry through the same function, so the host/slot guards and the
 * double-book check cannot differ by entry point.
 *
 * What it deliberately does NOT do: book anything. A tour request is
 * `status: "pending"` and stays that way until a human confirms it —
 * `proposeTourConfirmation` may raise an APPROVAL for the manager when they
 * opted in, and `confirm_tour_inquiry` is what actually books. That is the
 * approval-first invariant in docs/agents/tours-scheduling.md.
 *
 * Callers own two things this function does not: rate limiting, and linking a
 * signed-in resident to the inquiry afterwards.
 */
import "server-only";

import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { recordOptIn } from "@/lib/sms-consent";
import {
  adminHasPublishedSlot,
  managerHasPublishedSlot,
  managerMayHostPropertyTour,
} from "@/lib/public-tour-booking-guard";
import { notifyManagerTourRequest, notifyTenantTourRequestReceived } from "@/lib/tour-notification-delivery.server";
import { loadManagerAutomationSettings } from "@/lib/payment-automation-settings";
import { proposeTourConfirmation } from "@/lib/tour-proposal.server";
import { createApproveTourRequestTask } from "@/lib/manager-default-tasks.server";
import { normalizeTourContactPhone, validateTourContactFields } from "@/lib/tour-contact-quality";
import { isActivePlannedTourEvent } from "@/lib/tour-slot-math";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export const INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";
export const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";
export const INQUIRY_EVENT_RECORD_TYPE = "partner_inquiry_request";

export type RequestedWindow = { start: string; end: string; adminUserId?: string; slotKey?: string };

/**
 * The failure modes callers must distinguish. The route maps these to HTTP
 * statuses; a tool preview throws the message so the model can self-correct.
 */
export type CreateTourInquiryResult =
  | { ok: true; row: Record<string, unknown>; inquiryId: string }
  | { ok: false; reason: "invalid_contact" | "missing_host" | "slot_unavailable"; error: string }
  | { ok: false; reason: "conflict"; error: string }
  | { ok: false; reason: "write_failed"; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function inquiryRowsFromRecord(rowData: unknown): Record<string, unknown>[] {
  if (!isObject(rowData)) return [];
  const payload = rowData.payload;
  return Array.isArray(payload) ? payload.filter(isObject) : [];
}

export function requestedWindowsFromRow(row: Record<string, unknown>): RequestedWindow[] {
  const windows = Array.isArray(row.requestedWindows) ? row.requestedWindows : [];
  const normalized = windows
    .filter(isObject)
    .map((window) => ({
      start: typeof window.start === "string" ? window.start : "",
      end: typeof window.end === "string" ? window.end : "",
      adminUserId: typeof window.adminUserId === "string" ? window.adminUserId : undefined,
      slotKey: typeof window.slotKey === "string" ? window.slotKey : undefined,
    }))
    .filter((window) => window.start && window.end);
  if (normalized.length > 0) return normalized;
  return typeof row.proposedStart === "string" && typeof row.proposedEnd === "string"
    ? [{
      start: row.proposedStart,
      end: row.proposedEnd,
      adminUserId: typeof row.adminUserId === "string" ? row.adminUserId : undefined,
      slotKey: typeof row.slotKey === "string" ? row.slotKey : undefined,
    }]
    : [];
}

function payloadFromScheduleRecord(rowData: unknown): Record<string, unknown> | null {
  const record = isObject(rowData) ? rowData : null;
  if (!record) return null;
  return isObject(record.payload) ? record.payload : record;
}

function slotKeysFromInquiryPayload(payload: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  const rowSlotKey = textValue(payload.slotKey);
  if (rowSlotKey) keys.add(rowSlotKey);
  for (const window of requestedWindowsFromRow(payload)) {
    if (window.slotKey) keys.add(window.slotKey);
  }
  return keys;
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const a0 = new Date(aStart).getTime();
  const a1 = new Date(aEnd).getTime();
  const b0 = new Date(bStart).getTime();
  const b1 = new Date(bEnd).getTime();
  if (![a0, a1, b0, b1].every(Number.isFinite)) return false;
  return a0 < b1 && b0 < a1;
}

/**
 * Would this request collide with a pending inquiry or an already-booked tour
 * for the same manager? Matches on slot key first (the exact grid cell) and
 * falls back to time overlap for rows written without one.
 */
export async function hasManagerTourConflict(
  db: Db,
  managerUserId: string,
  incomingWindows: RequestedWindow[],
): Promise<boolean> {
  const incomingSlotKeys = new Set(
    incomingWindows.map((window) => window.slotKey).filter((key): key is string => Boolean(key)),
  );
  const { data: pendingRows, error: pendingError } = await db
    .from("portal_schedule_records")
    .select("starts_at, ends_at, row_data")
    .eq("record_type", INQUIRY_EVENT_RECORD_TYPE)
    .eq("manager_user_id", managerUserId);

  if (pendingError) throw pendingError;

  for (const pending of (pendingRows ?? []) as { starts_at?: string | null; ends_at?: string | null; row_data?: unknown }[]) {
    const payload = payloadFromScheduleRecord(pending.row_data);
    if (payload && textValue(payload.status).toLowerCase() !== "pending") continue;
    const pendingSlotKeys = payload ? slotKeysFromInquiryPayload(payload) : new Set<string>();
    if (incomingSlotKeys.size > 0 && [...incomingSlotKeys].some((slotKey) => pendingSlotKeys.has(slotKey))) return true;
    if (pending.starts_at && pending.ends_at && incomingWindows.some((window) => overlaps(window.start, window.end, pending.starts_at!, pending.ends_at!))) {
      return true;
    }
  }

  const { data: plannedRow, error: plannedError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", PLANNED_RECORD_ID)
    .maybeSingle();

  if (plannedError) throw plannedError;

  const plannedPayload = isObject(plannedRow?.row_data) ? plannedRow.row_data.payload : null;
  const plannedEvents = Array.isArray(plannedPayload) ? plannedPayload.filter(isObject) : [];
  for (const event of plannedEvents) {
    if (textValue(event.kind) !== "tour") continue;
    if (!isActivePlannedTourEvent(event)) continue;
    if (textValue(event.managerUserId) !== managerUserId) continue;
    const plannedSlotKey = textValue(event.slotKey);
    if (plannedSlotKey && incomingSlotKeys.has(plannedSlotKey)) return true;
    const start = textValue(event.start);
    const end = textValue(event.end);
    if (start && end && incomingWindows.some((window) => overlaps(window.start, window.end, start, end))) return true;
  }

  return false;
}

/**
 * File a tour (or partner-meeting) inquiry.
 *
 * `incoming` is the caller-supplied row. Everything that decides ACCESS is
 * re-derived here from the database — the host must actually be able to host
 * that property, the slot must actually be published, and the time must not
 * already be taken. A caller naming a manager and a time is a request, never
 * an authorization.
 */
export async function createTourInquiry(
  db: Db,
  args: { incoming: Record<string, unknown>; notify?: boolean },
): Promise<CreateTourInquiryResult> {
  const incoming = args.incoming;
  const notify = args.notify !== false;

  const id = typeof incoming.id === "string" && incoming.id.trim() ? incoming.id.trim() : crypto.randomUUID();
  // Coerce the opt-in to a strict boolean so the send-time gate can never be
  // tricked by a truthy non-boolean; stamp the decision time for provable
  // consent later. An absent/unchecked box persists as `false` (no SMS).
  const smsConsent = incoming.smsConsent === true;
  const smsConsentAt = smsConsent ? new Date().toISOString() : undefined;
  const row: Record<string, unknown> = {
    ...incoming,
    id,
    smsConsent,
    smsConsentAt,
    status: typeof incoming.status === "string" && incoming.status.trim() ? incoming.status : "pending",
    createdAt:
      typeof incoming.createdAt === "string" && incoming.createdAt.trim()
        ? incoming.createdAt
        : new Date().toISOString(),
  };
  const propertyId = typeof row["propertyId"] === "string" ? row["propertyId"] : null;
  const proposedStart = typeof row["proposedStart"] === "string" ? row["proposedStart"] : null;
  const proposedEnd = typeof row["proposedEnd"] === "string" ? row["proposedEnd"] : null;
  const requestedWindows = requestedWindowsFromRow(row);
  const isTour = textValue(row.kind) === "tour";

  if (isTour) {
    const contactErrors = validateTourContactFields({
      name: textValue(row.name),
      email: textValue(row.email),
      phone: textValue(row.phone),
    });
    if (Object.keys(contactErrors).length > 0) {
      const firstError = contactErrors.name || contactErrors.email || contactErrors.phone || "Invalid contact details.";
      return { ok: false, reason: "invalid_contact", error: firstError };
    }
    const normalizedPhone = normalizeTourContactPhone(textValue(row.phone));
    if (!normalizedPhone) {
      return { ok: false, reason: "invalid_contact", error: "Phone number must be 10 digits." };
    }
    row.phone = normalizedPhone;

    for (const window of requestedWindows) {
      const managerUserId = textValue(row.managerUserId) || textValue(window.adminUserId);
      const slotKey = textValue(window.slotKey);
      const windowPropertyId = textValue(row.propertyId);
      if (!managerUserId) {
        return { ok: false, reason: "missing_host", error: "A host is required for tour requests." };
      }
      if (!slotKey) {
        return { ok: false, reason: "missing_host", error: "Tour time slot is required." };
      }
      if (windowPropertyId) {
        const mayHost = await managerMayHostPropertyTour(db, { managerUserId, propertyId: windowPropertyId });
        const hasSlot = await managerHasPublishedSlot(db, { managerUserId, slotKey, propertyId: windowPropertyId });
        if (!mayHost || !hasSlot) {
          return { ok: false, reason: "slot_unavailable", error: "That tour host or time is not available." };
        }
      } else {
        const hasAdminSlot = await adminHasPublishedSlot(db, { adminUserId: managerUserId, slotKey });
        if (!hasAdminSlot) {
          return { ok: false, reason: "slot_unavailable", error: "That meeting host or time is not available." };
        }
      }
      if (await hasManagerTourConflict(db, managerUserId, [window])) {
        return {
          ok: false,
          reason: "conflict",
          error: "That manager already has a tour at this time. Please choose another time.",
        };
      }
    }
  }

  const { data, error: readError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", INQUIRIES_RECORD_ID)
    .maybeSingle();

  if (readError) return { ok: false, reason: "write_failed", error: readError.message };

  const existing = inquiryRowsFromRecord(data?.row_data);
  const next = [row, ...existing.filter((item) => item.id !== id)];

  const records: Record<string, unknown>[] = [
    {
      id: INQUIRIES_RECORD_ID,
      manager_user_id: null,
      property_id: propertyId,
      record_type: INQUIRIES_RECORD_ID,
      starts_at: proposedStart,
      ends_at: proposedEnd,
      row_data: {
        id: INQUIRIES_RECORD_ID,
        recordType: INQUIRIES_RECORD_ID,
        managerUserId: null,
        propertyId: null,
        payload: next,
      },
      updated_at: new Date().toISOString(),
    },
  ];

  requestedWindows.forEach((window, index) => {
    const managerUserId =
      typeof row.managerUserId === "string" && row.managerUserId.trim()
        ? row.managerUserId
        : window.adminUserId;
    records.push({
      id: `${INQUIRY_EVENT_RECORD_TYPE}_${id}_${index}`,
      manager_user_id: managerUserId || null,
      property_id: propertyId,
      record_type: INQUIRY_EVENT_RECORD_TYPE,
      starts_at: window.start,
      ends_at: window.end,
      row_data: {
        id: `${INQUIRY_EVENT_RECORD_TYPE}_${id}_${index}`,
        recordType: INQUIRY_EVENT_RECORD_TYPE,
        managerUserId: managerUserId || null,
        propertyId,
        payload: row,
      },
      updated_at: new Date().toISOString(),
    });
  });

  const { error: writeError } = await db.from("portal_schedule_records").upsert(records, { onConflict: "id" });

  if (writeError) {
    if ("code" in writeError && writeError.code === "23505") {
      return {
        ok: false,
        reason: "conflict",
        error: "That manager already has a tour at this time. Please choose another time.",
      };
    }
    return { ok: false, reason: "write_failed", error: writeError.message };
  }

  // Record the explicit opt-in into the sms_consent ledger the outbound send
  // path reads. Only when the requester checked the box AND gave a phone — an
  // unchecked box records nothing, so no marketing/notification SMS is sent.
  // A later inbound STOP still supersedes this opt-in (opted_out_at wins).
  const consentPhone = textValue(row.phone);
  if (smsConsent && consentPhone) {
    await recordOptIn(db, consentPhone, null, "tours-contact").catch(() => undefined);
  }

  if (isTour && notify) {
    const managerUserId = textValue(row.managerUserId) || textValue(requestedWindows[0]?.adminUserId);
    if (managerUserId) {
      void notifyManagerTourRequest(db, null, row, requestedWindows[0]).catch(() => undefined);
      void notifyTenantTourRequestReceived(db, null, row, requestedWindows[0]).catch(() => undefined);
      // Raise the manager's "approve this tour request" task. It moved in here
      // with the rest of the creation path so the agent's `request_tour` files
      // the same task the website form does.
      void createApproveTourRequestTask(db, managerUserId, {
        inquiryId: id,
        triggeredAt: String(row.createdAt ?? new Date().toISOString()),
        guestName: textValue(row.name),
        propertyTitle: textValue(row.propertyTitle),
        propertyId: textValue(row.propertyId),
        roomLabel: textValue(row.roomLabel),
      }).catch(() => undefined);
      // Approval-first automated tours: when the manager opted in, propose
      // confirming this inquiry into its first open slot as an approval item.
      // Best-effort — a failure here must never fail the inquiry submission,
      // and nothing books or emails the tenant until the manager approves.
      void (async () => {
        const settings = await loadManagerAutomationSettings(db, managerUserId);
        if (!settings.proposeTourConfirmations) return;
        await proposeTourConfirmation(db, { inquiry: row, managerUserId, requestedWindows });
      })().catch(() => undefined);
    }
  }

  return { ok: true, row, inquiryId: id };
}
