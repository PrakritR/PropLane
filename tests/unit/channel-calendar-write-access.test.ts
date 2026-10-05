/**
 * Linking, unlinking and syncing a channel calendar changes what a property publishes and blocks. It needs the
 * Calendar module at EDIT; a co-manager holding calendar read (or only the legacy properties read grant) can look,
 * never change.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLinkedFormFakeDb, type LinkedFormFakeDb } from "../helpers/linked-form-fake-db";

const OWNER = "owner-1";
const READER = "reader-1";
const EDITOR = "editor-1";
const PROPERTIES_ONLY = "props-only-1";
const PROPERTY = "property-1";

const state = vi.hoisted(() => ({ userId: "owner-1", db: null as unknown, upserts: 0, deletes: 0, syncs: 0 }));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: state.userId, user_metadata: { role: "manager" } } } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));
vi.mock("@/lib/manager-route-guard.server", () => ({ requireManagerRouteUser: async () => ({ db: state.db, userId: state.userId }) }));
vi.mock("@/lib/channel-calendar/sync.server", () => ({
  upsertChannelCalendarConnection: async () => {
    state.upserts += 1;
    return { id: "conn-1" };
  },
  deleteChannelCalendarConnection: async () => {
    state.deletes += 1;
  },
  syncChannelCalendarConnection: async () => {
    state.syncs += 1;
    return { id: "conn-1", provider: "airbnb", room_id: "room-a", property_id: PROPERTY };
  },
  listChannelCalendarConnections: async () => [{ id: "conn-1" }],
  ensureRoomExportCalendarUrl: async () => "https://example.test/export",
}));
vi.mock("@/lib/channel-calendar/connections.server", () => ({ toPublicConnection: (row: unknown) => row }));

import { managerCanWriteCalendarForProperty, managerHasCalendarAccessForProperty } from "@/lib/auth/manager-lease-scope";
import { DELETE as deleteConnection, GET as getConnections, POST as postConnection } from "@/app/api/portal/channel-calendar/connections/route";
import { POST as syncOne } from "@/app/api/portal/channel-calendar/sync/route";
import { POST as syncAll } from "@/app/api/portal/channel-calendar/sync-all/route";

function invite(invitee: string, permissions: Record<string, unknown>) {
  return {
    inviter_user_id: OWNER,
    invitee_user_id: invitee,
    assigned_property_ids: [PROPERTY],
    property_co_manager_permissions: { [PROPERTY]: permissions },
    status: "accepted",
    test_workspace_id: null,
  };
}

function seed(): LinkedFormFakeDb {
  return createLinkedFormFakeDb({
    manager_property_records: [{ id: PROPERTY, manager_user_id: OWNER, property_data: {} }],
    account_link_invites: [
      invite(READER, { calendar: { read: true } }),
      invite(EDITOR, { calendar: { read: true, edit: true } }),
      invite(PROPERTIES_ONLY, { properties: { read: true, edit: true } }),
    ],
    external_calendar_connections: [{ id: "conn-1", property_id: PROPERTY, manager_user_id: OWNER, import_url: "https://airbnb.test/cal.ics" }],
    profiles: [],
    profile_roles: [
      { user_id: OWNER, role: "manager" },
      { user_id: READER, role: "manager" },
      { user_id: EDITOR, role: "manager" },
      { user_id: PROPERTIES_ONLY, role: "manager" },
    ],
  });
}

const json = (method: string, body: unknown) =>
  new Request("http://localhost/api/portal/channel-calendar/connections", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const connectBody = { propertyId: PROPERTY, roomId: "room-a", provider: "airbnb", importUrl: "https://airbnb.test/cal.ics" };

beforeEach(() => {
  state.db = seed();
  state.userId = OWNER;
  state.upserts = 0;
  state.deletes = 0;
  state.syncs = 0;
});

describe("the calendar write check", () => {
  it("is true for the owner and a co-manager with calendar edit, false for read-only and for the legacy properties grant", async () => {
    const db = state.db as never;
    expect(await managerCanWriteCalendarForProperty(db, OWNER, PROPERTY)).toBe(true);
    expect(await managerCanWriteCalendarForProperty(db, EDITOR, PROPERTY)).toBe(true);
    expect(await managerCanWriteCalendarForProperty(db, READER, PROPERTY)).toBe(false);
    expect(await managerCanWriteCalendarForProperty(db, PROPERTIES_ONLY, PROPERTY)).toBe(false);
    expect(await managerCanWriteCalendarForProperty(db, "stranger", PROPERTY)).toBe(false);
    // Read access is unchanged: the reader (and the legacy properties grant) can still see the calendar.
    expect(await managerHasCalendarAccessForProperty(db, READER, PROPERTY)).toBe(true);
    expect(await managerHasCalendarAccessForProperty(db, PROPERTIES_ONLY, PROPERTY)).toBe(true);
  });
});

describe("a read-only co-manager can look at channel calendars but not change them", () => {
  beforeEach(() => {
    state.userId = READER;
  });

  it("can read the connections", async () => {
    const res = await getConnections(new Request(`http://localhost/api/portal/channel-calendar/connections?propertyId=${PROPERTY}`));
    expect(res.status).toBe(200);
  });

  it("is refused when linking, unlinking or syncing, and nothing is written", async () => {
    expect((await postConnection(json("POST", connectBody))).status).toBe(403);
    expect((await deleteConnection(new Request("http://localhost/api/portal/channel-calendar/connections?id=conn-1", { method: "DELETE" }))).status).toBe(403);
    expect((await syncOne(json("POST", { connectionId: "conn-1" }))).status).toBe(403);
    const all = await syncAll(json("POST", { propertyIds: [PROPERTY] }));
    expect((await all.json()).synced).toBe(0);
    expect(state).toMatchObject({ upserts: 0, deletes: 0, syncs: 0 });
  });

  it("is told which properties it may link: none", async () => {
    const res = await getConnections(new Request(`http://localhost/api/portal/channel-calendar/connections?writableFor=${PROPERTY}`));
    expect(await res.json()).toEqual({ writablePropertyIds: [] });
  });
});

describe("an owner or a co-manager with calendar edit can", () => {
  it.each([OWNER, EDITOR])("link, unlink and sync as %s", async (userId) => {
    state.userId = userId;
    expect((await postConnection(json("POST", connectBody))).status).toBe(200);
    expect((await syncOne(json("POST", { connectionId: "conn-1" }))).status).toBe(200);
    expect((await deleteConnection(new Request("http://localhost/api/portal/channel-calendar/connections?id=conn-1", { method: "DELETE" }))).status).toBe(200);
    expect(state).toMatchObject({ upserts: 1, deletes: 1, syncs: 1 });
    const writable = await getConnections(new Request(`http://localhost/api/portal/channel-calendar/connections?writableFor=${PROPERTY},other-property`));
    expect(await writable.json()).toEqual({ writablePropertyIds: [PROPERTY] });
  });
});
