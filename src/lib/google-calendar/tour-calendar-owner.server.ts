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
 * The connection a create used is STORED (a `portal_schedule_records` row keyed on the planned event id,
 * the same pattern as the availability push state), and every later update, delete, cleanup and recovery resolves that
 * stored owner first, so a reschedule or cancel can never look in the wrong calendar even if the operator connects or
 * disconnects Google in between. A tour with a Google event id but no stored row predates this and lives on the house
 * owner's calendar. Nothing here reads a request body: ids come from the planned-event row and the service-owner table.
 */

const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";
export const TOUR_CALENDAR_OWNER_RECORD_TYPE = "google_tour_calendar_owner";

export const TOUR_CALENDAR_OWNER_RECORD_ID_PREFIX = "axis_gcal_tour_owner_";

export function tourCalendarOwnerRecordId(plannedEventId: string): string {
  return `${TOUR_CALENDAR_OWNER_RECORD_ID_PREFIX}${plannedEventId.trim()}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Everyone this tour's Google event may legitimately sit with: the house manager and the property's tour team (the
 * operator on a managed house included). A stored row naming anybody else is ignored — `POST /api/portal-schedule-records`
 * pins `manager_user_id` to the caller but takes the id and `row_data` from the body, so the row is only as trustworthy
 * as this check makes it. An unreadable team keeps the house manager alone.
 */
async function tourCalendarPrincipals(
  db: SupabaseClient,
  input: { plannedEventId: string; houseManagerUserId: string },
): Promise<Set<string>> {
  const allowed = new Set<string>([input.houseManagerUserId]);
  try {
    const row = await plannedEventRow(db, input.plannedEventId);
    const propertyId = row ? text(row.propertyId) : "";
    if (!propertyId) return allowed;
    const { listTourAssigneeUserIds } = await import("@/lib/tour-assignee.server");
    const team = await listTourAssigneeUserIds(db, { propertyId, fallbackOwnerUserId: input.houseManagerUserId });
    for (const id of team.userIds) if (id) allowed.add(id);
    if (team.ownerUserId) allowed.add(team.ownerUserId);
  } catch {
    return allowed;
  }
  return allowed;
}

/** The stored row for this tour, read under the house manager's own ownership and validated against its team. */
async function readValidatedOwnerRow(
  db: SupabaseClient,
  plannedEventId: string,
  houseManagerUserId: string,
): Promise<{ connectionOwnerUserId: string; assigneeUserId: string } | null> {
  const id = plannedEventId.trim();
  const manager = houseManagerUserId.trim();
  if (!id || !manager) return null;
  try {
    const { data, error } = await db
      .from("portal_schedule_records")
      .select("row_data")
      .eq("id", tourCalendarOwnerRecordId(id))
      .eq("record_type", TOUR_CALENDAR_OWNER_RECORD_TYPE)
      .eq("manager_user_id", manager)
      .maybeSingle();
    if (error || !data?.row_data || typeof data.row_data !== "object") return null;
    const row = data.row_data as Record<string, unknown>;
    const connectionOwnerUserId = text(row.connectionOwnerUserId);
    if (!connectionOwnerUserId) return null;
    const allowed = await tourCalendarPrincipals(db, { plannedEventId: id, houseManagerUserId: manager });
    if (!allowed.has(connectionOwnerUserId)) return null;
    const storedAssignee = text(row.assigneeUserId);
    return {
      connectionOwnerUserId,
      assigneeUserId: storedAssignee && allowed.has(storedAssignee) ? storedAssignee : connectionOwnerUserId,
    };
  } catch {
    return null;
  }
}

/** The stored connection owner, else `houseManagerUserId` (where every pre-existing tour event lives). */
export async function resolveStoredTourCalendarOwner(
  db: SupabaseClient,
  plannedEventId: string,
  houseManagerUserId: string,
): Promise<string> {
  return (await readValidatedOwnerRow(db, plannedEventId, houseManagerUserId))?.connectionOwnerUserId ?? houseManagerUserId;
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

/** The stored holder and assignee for a tour, or null when nothing trustworthy was recorded. */
export async function readStoredTourCalendarHolder(
  db: SupabaseClient,
  plannedEventId: string,
  houseManagerUserId: string,
): Promise<{ connectionOwnerUserId: string; assigneeUserId: string } | null> {
  return readValidatedOwnerRow(db, plannedEventId, houseManagerUserId);
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
  const stored = await readStoredTourCalendarHolder(db, input.plannedEventId, input.houseManagerUserId);
  if (stored) return { ownerUserId: stored.connectionOwnerUserId, assigneeUserId: stored.assigneeUserId, stored: true };
  if (input.existingGoogleEventId?.trim()) {
    return { ownerUserId: input.houseManagerUserId, assigneeUserId: input.houseManagerUserId, stored: false };
  }
  const holder = await resolveTourCalendarHolder(db, input);
  return { ownerUserId: holder.holderUserId, assigneeUserId: holder.assigneeUserId, stored: false };
}
