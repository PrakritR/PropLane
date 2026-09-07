import "server-only";

import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { syncWorkOrderToGoogleCalendar } from "@/lib/google-calendar/sync.server";
import { formatPreferredArrival, parsePreferredArrival, PREFERRED_ARRIVAL_PRESETS } from "@/lib/preferred-arrival";
import { RESIDENT_WORK_ORDER_REMINDER_COOLDOWN_MS } from "@/lib/resident-work-order-reminder-email";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

/**
 * The resident's own work-order lifecycle, server-side: edit, cancel, and the
 * "may I nudge?" cooldown read. Shared by the resident assistant's
 * `update_work_order` / `cancel_work_order` / `nudge_manager_on_work_order`
 * tools and `POST /api/portal-work-orders` (whose delete branch is the same
 * transition `deleteWorkOrderRecord` runs), so chat and the Services panel can
 * never disagree about what a resident may change or when a request is gone.
 *
 * Every read here scopes on the `resident_email` COLUMN — the only resident
 * identity `portal_work_order_records` carries (AGENTS.md, "Resident row
 * scoping is not uniform") — never on the `row_data.residentEmail` copy.
 */

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

export type ResidentWorkOrderRecord = {
  id: string;
  manager_user_id: string | null;
  resident_email: string | null;
  property_id: string | null;
  assigned_property_id: string | null;
  row_data: DemoManagerWorkOrderRow;
};

export type ResidentWorkOrderScope = {
  workOrderId: string;
  /** Normalized lowercase email of the authenticated resident. */
  residentEmail: string;
  /** SMS sessions pin one manager; portal sessions leave this unset. */
  activeManagerId?: string;
};

/** Load ONE of the resident's own work orders, or null when it is not theirs. */
export async function loadResidentOwnWorkOrder(
  db: ServiceClient,
  scope: ResidentWorkOrderScope,
): Promise<ResidentWorkOrderRecord | null> {
  const workOrderId = scope.workOrderId.trim();
  const residentEmail = scope.residentEmail.trim().toLowerCase();
  // An empty identity must match nothing — never an unscoped read.
  if (!workOrderId || !residentEmail) return null;
  let query = db
    .from("portal_work_order_records")
    .select("id, manager_user_id, resident_email, property_id, assigned_property_id, row_data")
    .eq("id", workOrderId)
    .eq("resident_email", residentEmail);
  if (scope.activeManagerId) query = query.eq("manager_user_id", scope.activeManagerId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || !data.row_data) return null;
  return {
    id: String(data.id),
    manager_user_id: (data.manager_user_id as string | null) ?? null,
    resident_email: (data.resident_email as string | null) ?? null,
    property_id: (data.property_id as string | null) ?? null,
    assigned_property_id: (data.assigned_property_id as string | null) ?? null,
    row_data: data.row_data as DemoManagerWorkOrderRow,
  };
}

/**
 * The Services panel only offers Edit / Cancel / Send reminder while the
 * request is still in the `open` bucket (`WorkOrderDetail.canModify`). A
 * scheduled or completed request is the manager's to change.
 */
export function residentWorkOrderIsOpen(row: DemoManagerWorkOrderRow): boolean {
  return row.bucket === "open";
}

/** Copy for a request the resident can no longer modify, phrased the way the portal does. */
export function residentWorkOrderClosedReason(row: DemoManagerWorkOrderRow): string {
  if (row.bucket === "completed") return "That request is already completed, so it can no longer be changed.";
  if (row.bucket === "scheduled") {
    return "That request has already been scheduled by your property manager, so it can no longer be changed from your side.";
  }
  return "That request can no longer be changed.";
}

/** Milliseconds until the resident may nudge the manager again; 0 when allowed now. */
export function residentWorkOrderReminderCooldownRemainingMs(row: DemoManagerWorkOrderRow, now = Date.now()): number {
  const sentAt = row.residentReminderSentAt?.trim();
  if (!sentAt) return 0;
  const ts = Date.parse(sentAt);
  if (!Number.isFinite(ts)) return 0;
  const elapsed = now - ts;
  if (elapsed >= RESIDENT_WORK_ORDER_REMINDER_COOLDOWN_MS) return 0;
  return RESIDENT_WORK_ORDER_REMINDER_COOLDOWN_MS - elapsed;
}

/** The priorities the panel's edit form offers, verbatim. */
export const RESIDENT_WORK_ORDER_PRIORITIES = ["Emergency", "Low", "Medium", "High"] as const;
export type ResidentWorkOrderPriority = (typeof RESIDENT_WORK_ORDER_PRIORITIES)[number];

/**
 * Normalize a free-text visit window the way the panel's `PreferredArrivalField`
 * stores it: a preset name (matched case-insensitively) is stored as the preset,
 * anything else is the custom text, and blank means "Anytime".
 */
export function normalizePreferredArrival(value: string): string {
  const trimmed = value.trim();
  const preset = PREFERRED_ARRIVAL_PRESETS.find((p) => p.toLowerCase() === trimmed.toLowerCase());
  if (preset) return preset;
  const parsed = parsePreferredArrival(trimmed);
  return formatPreferredArrival(parsed.preset, parsed.custom);
}

