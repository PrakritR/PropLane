import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { deleteGoogleCalendarEvent } from "@/lib/google-calendar/api.server";
import { runPlannedTourCalendarSync, type PlannedTourCalendarSync } from "@/lib/google-calendar/planned-tour-sync.server";
import { syncPlannedTourToGoogleCalendar } from "@/lib/google-calendar/sync.server";
import {
  plannedTourAssigneeUserId,
  readStoredTourCalendarHolder,
  recordTourCalendarOwner,
  resolveManagedOperatorForProperty,
  resolveTourCalendarHolder,
} from "@/lib/google-calendar/tour-calendar-owner.server";
import { tourEventFactsFromRecord } from "@/lib/google-calendar/tour-event-payload";
import { resolvePropertyOwnerUserId } from "@/lib/property-owner.server";
import { listPropertyTourHostUserIds } from "@/lib/tour-host-enumeration.server";
import { PLANNED_RECORD_ID, rowsFromRecord } from "@/lib/tour-inquiry-confirm.server";
import { mutateConfirmedTourSchedule } from "@/lib/tour-schedule-persistence.server";
import { isActivePlannedTourEvent } from "@/lib/tour-slot-math";
import { normalizeAssignee, type WorkAssignee } from "@/lib/work-assignment";

/**
 * Who a confirmed tour is ASSIGNED to, and which Google calendar that puts it on.
 *
 * The assignee is the planned event's own `assignee` (a team member, `work-assignment.ts`), written only here, by
 * the confirm / manual-booking paths, and by `reassignPlannedTour`. It is never trusted from a body: every id is
 * checked against the property's team, which is the property OWNER's accepted co-managers who hold Calendar or
 * Applications at edit on the house (`listPropertyTourHostUserIds`), the owner, and, on a PropLane-managed house, the
 * platform operator. Default: the operator on a managed house, the house owner otherwise.
 */

type Db = SupabaseClient;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Everyone a tour on this property may be assigned to, as user ids. */
export async function listTourAssigneeUserIds(
  db: Db,
  input: { propertyId: string; fallbackOwnerUserId?: string },
): Promise<{ ownerUserId: string; operatorUserId: string | null; userIds: string[] }> {
  const ownerUserId = (await resolvePropertyOwnerUserId(db, input.propertyId)) ?? input.fallbackOwnerUserId?.trim() ?? "";
  const operatorUserId = await resolveManagedOperatorForProperty(db, { ownerUserId, propertyId: input.propertyId });
  const ids = new Set<string>(await listPropertyTourHostUserIds(db, { propertyId: input.propertyId, ownerUserId }));
  if (operatorUserId) ids.add(operatorUserId);
  return { ownerUserId, operatorUserId, userIds: [...ids] };
}

export async function tourAssigneeNames(db: Db, userIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return names;
  try {
    const { data } = await db.from("profiles").select("id, full_name, email").in("id", ids);
    for (const row of (data ?? []) as { id?: unknown; full_name?: unknown; email?: unknown }[]) {
      const id = text(row.id);
      if (id) names.set(id, text(row.full_name) || text(row.email) || "Team member");
    }
  } catch {
    /* names are display only */
  }
  return names;
}

/**
 * The assignee a NEW tour is written with. A supplied team assignee must be on the property's team (403 otherwise);
 * none supplied becomes the default (operator on a managed house, the house owner otherwise). An unreadable team
 * read never blocks a booking: the stored assignee is then simply left off and the resolver's own default applies.
 */
export async function resolveTourAssigneeForCreate(
  db: Db,
  input: { assignee: WorkAssignee | null; propertyId: string; hostUserId: string },
): Promise<{ ok: true; assignee: WorkAssignee | null } | { ok: false; status: number; error: string }> {
  let team: Awaited<ReturnType<typeof listTourAssigneeUserIds>>;
  try {
    team = await listTourAssigneeUserIds(db, { propertyId: input.propertyId, fallbackOwnerUserId: input.hostUserId });
  } catch {
    return { ok: true, assignee: input.assignee };
  }
  if (input.assignee) {
    if (input.assignee.type !== "team" || !team.userIds.includes(input.assignee.id)) {
      return { ok: false, status: 403, error: "That teammate cannot take tours at this property." };
    }
    return { ok: true, assignee: input.assignee };
  }
  const defaultId = team.operatorUserId || team.ownerUserId || input.hostUserId;
  if (!defaultId) return { ok: true, assignee: null };
  const names = await tourAssigneeNames(db, [defaultId]);
  return { ok: true, assignee: { type: "team", id: defaultId, name: names.get(defaultId) ?? "" } };
}

