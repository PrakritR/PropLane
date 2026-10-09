import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

/**
 * W010: `listManagerChannelCalendarBookings` narrowed by ownership/co-manager
 * calendar access only — switching the active workspace did not hide another
 * of the manager's own workspaces' Airbnb/VRBO booking data from this panel.
 * `propertyIds` is intersected with the active workspace before anything else
 * runs.
 */

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => (state.cookieValue !== undefined ? { value: state.cookieValue } : undefined) })),
}));

const mocks = vi.hoisted(() => ({
  loadWorkspaces: vi.fn(),
  managerHasCalendarAccessForProperty: vi.fn(async () => true),
  managerCanWriteCalendarForProperty: vi.fn(async () => true),
}));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: mocks.loadWorkspaces }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCalendarAccessForProperty: mocks.managerHasCalendarAccessForProperty,
  managerCanWriteCalendarForProperty: mocks.managerCanWriteCalendarForProperty,
}));

import { listManagerChannelCalendarBookings } from "@/lib/channel-calendar/bookings.server";

const MANAGER = "mgr-1";
const WS_A = { id: "ws-a", name: "A", ownerUserId: MANAGER, owned: true, isDefault: true, propertyIds: ["p1"] };
const WS_B = { id: "ws-b", name: "B", ownerUserId: MANAGER, owned: true, isDefault: false, propertyIds: ["p2"] };

function setup(rows: { external_calendar_connections?: Row[] } = {}) {
  return fakeSupabaseClient({ external_calendar_connections: rows.external_calendar_connections ?? [] });
}

beforeEach(() => {
  state.cookieValue = undefined;
  mocks.loadWorkspaces.mockReset();
  mocks.managerHasCalendarAccessForProperty.mockReset().mockResolvedValue(true);
  mocks.managerCanWriteCalendarForProperty.mockReset().mockResolvedValue(true);
});

describe("listManagerChannelCalendarBookings — active-workspace guard", () => {
  it("intersects the requested propertyIds with the active workspace before checking access", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id; // active = p1 only
    const db = setup();
    await listManagerChannelCalendarBookings(db as never, MANAGER, ["p1", "p2"]);
    // p2 lives in Workspace B, not the active one: access is never even
    // checked for it, let alone its bookings loaded.
    expect(mocks.managerHasCalendarAccessForProperty).toHaveBeenCalledWith(expect.anything(), MANAGER, "p1");
    expect(mocks.managerHasCalendarAccessForProperty).not.toHaveBeenCalledWith(expect.anything(), MANAGER, "p2");
  });

  it("returns nothing when every requested property is outside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = setup();
    const result = await listManagerChannelCalendarBookings(db as never, MANAGER, ["p2"]);
    expect(result).toEqual([]);
    expect(mocks.managerHasCalendarAccessForProperty).not.toHaveBeenCalled();
  });

  it("switching the active workspace to B reaches p2 and now excludes p1", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_B.id;
    const db = setup();
    await listManagerChannelCalendarBookings(db as never, MANAGER, ["p1", "p2"]);
    expect(mocks.managerHasCalendarAccessForProperty).toHaveBeenCalledWith(expect.anything(), MANAGER, "p2");
    expect(mocks.managerHasCalendarAccessForProperty).not.toHaveBeenCalledWith(expect.anything(), MANAGER, "p1");
  });

  it("a single-workspace manager is unaffected", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A]);
    const db = setup();
    await listManagerChannelCalendarBookings(db as never, MANAGER, ["p1"]);
    expect(mocks.managerHasCalendarAccessForProperty).toHaveBeenCalledWith(expect.anything(), MANAGER, "p1");
  });
});

describe("listManagerChannelCalendarBookings — import URL is a bearer secret", () => {
  const connection: Row = {
    id: "conn-1",
    property_id: "p1",
    room_id: "r1",
    provider: "airbnb",
    label: "Airbnb",
    import_url: "https://www.airbnb.com/calendar/ical/123.ics?s=secret",
    export_token: "tok-1",
    imported_ranges: [],
    last_synced_at: null,
    last_error: null,
    created_at: "2026-10-01T00:00:00Z",
  };

  function importUrls(result: Awaited<ReturnType<typeof listManagerChannelCalendarBookings>>) {
    return result.flatMap((p) => p.rooms.map((r) => r.importUrl));
  }

  it("reaches a manager who can edit the calendar", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A]);
    const result = await listManagerChannelCalendarBookings(setup({ external_calendar_connections: [connection] }) as never, MANAGER, ["p1"]);
    expect(importUrls(result)).toEqual([connection.import_url]);
  });

  it("is withheld from a view-only teammate (hasImportUrl still tells them one is linked)", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A]);
    mocks.managerCanWriteCalendarForProperty.mockResolvedValue(false);
    const result = await listManagerChannelCalendarBookings(setup({ external_calendar_connections: [connection] }) as never, MANAGER, ["p1"]);
    expect(importUrls(result)).toEqual([null]);
    expect(result.flatMap((p) => p.rooms.map((r) => r.hasImportUrl))).toEqual([true]);
  });
});