/**
 * Exactly the fields the resident Services panel's "Edit service" modal lets a
 * resident change (`saveWorkOrderEdit`): title, priority, preferred arrival,
 * entry permission, entry notes, and details. Nothing else on the row is
 * resident-editable — category, scheduling, vendor, and cost stay the manager's.
 */
export type ResidentWorkOrderPatch = {
  title?: string;
  priority?: ResidentWorkOrderPriority;
  preferredArrival?: string;
  entryPermission?: DemoManagerWorkOrderRow["entryPermission"];
  /** Empty string clears the notes, matching the form's `trim() || undefined`. */
  entryNotes?: string;
  description?: string;
};

/** Apply a patch the way `saveWorkOrderEdit` does; pure so preview and handler agree. */
export function applyResidentWorkOrderPatch(
  row: DemoManagerWorkOrderRow,
  patch: ResidentWorkOrderPatch,
): DemoManagerWorkOrderRow {
  const next: DemoManagerWorkOrderRow = { ...row };
  if (patch.title !== undefined && patch.title.trim()) next.title = patch.title.trim();
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.preferredArrival !== undefined) next.preferredArrival = normalizePreferredArrival(patch.preferredArrival);
  if (patch.entryPermission !== undefined) next.entryPermission = patch.entryPermission;
  if (patch.entryNotes !== undefined) {
    const notes = patch.entryNotes.trim();
    if (notes) next.entryNotes = notes;
    else delete next.entryNotes;
  }
  // The form keeps the old description when the field is blanked.
  if (patch.description !== undefined && patch.description.trim()) next.description = patch.description.trim();
  return next;
}

export type ResidentWorkOrderWriteResult =
  | { ok: true; row: DemoManagerWorkOrderRow }
  | { ok: false; error: string; code: "not_found" | "closed" | "write_failed" };

/**
 * Edit one of the resident's own OPEN work orders. The scope columns are
 * pinned to the existing record — a resident edit never re-stamps the manager,
 * property, or `resident_email` — and `row_data` is read-merge-written so the
 * server-owned `dispatch` block survives untouched.
 */
export async function updateResidentWorkOrder(
  db: ServiceClient,
  scope: ResidentWorkOrderScope,
  patch: ResidentWorkOrderPatch,
): Promise<ResidentWorkOrderWriteResult> {
  const record = await loadResidentOwnWorkOrder(db, scope);
  if (!record) return { ok: false, error: "That is not one of your maintenance requests.", code: "not_found" };
  if (!residentWorkOrderIsOpen(record.row_data)) {
    return { ok: false, error: residentWorkOrderClosedReason(record.row_data), code: "closed" };
  }
  const nextRow = applyResidentWorkOrderPatch(record.row_data, patch);
  const { error } = await db.from("portal_work_order_records").upsert(
    {
      id: record.id,
      manager_user_id: record.manager_user_id,
      resident_email: record.resident_email,
      property_id: record.property_id,
      assigned_property_id: record.assigned_property_id,
      row_data: nextRow,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) return { ok: false, error: error.message, code: "write_failed" };
  return { ok: true, row: nextRow };
}

/**
 * The one delete transition for a work-order record: release its calendar
 * hold (the row is marked completed on the manager's Google Calendar so a
 * synced event does not linger), then remove the row. `POST
 * /api/portal-work-orders` `action: "delete"` and the resident cancel path
 * both run this, after their own authorization.
 */
export async function deleteWorkOrderRecord(
  db: ServiceClient,
  existing: { id: string; manager_user_id: string | null; row_data: DemoManagerWorkOrderRow | null },
): Promise<{ error: string | null }> {
  const row = existing.row_data;
  const managerUserId = existing.manager_user_id ?? row?.managerUserId ?? null;
  if (row && managerUserId) {
    await syncWorkOrderToGoogleCalendar(db, managerUserId, { ...row, bucket: "completed", scheduledAtIso: undefined }).catch(
      () => undefined,
    );
  }
  const { error } = await db.from("portal_work_order_records").delete().eq("id", existing.id);
  return { error: error ? error.message : null };
}

/**
 * Cancel one of the resident's own OPEN work orders. This is what the Services
 * panel's "Cancel service" does — `deleteManagerWorkOrderRow` mirrored as
 * `action: "delete"` — so the request is REMOVED, not flagged; there is no
 * cancelled status on this model.
 */
export async function cancelResidentWorkOrder(
  db: ServiceClient,
  scope: ResidentWorkOrderScope,
): Promise<ResidentWorkOrderWriteResult> {
  const record = await loadResidentOwnWorkOrder(db, scope);
  if (!record) return { ok: false, error: "That is not one of your maintenance requests.", code: "not_found" };
  if (!residentWorkOrderIsOpen(record.row_data)) {
    return { ok: false, error: residentWorkOrderClosedReason(record.row_data), code: "closed" };
  }
  const { error } = await deleteWorkOrderRecord(db, record);
  if (error) return { ok: false, error, code: "write_failed" };
  return { ok: true, row: record.row_data };
}