async function loadPlannedTour(
  db: Db,
  plannedEventId: string,
): Promise<{ ok: true; event: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const id = plannedEventId.trim();
  if (!id) return { ok: false, status: 400, error: "id required" };
  const { data, error } = await db.from("portal_schedule_records").select("row_data").eq("id", PLANNED_RECORD_ID).maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  const event = rowsFromRecord(data?.row_data).find((row) => text(row.id) === id);
  if (!event) return { ok: false, status: 404, error: "Tour not found." };
  if (text(event.kind) !== "tour") return { ok: false, status: 400, error: "That calendar event is not a tour." };
  return { ok: true, event };
}

type Authorized = {
  event: Record<string, unknown>;
  team: Awaited<ReturnType<typeof listTourAssigneeUserIds>>;
};

/** The actor must be an admin, the tour's host, or on the property's team: a body id is a name, never a grant. */
async function authorizeTourAssigneeActor(
  db: Db,
  input: { plannedEventId: string; actorUserId: string; isAdmin?: boolean },
): Promise<({ ok: true } & Authorized) | { ok: false; status: number; error: string }> {
  const loaded = await loadPlannedTour(db, input.plannedEventId);
  if (!loaded.ok) return loaded;
  const hostUserId = text(loaded.event.managerUserId);
  const team = await listTourAssigneeUserIds(db, { propertyId: text(loaded.event.propertyId), fallbackOwnerUserId: hostUserId });
  const allowed = input.isAdmin || input.actorUserId === hostUserId || team.userIds.includes(input.actorUserId);
  if (!allowed) return { ok: false, status: 403, error: "Unauthorized." };
  return { ok: true, event: loaded.event, team };
}

export type TourAssigneeInfo = {
  assigneeUserId: string;
  assigneeName: string;
  candidates: { id: string; name: string }[];
  /** A plain fact, only when the assignee has no calendar connected and the event sits on another one. */
  calendarNote: string | null;
};

export async function getTourAssigneeInfo(
  db: Db,
  input: { plannedEventId: string; actorUserId: string; isAdmin?: boolean },
): Promise<({ ok: true } & TourAssigneeInfo) | { ok: false; status: number; error: string }> {
  const auth = await authorizeTourAssigneeActor(db, input);
  if (!auth.ok) return auth;
  const hostUserId = text(auth.event.managerUserId);
  const stored = await readStoredTourCalendarHolder(db, input.plannedEventId);
  const fresh = stored ? null : await resolveTourCalendarHolder(db, { houseManagerUserId: hostUserId, plannedEventId: input.plannedEventId });
  const assigneeUserId = plannedTourAssigneeUserId(auth.event) || stored?.assigneeUserId || fresh?.assigneeUserId || hostUserId;
  const holderUserId = stored?.connectionOwnerUserId ?? fresh?.holderUserId ?? assigneeUserId;
  const names = await tourAssigneeNames(db, [...auth.team.userIds, assigneeUserId, holderUserId]);
  const assigneeName = names.get(assigneeUserId) ?? "Team member";
  const calendarNote =
    holderUserId !== assigneeUserId
      ? `On ${names.get(holderUserId) ?? "a teammate"}'s calendar, ${assigneeName} hasn't connected Google Calendar`
      : null;
  return {
    ok: true,
    assigneeUserId,
    assigneeName,
    candidates: auth.team.userIds.map((id) => ({ id, name: names.get(id) ?? "Team member" })),
    calendarNote,
  };
}

export type ReassignTourResult =
  | { ok: true; assignee: WorkAssignee; calendarSync: PlannedTourCalendarSync }
  | { ok: false; status: number; error: string };

/**
 * Hand a confirmed tour to another teammate and MOVE its Google event: create on the new assignee's connected
 * calendar (the operator's, then the house owner's, when they have none), then delete from the calendar that held it.
 * The new holder is stored BEFORE the write so a later reschedule or cancel always resolves it.
 */
