import { beforeEach, describe, expect, it, vi } from "vitest";

const google = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), remove: vi.fn(), connection: vi.fn() }));
const team = vi.hoisted(() => ({
  owner: vi.fn(),
  hosts: vi.fn(),
  managed: vi.fn(),
  operator: vi.fn(),
}));
vi.mock("@/lib/google-calendar/api.server", () => ({
  createGoogleCalendarEvent: google.create,
  updateGoogleCalendarEvent: google.update,
  deleteGoogleCalendarEvent: google.remove,
  GoogleCalendarWriteSupersededError: class extends Error {},
  GOOGLE_CALENDAR_WRITE_OPERATION_TIMEOUT_MS: 5000,
}));
vi.mock("@/lib/google-calendar/settings", () => ({ loadGoogleCalendarConnection: google.connection }));
vi.mock("@/lib/property-owner.server", () => ({ resolvePropertyOwnerUserId: team.owner }));
vi.mock("@/lib/tour-host-enumeration.server", () => ({ listPropertyTourHostUserIds: team.hosts }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({
  resolveManagerAssistantWorkspace: vi.fn(async () => ({ workspaceId: "ws-1", isDefault: false })),
}));
vi.mock("@/lib/service/service-alert-targets.server", () => ({ isManagedWorkspaceId: team.managed }));
vi.mock("@/lib/service/service-owner.server", () => ({ platformServiceOwnerId: team.operator }));
vi.mock("@/lib/tour-schedule-persistence.server", () => ({
  mutateConfirmedTourSchedule: vi.fn(async (db: { rows: Map<string, { row_data: { payload: Record<string, unknown>[] } }> }, m: { event: Record<string, unknown> }) => {
    const rec = db.rows.get("axis_admin_planned_events_v1")!;
    rec.row_data.payload = rec.row_data.payload.map((r) => (r.id === m.event.id ? m.event : r));
    return { ok: true };
  }),
}));

import { syncPlannedTourToGoogleCalendar } from "@/lib/google-calendar/sync.server";
import {
  getTourAssigneeInfo,
  listTourAssigneeCandidatesForProperty,
  reassignPlannedTour,
  resolveTourAssigneeForCreate,
} from "@/lib/tour-assignee.server";

const AMBIKA = "ambika-owner";
const PRAKRIT = "prakrit-operator";
const OUTSIDER = "stranger";
const START = "2099-09-10T17:00:00.000Z";
const END = "2099-09-10T17:30:00.000Z";

type Row = Record<string, unknown>;

function makeDb(planned: Row) {
  const rows = new Map<string, { id: string; row_data: { payload: Row[] } & Row }>();
  rows.set("axis_admin_planned_events_v1", { id: "axis_admin_planned_events_v1", row_data: { payload: [planned] } });
  return {
    rows,
    rpc: vi.fn(async (name: string) => {
      if (name === "begin_prospect_tour_google_calendar_write") return { data: { allowed: true, generation: "g1" }, error: null };
      if (name === "validate_prospect_tour_google_calendar_write") return { data: true, error: null };
      if (name === "persist_confirmed_tour_google_calendar_id") return { data: { ok: true }, error: null };
      return { data: null, error: null };
    }),
    from: vi.fn((table: string) => {
      let id = "";
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.in = () => Promise.resolve({
        data: table === "profiles" ? [{ id: AMBIKA, full_name: "Ambika" }, { id: PRAKRIT, full_name: "Prakrit" }] : [],
        error: null,
      });
      q.eq = (_c: string, v: string) => { id = v; return q; };
      q.maybeSingle = async () => ({ data: table === "portal_schedule_records" ? rows.get(id) ?? null : null, error: null });
      q.upsert = async (row: Row & { id: string }) => { rows.set(row.id, row as never); return { error: null }; };
      q.delete = () => q;
      q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve);
      return q;
    }),
  };
}

const plannedTour = (extra: Row = {}): Row => ({
  id: "t1", kind: "tour", managerUserId: AMBIKA, propertyId: "prop-1", title: "Tour", start: START, end: END,
  googleCalendarEventId: undefined, ...extra,
});

const connected = (map: Record<string, boolean>) => async (_db: unknown, uid: string) => ({ connected: map[uid] === true, syncEnabled: map[uid] === true });
const facts = (googleCalendarEventId?: string) => ({ plannedEventId: "t1", title: "Tour", start: START, end: END, googleCalendarEventId });
const holderRow = (db: ReturnType<typeof makeDb>) => db.rows.get("axis_gcal_tour_owner_t1")?.row_data as { connectionOwnerUserId: string; assigneeUserId: string } | undefined;

