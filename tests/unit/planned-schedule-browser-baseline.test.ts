// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/demo-admin-ui", () => ({ emitAdminUi: vi.fn() }));
vi.mock("@/lib/auth/portal-session-gate", () => ({
  notePortalResponse: vi.fn(),
  portalSessionEnded: () => false,
}));
vi.mock("@/lib/manager-tasks", () => ({ reapplyAllManagerTasksToCalendar: vi.fn() }));

describe("planned schedule browser baseline", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("sends the actually observed singleton and resyncs after a CAS conflict", async () => {
    const observed = [
      { id: "task-old", kind: "task", managerUserId: "manager-1", title: "Old" },
      { id: "tour-new", kind: "tour", managerUserId: "manager-1", title: "Tour" },
      { id: "legacy", kind: "meeting", title: "Unassigned" },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        rows: [{ id: "axis_admin_planned_events_v1", recordType: "axis_admin_planned_events_v1", payload: observed }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "stale_schedule" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        rows: [{ id: "axis_admin_planned_events_v1", recordType: "axis_admin_planned_events_v1", payload: observed }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const scheduling = await import("@/lib/demo-admin-scheduling");

    await expect(scheduling.syncScheduleRecordsFromServer({ force: true })).resolves.toBe(true);
    scheduling.replaceManagerTaskPlannedEvents("manager-1", [
      { id: "task-new", kind: "task", managerUserId: "manager-1", title: "New", start: "2030-01-01T17:00:00.000Z", end: "2030-01-01T17:30:00.000Z" },
    ]);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const request = fetchMock.mock.calls[1]![1] as RequestInit;
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      action: "upsert",
      expectedPayloadKnown: true,
      expectedPayload: observed,
    });
    expect((body.row as { payload: Array<{ id: string }> }).payload.map((row) => row.id)).toEqual([
      "tour-new",
      "legacy",
      "task-new",
    ]);
  });
});