export async function reassignPlannedTour(
  db: Db,
  input: { plannedEventId: string; actorUserId: string; isAdmin?: boolean; assigneeUserId: string },
): Promise<ReassignTourResult> {
  const auth = await authorizeTourAssigneeActor(db, input);
  if (!auth.ok) return auth;
  const { event, team } = auth;
  if (!isActivePlannedTourEvent(event)) return { ok: false, status: 409, error: "That tour is no longer active." };
  const assigneeUserId = input.assigneeUserId.trim();
  if (!assigneeUserId || !team.userIds.includes(assigneeUserId)) {
    return { ok: false, status: 403, error: "That teammate cannot take tours at this property." };
  }
  const hostUserId = text(event.managerUserId);
  const names = await tourAssigneeNames(db, [assigneeUserId]);
  const assignee: WorkAssignee = normalizeAssignee({ type: "team", id: assigneeUserId, name: names.get(assigneeUserId) ?? "" })!;
  const previous = { start: text(event.start), end: text(event.end), generation: text(event.rescheduleNotificationGeneration) || null };

  const persisted = await mutateConfirmedTourSchedule(db as never, {
    operation: "replace",
    event: { ...event, assignee },
    expected: previous,
  });
  if (!persisted.ok) {
    return {
      ok: false,
      status: persisted.reason === "not_found" ? 404 : ["conflict", "stale_event", "expected_window_required"].includes(persisted.reason) ? 409 : 500,
      error: persisted.reason,
    };
  }

  const googleEventId = text(event.googleCalendarEventId);
  const storedHolder = await readStoredTourCalendarHolder(db, input.plannedEventId);
  const oldHolderUserId = storedHolder?.connectionOwnerUserId ?? hostUserId;
  const next = await resolveTourCalendarHolder(db, { houseManagerUserId: hostUserId, plannedEventId: input.plannedEventId, assigneeUserId });

  // No Google event yet (never synced, or no calendar linked): record who holds it from now on and let the next sync write it.
  if (!googleEventId) {
    await recordTourCalendarOwner(db, { plannedEventId: input.plannedEventId, houseManagerUserId: hostUserId, connectionOwnerUserId: next.holderUserId, assigneeUserId });
    return { ok: true, assignee, calendarSync: { ok: true, skipped: true } };
  }
  if (next.holderUserId === oldHolderUserId) {
    await recordTourCalendarOwner(db, { plannedEventId: input.plannedEventId, houseManagerUserId: hostUserId, connectionOwnerUserId: oldHolderUserId, assigneeUserId });
    return { ok: true, assignee, calendarSync: { ok: true, skipped: true } };
  }

  await recordTourCalendarOwner(db, { plannedEventId: input.plannedEventId, houseManagerUserId: hostUserId, connectionOwnerUserId: next.holderUserId, assigneeUserId });
  let createdId: string | null = null;
  const calendarSync = await runPlannedTourCalendarSync(async () => {
    const result = await syncPlannedTourToGoogleCalendar(db, hostUserId, {
      plannedEventId: input.plannedEventId,
      title: text(event.title) || "Tour",
      start: previous.start,
      end: previous.end,
      propertyTitle: text(event.propertyTitle) || undefined,
      ...tourEventFactsFromRecord(event),
      attendeeName: text(event.attendeeName) || undefined,
      attendeeEmail: text(event.attendeeEmail) || undefined,
      attendeePhone: text(event.attendeePhone) || undefined,
      notes: text(event.notes) || undefined,
      instructions: text(event.instructions) || undefined,
      // null: this is a CREATE on the new holder's calendar, not an update of the old one's event.
      googleCalendarEventId: null,
    });
    createdId = typeof result === "string" ? result : null;
    return result;
  });
  if (createdId) {
    try {
      await deleteGoogleCalendarEvent(db, oldHolderUserId, googleEventId);
    } catch (error) {
      return { ok: true, assignee, calendarSync: { ok: false, error: error instanceof Error ? error.message : "Could not remove the old calendar event." } };
    }
  } else {
    // Nothing landed on the new calendar: the old event stays where it was, and the record says so.
    await recordTourCalendarOwner(db, { plannedEventId: input.plannedEventId, houseManagerUserId: hostUserId, connectionOwnerUserId: oldHolderUserId, assigneeUserId });
  }
  return { ok: true, assignee, calendarSync };
}