beforeEach(() => {
  for (const fn of Object.values(google)) fn.mockReset();
  team.owner.mockReset().mockResolvedValue(AMBIKA);
  team.hosts.mockReset().mockResolvedValue([AMBIKA]);
  team.managed.mockReset().mockResolvedValue(true);
  team.operator.mockReset().mockResolvedValue(PRAKRIT);
  google.create.mockResolvedValue("g-1");
  google.update.mockResolvedValue("g-1");
  google.remove.mockResolvedValue(undefined);
});

describe("default tour assignee", () => {
  it("managed workspace defaults to the PropLane operator", async () => {
    const r = await resolveTourAssigneeForCreate(makeDb(plannedTour()) as never, { assignee: null, propertyId: "prop-1", hostUserId: AMBIKA });
    expect(r).toMatchObject({ ok: true, assignee: { type: "team", id: PRAKRIT } });
  });
  it("self-serve workspace defaults to the house owner", async () => {
    team.managed.mockResolvedValue(false);
    const r = await resolveTourAssigneeForCreate(makeDb(plannedTour()) as never, { assignee: null, propertyId: "prop-1", hostUserId: AMBIKA });
    expect(r).toMatchObject({ ok: true, assignee: { type: "team", id: AMBIKA } });
  });
  it("refuses an assignee who is not on the property's team", async () => {
    const r = await resolveTourAssigneeForCreate(makeDb(plannedTour()) as never, {
      assignee: { type: "team", id: OUTSIDER, name: "x" }, propertyId: "prop-1", hostUserId: AMBIKA,
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });
});

// What the confirm / manual-booking pickers offer. The oracle is the create gate itself: every name offered must be one
// `resolveTourAssigneeForCreate` accepts, and a name it refuses must not be offered — a picker drawn from the manager's
// whole directory (an accepted co-manager with no grant on this house) failed the confirm with a 403.
describe("who a new tour may be offered to", () => {
  it("offers exactly the property's tour team, and the create gate takes every one of them", async () => {
    team.hosts.mockResolvedValue([AMBIKA]);
    const db = makeDb(plannedTour());
    const out = await listTourAssigneeCandidatesForProperty(db as never, { propertyId: "prop-1", actorUserId: AMBIKA });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.candidates.map((c) => c.id).sort()).toEqual([AMBIKA, PRAKRIT].sort());
    expect(out.candidates.find((c) => c.id === PRAKRIT)?.name).toBe("Prakrit");
    expect(out.defaultUserId).toBe(PRAKRIT);
    for (const candidate of out.candidates) {
      const accepted = await resolveTourAssigneeForCreate(db as never, {
        assignee: { type: "team", id: candidate.id, name: candidate.name }, propertyId: "prop-1", hostUserId: AMBIKA,
      });
      expect(accepted.ok, candidate.id).toBe(true);
    }
    expect(out.candidates.map((c) => c.id)).not.toContain(OUTSIDER);
  });

  it("offers nobody to an actor who is not on the team", async () => {
    const out = await listTourAssigneeCandidatesForProperty(makeDb(plannedTour()) as never, { propertyId: "prop-1", actorUserId: OUTSIDER });
    expect(out).toMatchObject({ ok: false, status: 403 });
  });
});

describe("where the event lives", () => {
  it("book -> the assignee's connected calendar", async () => {
    const db = makeDb(plannedTour({ assignee: { type: "team", id: PRAKRIT, name: "Prakrit" } }));
    google.connection.mockImplementation(connected({ [AMBIKA]: true, [PRAKRIT]: true }));
    await syncPlannedTourToGoogleCalendar(db as never, AMBIKA, facts());
    expect(google.create.mock.calls[0]?.[1]).toBe(PRAKRIT);
  });

  it("reschedule uses the stored holder even after the assignee connects their own calendar", async () => {
    const db = makeDb(plannedTour({ assignee: { type: "team", id: AMBIKA, name: "Ambika" } }));
    google.connection.mockImplementation(connected({ [PRAKRIT]: true }));
    await syncPlannedTourToGoogleCalendar(db as never, AMBIKA, facts());
    google.connection.mockImplementation(connected({ [PRAKRIT]: true, [AMBIKA]: true }));
    await syncPlannedTourToGoogleCalendar(db as never, AMBIKA, facts("g-1"));
    expect(google.update.mock.calls[0]?.[1]).toBe(PRAKRIT);
  });

  it("assignee with no calendar connected falls back to the operator, and the tour says so", async () => {
    const db = makeDb(plannedTour({ assignee: { type: "team", id: AMBIKA, name: "Ambika" } }));
    google.connection.mockImplementation(connected({ [PRAKRIT]: true }));
    await syncPlannedTourToGoogleCalendar(db as never, AMBIKA, facts());
    expect(google.create.mock.calls[0]?.[1]).toBe(PRAKRIT);
    expect(holderRow(db)).toMatchObject({ connectionOwnerUserId: PRAKRIT, assigneeUserId: AMBIKA });
    const info = await getTourAssigneeInfo(db as never, { plannedEventId: "t1", actorUserId: AMBIKA });
    expect(info).toMatchObject({ ok: true, assigneeName: "Ambika" });
    expect(info.ok && info.calendarNote).toBe("On Prakrit's calendar, Ambika hasn't connected Google Calendar");
  });

  it("two managers on two Google accounts: each tour lands only on its own calendar; one disconnecting leaves the other", async () => {
    const connections: Record<string, boolean> = { [AMBIKA]: true, [PRAKRIT]: true };
    google.connection.mockImplementation(async (_db: unknown, uid: string) => ({ connected: connections[uid] === true, syncEnabled: connections[uid] === true }));
    team.managed.mockResolvedValue(false);
    const a = makeDb(plannedTour({ id: "t1" }));
    const b = makeDb(plannedTour({ id: "t1", managerUserId: PRAKRIT, propertyId: "prop-2" }));
    await syncPlannedTourToGoogleCalendar(a as never, AMBIKA, facts());
    await syncPlannedTourToGoogleCalendar(b as never, PRAKRIT, facts());
    expect(google.create.mock.calls.map((c) => c[1])).toEqual([AMBIKA, PRAKRIT]);
    connections[AMBIKA] = false; // Ambika disconnects
    google.create.mockClear();
    await syncPlannedTourToGoogleCalendar(b as never, PRAKRIT, facts("g-1"));
    expect(google.update.mock.calls.at(-1)?.[1]).toBe(PRAKRIT);
    expect(google.create).not.toHaveBeenCalled();
  });
});

describe("reassign", () => {
  async function bookedOnOperator() {
    const db = makeDb(plannedTour());
    google.connection.mockImplementation(connected({ [PRAKRIT]: true, [AMBIKA]: true }));
    await syncPlannedTourToGoogleCalendar(db as never, AMBIKA, facts());
    // persisted google id on the planned row (the persist RPC is mocked)
    (db.rows.get("axis_admin_planned_events_v1")!.row_data.payload[0] as Row).googleCalendarEventId = "g-1";
    google.create.mockClear();
    expect(holderRow(db)).toMatchObject({ connectionOwnerUserId: PRAKRIT });
    return db;
  }

  it("moves the Google event to the new assignee's calendar and stores the new holder", async () => {
    const db = await bookedOnOperator();
    const r = await reassignPlannedTour(db as never, { plannedEventId: "t1", actorUserId: PRAKRIT, assigneeUserId: AMBIKA });
    expect(r.ok).toBe(true);
    expect(google.create.mock.calls[0]?.[1]).toBe(AMBIKA);
    expect(google.remove).toHaveBeenCalledWith(expect.anything(), PRAKRIT, "g-1");
    expect(holderRow(db)).toMatchObject({ connectionOwnerUserId: AMBIKA, assigneeUserId: AMBIKA });
    expect((db.rows.get("axis_admin_planned_events_v1")!.row_data.payload[0] as Row).assignee).toMatchObject({ id: AMBIKA });
  });

  it("falls back to the operator when the new assignee has no calendar, leaving the event where it was", async () => {
    const db = await bookedOnOperator();
    google.connection.mockImplementation(connected({ [PRAKRIT]: true }));
    const r = await reassignPlannedTour(db as never, { plannedEventId: "t1", actorUserId: PRAKRIT, assigneeUserId: AMBIKA });
    expect(r.ok).toBe(true);
    expect(google.create).not.toHaveBeenCalled();
    expect(google.remove).not.toHaveBeenCalled();
    expect(holderRow(db)).toMatchObject({ connectionOwnerUserId: PRAKRIT, assigneeUserId: AMBIKA });
  });

  it("refuses a non-member assignee and a non-member actor", async () => {
    const db = await bookedOnOperator();
    expect(await reassignPlannedTour(db as never, { plannedEventId: "t1", actorUserId: PRAKRIT, assigneeUserId: OUTSIDER })).toMatchObject({ ok: false, status: 403 });
    expect(await reassignPlannedTour(db as never, { plannedEventId: "t1", actorUserId: OUTSIDER, assigneeUserId: AMBIKA })).toMatchObject({ ok: false, status: 403 });
    expect(google.remove).not.toHaveBeenCalled();
  });
});
