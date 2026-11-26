import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadGoogleCalendarConnection } from "@/lib/google-calendar/settings";

/**
 * Whose Google connection holds a tour's calendar event.
 *
 * A tour on a house in a PropLane-managed (`portal_workspaces.is_service`) workspace is RUN by PropLane's operator, the
 * platform service owner (primary admin), not by the client who still owns the house row. Its Google event therefore
 * goes to the operator's connection (their dedicated "PropLane" calendar), falling back to the house owner's connection
 * only when the operator has none linked. A self-serve house is unchanged: the house owner's connection.
 *
 * The connection a create used is STORED (a server-owned `portal_schedule_records` row keyed on the planned event id,
 * the same pattern as the availability push state), and every later update, delete, cleanup and recovery resolves that
 * stored owner first, so a reschedule or cancel can never look in the wrong calendar even if the operator connects or
 * disconnects Google in between. A tour with a Google event id but no stored row predates this and lives on the house
 * owner's calendar. Nothing here reads a request body: ids come from the planned-event row and the service-owner table.
 */

const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";
export const TOUR_CALENDAR_OWNER_RECORD_TYPE = "google_tour_calendar_owner";

export function tourCalendarOwnerRecordId(plannedEventId: string): string {
  return `axis_gcal_tour_owner_${plannedEventId.trim()}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The connection owner a create stored for this tour, or null (never stored, or unreadable). */
export async function readStoredTourCalendarOwner(db: SupabaseClient, plannedEventId: string): Promise<string | null> {
  const id = plannedEventId.trim();
  if (!id) return null;
  try {
    const { data, error } = await db
      .from("portal_schedule_records")
      .select("row_data")
      .eq("id", tourCalendarOwnerRecordId(id))
      .maybeSingle();
    if (error || !data?.row_data || typeof data.row_data !== "object") return null;
    return text((data.row_data as Record<string, unknown>).connectionOwnerUserId) || null;
  } catch {
    return null;
  }
}

/** The stored connection owner, else `fallbackUserId` (the house manager: where every pre-existing tour event lives). */
export async function resolveStoredTourCalendarOwner(
  db: SupabaseClient,
  plannedEventId: string,
  fallbackUserId: string,
): Promise<string> {
  return (await readStoredTourCalendarOwner(db, plannedEventId)) ?? fallbackUserId;
}

export async function recordTourCalendarOwner(
  db: SupabaseClient,
  input: {
    plannedEventId: string;
    houseManagerUserId: string;
    connectionOwnerUserId: string;
    /** Who the tour is assigned to; differs from the connection owner when the assignee had no calendar linked. */
    assigneeUserId?: string;
  },
): Promise<void> {
  const { error } = await db.from("portal_schedule_records").upsert(
    {
      id: tourCalendarOwnerRecordId(input.plannedEventId),
      manager_user_id: input.houseManagerUserId,
      property_id: null,
      record_type: TOUR_CALENDAR_OWNER_RECORD_TYPE,
      row_data: {
        recordType: TOUR_CALENDAR_OWNER_RECORD_TYPE,
        plannedEventId: input.plannedEventId,
        connectionOwnerUserId: input.connectionOwnerUserId,
        assigneeUserId: input.assigneeUserId ?? input.connectionOwnerUserId,
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) throw new Error(error.message);
}

/** The stored holder and assignee for a tour, or null when nothing was ever recorded. */
export async function readStoredTourCalendarHolder(
  db: SupabaseClient,
  plannedEventId: string,
): Promise<{ connectionOwnerUserId: string; assigneeUserId: string } | null> {
  const id = plannedEventId.trim();
  if (!id) return null;
  try {
    const { data } = await db.from("portal_schedule_records").select("row_data").eq("id", tourCalendarOwnerRecordId(id)).maybeSingle();
    const row = data?.row_data as Record<string, unknown> | null | undefined;
    const connectionOwnerUserId = text(row?.connectionOwnerUserId);
    if (!connectionOwnerUserId) return null;
    return { connectionOwnerUserId, assigneeUserId: text(row?.assigneeUserId) || connectionOwnerUserId };
  } catch {
    return null;
  }
}

async function plannedEventRow(db: SupabaseClient, plannedEventId: string): Promise<Record<string, unknown> | null> {
  const { data } = await db.from("portal_schedule_records").select("row_data").eq("id", PLANNED_RECORD_ID).maybeSingle();
  const payload = (data?.row_data as { payload?: unknown } | null)?.payload;
  const rows = Array.isArray(payload) ? payload : [];
  const row = rows.find((r) => r && typeof r === "object" && text((r as Record<string, unknown>).id) === plannedEventId);
  return row ? (row as Record<string, unknown>) : null;
}

/** The team member a planned tour is assigned to (`assignee`, type team), or "" when none is recorded. */
export function plannedTourAssigneeUserId(event: Record<string, unknown> | null | undefined): string {
  const assignee = event?.assignee as { type?: unknown; id?: unknown } | null | undefined;
  if (!assignee || typeof assignee !== "object") return "";
  return assignee.type === "vendor" ? "" : text(assignee.id);
}

/**
 * The platform service owner when `propertyId` sits in a PropLane-managed workspace of `ownerUserId`, else null.
 * Fails closed: anything unreadable answers null, which keeps the house owner's connection.
 */
export async function resolveManagedOperatorForProperty(
  db: SupabaseClient,
  input: { ownerUserId: string; propertyId: string },
): Promise<string | null> {
  try {
    if (!input.propertyId || !input.ownerUserId) return null;
    const { resolveManagerAssistantWorkspace } = await import("@/lib/communication/manager-assistant-workspace.server");
    const { isManagedWorkspaceId } = await import("@/lib/service/service-alert-targets.server");
    const { platformServiceOwnerId } = await import("@/lib/service/service-owner.server");
    const workspace = await resolveManagerAssistantWorkspace(db, input.ownerUserId, { propertyId: input.propertyId });
    if (!(await isManagedWorkspaceId(db, workspace.workspaceId))) return null;
    return await platformServiceOwnerId(db);
  } catch {
    return null;
  }
}

/** Kept for callers that only hold the planned event id. */
export async function resolveManagedTourOperator(
  db: SupabaseClient,
  input: { houseManagerUserId: string; plannedEventId: string },
): Promise<string | null> {
  try {
    const row = await plannedEventRow(db, input.plannedEventId);
    return await resolveManagedOperatorForProperty(db, {
      ownerUserId: input.houseManagerUserId,
      propertyId: row ? text(row.propertyId) : "",
    });
  } catch {
    return null;
  }
}

async function hasLiveConnection(db: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const connection = await loadGoogleCalendarConnection(db, userId);
    return connection.connected && connection.syncEnabled;
  } catch {
    return false;
  }
}

export type TourCalendarHolder = {
  /** Who the tour is assigned to (the stored assignee, else the default). */
  assigneeUserId: string;
  /** Whose Google connection the event is written to. */
  holderUserId: string;
  /** True when the assignee has no connected calendar and the event sits on another one. */
  fellBack: boolean;
};

/**
 * Where a tour's Google event should live right now, from the assignee. The assignee is the planned event's own
 * `assignee` (server-validated team member); with none recorded it is the operator on a managed house and the house
 * owner otherwise. The event goes on the assignee's connected calendar; with none connected it falls back to the
 * operator's (managed house), then to the house owner's, which is where tours lived before assignees.
 */
export async function resolveTourCalendarHolder(
  db: SupabaseClient,
  input: { houseManagerUserId: string; plannedEventId: string; assigneeUserId?: string },
): Promise<TourCalendarHolder> {
  const row = await plannedEventRow(db, input.plannedEventId).catch(() => null);
  const propertyId = row ? text(row.propertyId) : "";
  const operator = await resolveManagedOperatorForProperty(db, { ownerUserId: input.houseManagerUserId, propertyId });
  const assigneeUserId =
    input.assigneeUserId?.trim() || plannedTourAssigneeUserId(row) || operator || input.houseManagerUserId;
  if (await hasLiveConnection(db, assigneeUserId)) return { assigneeUserId, holderUserId: assigneeUserId, fellBack: false };
  if (operator && operator !== assigneeUserId && (await hasLiveConnection(db, operator))) {
    return { assigneeUserId, holderUserId: operator, fellBack: true };
  }
  return { assigneeUserId, holderUserId: input.houseManagerUserId, fellBack: input.houseManagerUserId !== assigneeUserId };
}

/**
 * The connection owner a tour's Google write goes to. The stored owner wins (so a reschedule or cancel always
 * finds the calendar the create used); an event that already has a Google id but no stored owner is legacy (house
 * owner's calendar); otherwise the assignee's calendar with the operator / house owner fallback.
 */
export async function resolveTourCalendarConnectionOwner(
  db: SupabaseClient,
  input: { houseManagerUserId: string; plannedEventId: string; existingGoogleEventId?: string | null },
): Promise<{ ownerUserId: string; assigneeUserId: string; stored: boolean }> {
  const stored = await readStoredTourCalendarHolder(db, input.plannedEventId);
  if (stored) return { ownerUserId: stored.connectionOwnerUserId, assigneeUserId: stored.assigneeUserId, stored: true };
  if (input.existingGoogleEventId?.trim()) {
    return { ownerUserId: input.houseManagerUserId, assigneeUserId: input.houseManagerUserId, stored: false };
  }
  const holder = await resolveTourCalendarHolder(db, input);
  return { ownerUserId: holder.holderUserId, assigneeUserId: holder.assigneeUserId, stored: false };
}
