import { beforeEach, describe, expect, it, vi } from "vitest";

const google = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  connection: vi.fn(),
}));
const managed = vi.hoisted(() => ({ isManaged: vi.fn(), operator: vi.fn() }));
vi.mock("@/lib/google-calendar/api.server", () => ({
  createGoogleCalendarEvent: google.create,
  updateGoogleCalendarEvent: google.update,
  deleteGoogleCalendarEvent: google.remove,
  GoogleCalendarWriteSupersededError: class extends Error {},
  GOOGLE_CALENDAR_WRITE_OPERATION_TIMEOUT_MS: 5000,
}));
vi.mock("@/lib/google-calendar/settings", () => ({ loadGoogleCalendarConnection: google.connection }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({
  resolveManagerAssistantWorkspace: vi.fn(async () => ({ workspaceId: "ws-1", isDefault: false })),
}));
vi.mock("@/lib/service/service-alert-targets.server", () => ({ isManagedWorkspaceId: managed.isManaged }));
vi.mock("@/lib/service/service-owner.server", () => ({ platformServiceOwnerId: managed.operator }));

import {
  deleteProplaneGoogleCalendarEvent,
  syncPlannedTourToGoogleCalendar,
} from "@/lib/google-calendar/sync.server";

const HOUSE_OWNER = "client-owner";
const OPERATOR = "operator-admin";
const PLANNED = {
  id: "planned-1",
  propertyId: "prop-1",
  googleCalendarEventId: undefined as string | undefined,
};

/** A tiny in-memory portal_schedule_records. */
function makeDb(planned = PLANNED) {
  const rows = new Map<string, Record<string, unknown>>();
  rows.set("axis_admin_planned_events_v1", { id: "axis_admin_planned_events_v1", row_data: { payload: [planned] } });
  const db = {
    rows,
    rpc: vi.fn(async (name: string) => {
      if (name === "begin_prospect_tour_google_calendar_write") return { data: { allowed: true, generation: "g1" }, error: null };
      if (name === "validate_prospect_tour_google_calendar_write") return { data: true, error: null };
      if (name === "persist_confirmed_tour_google_calendar_id") return { data: { ok: true }, error: null };
      return { data: null, error: null };
    }),
    from: vi.fn((table: string) => {
      let id = "";
      const filters: [string, string][] = [];
      const q: Record<string, unknown> = {};
      q.select = () => q;
      // Every filter ANDs, as PostgREST does: a row is returned only when it matches all of them.
      q.eq = (c: string, v: string) => { filters.push([c, v]); if (c === "id") id = v; return q; };
      q.maybeSingle = async () => {
        const row = table === "portal_schedule_records" ? rows.get(id) ?? null : null;
        const matches = row ? filters.every(([c, v]) => c === "id" || (row as Record<string, unknown>)[c] === v) : false;
        return { data: matches ? row : null, error: null };
      };
      q.upsert = async (row: Record<string, unknown>) => { rows.set(String(row.id), row); return { error: null }; };
      q.delete = () => q;
      q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve);
      return q;
    }),
  };
  return db;
}

const facts = (googleCalendarEventId?: string) => ({
  plannedEventId: "planned-1",
  title: "Tour",
  start: "2099-09-10T17:00:00.000Z",
  end: "2099-09-10T17:30:00.000Z",
  googleCalendarEventId,
});

function connectionFor(connected: Record<string, boolean>) {
  return async (_db: unknown, uid: string) => ({ connected: connected[uid] === true, syncEnabled: connected[uid] === true });
}

