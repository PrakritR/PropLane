// @vitest-environment jsdom
// A schedule read that FAILS (5xx) must leave the visible tour-request cache alone: only a successful
// response is the authoritative snapshot. Pairs with the route's fail-loud change (an unreadable staff or
// co-manager scope is a 500, never a 200 with the tours missing).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/demo-admin-ui", () => ({ emitAdminUi: vi.fn() }));
vi.mock("@/lib/auth/portal-session-gate", () => ({
  notePortalResponse: vi.fn(),
  portalSessionEnded: () => false,
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const tour = {
  id: "tour-1",
  kind: "tour",
  status: "pending",
  propertyId: "house-1",
  managerUserId: "owner-1",
  createdAt: "2026-11-26T00:00:00.000Z",
};

describe("schedule sync keeps the tour cache on a failed read", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a 500 keeps the previous pending tour; a good empty snapshot is the only thing that clears it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ rows: [{ id: "partner_inquiry_request_1", recordType: "partner_inquiry_request", payload: tour }] }))
      .mockResolvedValueOnce(json({ error: "Could not load your schedule right now." }, 500))
      .mockResolvedValueOnce(json({ rows: [] }));
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    window.sessionStorage.clear();
    const scheduling = await import("@/lib/demo-admin-scheduling");

    await expect(scheduling.syncScheduleRecordsFromServer({ force: true })).resolves.toBe(true);
    expect(scheduling.readPartnerInquiries().map((r) => r.id)).toEqual(["tour-1"]);

    await expect(scheduling.syncScheduleRecordsFromServer({ force: true })).resolves.toBe(false);
    expect(scheduling.readPartnerInquiries().map((r) => r.id)).toEqual(["tour-1"]);

    await expect(scheduling.syncScheduleRecordsFromServer({ force: true })).resolves.toBe(true);
    expect(scheduling.readPartnerInquiries()).toEqual([]);
  });
});
