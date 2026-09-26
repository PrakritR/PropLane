import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

/**
 * `syncVendorServiceVisitToGoogleCalendar` — the vendor-side push new to this
 * change. Gated on `vendorPushEnabled` (default off) independently of
 * `syncEnabled`, and keeps a SEPARATE remote event id
 * (`vendorGoogleCalendarEventId`) from the manager's own push.
 */

const mocks = vi.hoisted(() => ({
  loadGoogleCalendarConnection: vi.fn(),
  createGoogleCalendarEvent: vi.fn(),
  updateGoogleCalendarEvent: vi.fn(),
  deleteGoogleCalendarEvent: vi.fn(),
}));

vi.mock("@/lib/google-calendar/settings", () => ({
  loadGoogleCalendarConnection: mocks.loadGoogleCalendarConnection,
}));
vi.mock("@/lib/google-calendar/api.server", () => ({
  createGoogleCalendarEvent: mocks.createGoogleCalendarEvent,
  updateGoogleCalendarEvent: mocks.updateGoogleCalendarEvent,
  deleteGoogleCalendarEvent: mocks.deleteGoogleCalendarEvent,
}));

import { syncVendorServiceVisitToGoogleCalendar } from "@/lib/google-calendar/vendor-calendar-push.server";

function row(overrides: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow {
  return {
    id: "wo-1",
    propertyName: "123 Main St",
    unit: "—",
    title: "Fix sink",
    priority: "normal",
    status: "scheduled",
    bucket: "scheduled",
    description: "Leaky faucet",
    scheduled: "",
    cost: "",
    scheduledAtIso: "2099-01-01T17:00:00.000Z",
    vendorUserId: "vendor-1",
    ...overrides,
  };
}

describe("syncVendorServiceVisitToGoogleCalendar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteGoogleCalendarEvent.mockResolvedValue(undefined);
  });

  it("is a no-op when no vendor is assigned", async () => {
    const result = await syncVendorServiceVisitToGoogleCalendar({} as never, null, row());
    expect(result).toEqual(row());
    expect(mocks.loadGoogleCalendarConnection).not.toHaveBeenCalled();
  });

  it("does not push when the vendor has not opted in (vendorPushEnabled defaults off)", async () => {
    mocks.loadGoogleCalendarConnection.mockResolvedValue({
      connected: true,
      syncEnabled: true,
      vendorPushEnabled: false,
    });
    const result = await syncVendorServiceVisitToGoogleCalendar({} as never, "vendor-1", row());
    expect(result).toEqual(row());
    expect(mocks.createGoogleCalendarEvent).not.toHaveBeenCalled();
  });

  it("does not push when the vendor is not connected, even if vendorPushEnabled is somehow true", async () => {
    mocks.loadGoogleCalendarConnection.mockResolvedValue({
      connected: false,
      syncEnabled: true,
      vendorPushEnabled: true,
    });
    const result = await syncVendorServiceVisitToGoogleCalendar({} as never, "vendor-1", row());
    expect(result).toEqual(row());
    expect(mocks.createGoogleCalendarEvent).not.toHaveBeenCalled();
  });

  it("creates a Google event on the vendor's own calendar when opted in, storing a separate event id", async () => {
    mocks.loadGoogleCalendarConnection.mockResolvedValue({
      connected: true,
      syncEnabled: true,
      vendorPushEnabled: true,
    });
    mocks.createGoogleCalendarEvent.mockResolvedValue("vendor-google-event-1");

    const result = await syncVendorServiceVisitToGoogleCalendar({} as never, "vendor-1", row());
    expect(mocks.createGoogleCalendarEvent).toHaveBeenCalledWith(
      {},
      "vendor-1",
      expect.objectContaining({ start: "2099-01-01T17:00:00.000Z" }),
    );
    expect(result.vendorGoogleCalendarEventId).toBe("vendor-google-event-1");
    // The manager's own event id field must never be touched by the vendor push.
    expect(result.googleCalendarEventId).toBeUndefined();
  });

  it("updates the existing vendor event instead of creating a duplicate", async () => {
    mocks.loadGoogleCalendarConnection.mockResolvedValue({
      connected: true,
      syncEnabled: true,
      vendorPushEnabled: true,
    });
    mocks.updateGoogleCalendarEvent.mockResolvedValue("vendor-google-event-1");

    const result = await syncVendorServiceVisitToGoogleCalendar(
      {} as never,
      "vendor-1",
      row({ vendorGoogleCalendarEventId: "vendor-google-event-1" }),
    );
    expect(mocks.updateGoogleCalendarEvent).toHaveBeenCalledWith({}, "vendor-1", "vendor-google-event-1", expect.anything());
    expect(mocks.createGoogleCalendarEvent).not.toHaveBeenCalled();
    expect(result.vendorGoogleCalendarEventId).toBe("vendor-google-event-1");
  });

  it("deletes the vendor's event and clears the id when the visit is unscheduled", async () => {
    mocks.loadGoogleCalendarConnection.mockResolvedValue({
      connected: true,
      syncEnabled: true,
      vendorPushEnabled: true,
    });

    const result = await syncVendorServiceVisitToGoogleCalendar(
      {} as never,
      "vendor-1",
      row({ scheduledAtIso: undefined, bucket: "open", vendorGoogleCalendarEventId: "vendor-google-event-1" }),
    );
    expect(mocks.deleteGoogleCalendarEvent).toHaveBeenCalledWith({}, "vendor-1", "vendor-google-event-1");
    expect(result.vendorGoogleCalendarEventId).toBeUndefined();
  });

  it("never throws when the Google call fails", async () => {
    mocks.loadGoogleCalendarConnection.mockResolvedValue({
      connected: true,
      syncEnabled: true,
      vendorPushEnabled: true,
    });
    mocks.createGoogleCalendarEvent.mockRejectedValue(new Error("Google is down"));

    await expect(syncVendorServiceVisitToGoogleCalendar({} as never, "vendor-1", row())).resolves.toEqual(row());
  });
});