describe("managed-house tours write to the PropLane operator's Google connection", () => {
  beforeEach(() => {
    for (const fn of Object.values(google)) fn.mockReset();
    managed.isManaged.mockReset().mockResolvedValue(true);
    managed.operator.mockReset().mockResolvedValue(OPERATOR);
    google.create.mockResolvedValue("g-event-1");
    google.update.mockResolvedValue("g-event-1");
    google.remove.mockResolvedValue(undefined);
  });

  it("managed house: create goes to the operator connection and the owner is stored", async () => {
    google.connection.mockImplementation(connectionFor({ [OPERATOR]: true, [HOUSE_OWNER]: true }));
    const db = makeDb();
    await syncPlannedTourToGoogleCalendar(db as never, HOUSE_OWNER, facts());
    expect(google.create).toHaveBeenCalledOnce();
    expect(google.create.mock.calls[0]?.[1]).toBe(OPERATOR);
    expect((db.rows.get("axis_gcal_tour_owner_planned-1")?.row_data as { connectionOwnerUserId: string }).connectionOwnerUserId).toBe(OPERATOR);
  });

  it("self-serve house: create goes to the owner connection and nothing is stored", async () => {
    managed.isManaged.mockResolvedValue(false);
    google.connection.mockImplementation(connectionFor({ [OPERATOR]: true, [HOUSE_OWNER]: true }));
    const db = makeDb();
    await syncPlannedTourToGoogleCalendar(db as never, HOUSE_OWNER, facts());
    expect(google.create.mock.calls[0]?.[1]).toBe(HOUSE_OWNER);
    expect(db.rows.has("axis_gcal_tour_owner_planned-1")).toBe(false);
  });

  it("managed house with no operator connection falls back to the owner", async () => {
    google.connection.mockImplementation(connectionFor({ [HOUSE_OWNER]: true }));
    const db = makeDb();
    await syncPlannedTourToGoogleCalendar(db as never, HOUSE_OWNER, facts());
    expect(google.create.mock.calls[0]?.[1]).toBe(HOUSE_OWNER);
    // The event sits on the owner's calendar, but the tour stays assigned to the operator (the fallback note reads this).
    expect(db.rows.get("axis_gcal_tour_owner_planned-1")?.row_data).toMatchObject({ connectionOwnerUserId: HOUSE_OWNER, assigneeUserId: OPERATOR });
  });

  it("update uses the stored connection even after the operator disconnects, and a legacy event stays on the owner", async () => {
    google.connection.mockImplementation(connectionFor({ [OPERATOR]: true, [HOUSE_OWNER]: true }));
    const db = makeDb();
    await syncPlannedTourToGoogleCalendar(db as never, HOUSE_OWNER, facts());
    google.create.mockClear();
    google.connection.mockImplementation(connectionFor({ [OPERATOR]: true, [HOUSE_OWNER]: true }));
    await syncPlannedTourToGoogleCalendar(db as never, HOUSE_OWNER, facts("g-event-1"));
    expect(google.update).toHaveBeenCalledOnce();
    expect(google.update.mock.calls[0]?.[1]).toBe(OPERATOR);

    google.update.mockClear();
    const legacy = makeDb();
    await syncPlannedTourToGoogleCalendar(legacy as never, HOUSE_OWNER, facts("g-legacy"));
    expect(google.update.mock.calls[0]?.[1]).toBe(HOUSE_OWNER);
  });

  it("delete resolves the stored connection; unstored deletes use the house manager", async () => {
    google.connection.mockImplementation(connectionFor({ [OPERATOR]: true, [HOUSE_OWNER]: true }));
    const db = makeDb({ ...PLANNED, googleCalendarEventId: "g-event-1" });
    // The row as `recordTourCalendarOwner` writes it: the house manager's own stamp and the owner record type.
    db.rows.set("axis_gcal_tour_owner_planned-1", {
      id: "axis_gcal_tour_owner_planned-1",
      manager_user_id: HOUSE_OWNER,
      record_type: "google_tour_calendar_owner",
      row_data: { connectionOwnerUserId: OPERATOR },
    });
    await deleteProplaneGoogleCalendarEvent(db as never, HOUSE_OWNER, "g-event-1");
    expect(google.remove).toHaveBeenCalledWith(db, OPERATOR, "g-event-1");

    google.remove.mockClear();
    const plain = makeDb({ ...PLANNED, googleCalendarEventId: "g-event-1" });
    await deleteProplaneGoogleCalendarEvent(plain as never, HOUSE_OWNER, "g-event-1");
    expect(google.remove).toHaveBeenCalledWith(plain, HOUSE_OWNER, "g-event-1");
  });
  // A teammate who held the tour and then lost the property: the event is still on THEIR calendar, so the delete must
  // look there (the pinned row says so), while a new write is never sent to someone outside the tour team.
  it("a holder who left the team still gets the delete, but not a new write", async () => {
    google.connection.mockImplementation(connectionFor({ [OPERATOR]: true, [HOUSE_OWNER]: true, "former-teammate": true }));
    const pinned = {
      id: "axis_gcal_tour_owner_planned-1",
      manager_user_id: HOUSE_OWNER,
      record_type: "google_tour_calendar_owner",
      row_data: { connectionOwnerUserId: "former-teammate" },
    };
    const db = makeDb({ ...PLANNED, googleCalendarEventId: "g-event-1" });
    db.rows.set(pinned.id, pinned);
    await deleteProplaneGoogleCalendarEvent(db as never, HOUSE_OWNER, "g-event-1");
    expect(google.remove).toHaveBeenCalledWith(db, "former-teammate", "g-event-1");

    const fresh = makeDb();
    fresh.rows.set(pinned.id, pinned);
    await syncPlannedTourToGoogleCalendar(fresh as never, HOUSE_OWNER, facts());
    expect(google.create).toHaveBeenCalledOnce();
    expect(google.create.mock.calls[0]?.[1]).not.toBe("former-teammate");
  });
  // Reschedule after the holder left the team, then cancel: the old event is retired from the former holder's
  // calendar, exactly one event is written to the house manager's, the stored row names the house manager, and the
  // cancel then deletes from the house manager's calendar.
  it("a reschedule moves the event off a holder who left the team, and the cancel follows it", async () => {
    managed.isManaged.mockResolvedValue(false);
    google.connection.mockImplementation(connectionFor({ [HOUSE_OWNER]: true, "former-teammate": true }));
    google.create.mockResolvedValue("g-event-2");
    const db = makeDb({ ...PLANNED, googleCalendarEventId: "g-event-1" });
    db.rows.set("axis_gcal_tour_owner_planned-1", {
      id: "axis_gcal_tour_owner_planned-1",
      manager_user_id: HOUSE_OWNER,
      record_type: "google_tour_calendar_owner",
      row_data: { connectionOwnerUserId: "former-teammate", assigneeUserId: "former-teammate" },
    });

    await syncPlannedTourToGoogleCalendar(db as never, HOUSE_OWNER, facts("g-event-1"));
    expect(google.remove).toHaveBeenCalledWith(db, "former-teammate", "g-event-1");
    expect(google.update).not.toHaveBeenCalled();
    expect(google.create).toHaveBeenCalledOnce();
    expect(google.create.mock.calls[0]?.[1]).toBe(HOUSE_OWNER);
    expect(db.rows.get("axis_gcal_tour_owner_planned-1")?.row_data).toMatchObject({ connectionOwnerUserId: HOUSE_OWNER });

    google.remove.mockClear();
    await deleteProplaneGoogleCalendarEvent(db as never, HOUSE_OWNER, "g-event-2");
    expect(google.remove).toHaveBeenCalledWith(db, HOUSE_OWNER, "g-event-2");
  });

  it("a revoked former holder still has the stored row moved to the new holder", async () => {
    managed.isManaged.mockResolvedValue(false);
    google.connection.mockImplementation(connectionFor({ [HOUSE_OWNER]: true }));
    google.remove.mockRejectedValue(new Error("invalid_grant"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = makeDb({ ...PLANNED, googleCalendarEventId: "g-event-1" });
    db.rows.set("axis_gcal_tour_owner_planned-1", {
      id: "axis_gcal_tour_owner_planned-1",
      manager_user_id: HOUSE_OWNER,
      record_type: "google_tour_calendar_owner",
      row_data: { connectionOwnerUserId: "former-teammate" },
    });
    await syncPlannedTourToGoogleCalendar(db as never, HOUSE_OWNER, facts("g-event-1"));
    expect(google.create.mock.calls[0]?.[1]).toBe(HOUSE_OWNER);
    expect(db.rows.get("axis_gcal_tour_owner_planned-1")?.row_data).toMatchObject({ connectionOwnerUserId: HOUSE_OWNER });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
