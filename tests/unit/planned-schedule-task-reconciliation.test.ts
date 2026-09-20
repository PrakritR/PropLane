// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/demo-admin-ui", () => ({ emitAdminUi: vi.fn() }));
vi.mock("@/lib/auth/portal-session-gate", () => ({
  notePortalResponse: vi.fn(),
  portalSessionEnded: () => false,
}));

const PLANNED_ID = "axis_admin_planned_events_v1";
const taskEvent = (managerUserId: string, id = `task-${managerUserId}`) => ({
  id,
  kind: "task" as const,
  managerUserId,
  sourceTaskId: id,
  title: `Task · ${managerUserId}`,
  start: "2099-01-01T17:00:00.000Z",
  end: "2099-01-01T17:30:00.000Z",
  adminUserId: managerUserId,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function plannedResponse(rows: unknown[] = []): Response {
  return jsonResponse({ rows: [{ id: PLANNED_ID, recordType: PLANNED_ID, payload: rows }] });
}

async function loadModules() {
  vi.resetModules();
  window.sessionStorage.clear();
  const scheduling = await import("@/lib/demo-admin-scheduling");
  const managerTasks = await import("@/lib/manager-tasks");
  return { scheduling, managerTasks };
}

describe("planned schedule task reconciliation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([409, 503])("bounds a persistent %s planned write failure", async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(plannedResponse())
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, status))
      .mockResolvedValueOnce(plannedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { scheduling } = await loadModules();

    await expect(scheduling.syncScheduleRecordsFromServer({ force: true })).resolves.toBe(true);
    await expect(scheduling.replaceManagerTaskPlannedEvents("manager-1", [taskEvent("manager-1")])).resolves.toBe(false);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(scheduling.readAllPlannedEvents()).toEqual([]);
  });

  it("does not send a queued second edit after the first edit conflicts", async () => {
    let releaseFirstPost!: (response: Response) => void;
    const firstPost = new Promise<Response>((resolve) => {
      releaseFirstPost = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(plannedResponse())
      .mockReturnValueOnce(firstPost)
      .mockResolvedValueOnce(plannedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { scheduling } = await loadModules();

    await scheduling.syncScheduleRecordsFromServer({ force: true });
    const first = scheduling.replaceManagerTaskPlannedEvents("manager-a", [taskEvent("manager-a")]);
    const second = scheduling.replaceManagerTaskPlannedEvents("manager-b", [taskEvent("manager-b")]);
    releaseFirstPost(jsonResponse({ error: "stale_schedule" }, 409));

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(scheduling.readAllPlannedEvents()).toEqual([]);
  });

  it("resyncs the winning tour and permits a later explicit task retry", async () => {
    const tour = { id: "tour-won", kind: "tour", title: "Tour", start: "2099-01-02T17:00:00.000Z", end: "2099-01-02T17:30:00.000Z" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(plannedResponse())
      .mockResolvedValueOnce(jsonResponse({ error: "stale_schedule" }, 409))
      .mockResolvedValueOnce(plannedResponse([tour]))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { scheduling } = await loadModules();

    await scheduling.syncScheduleRecordsFromServer({ force: true });
    await expect(scheduling.replaceManagerTaskPlannedEvents("manager-1", [taskEvent("manager-1")])).resolves.toBe(false);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(scheduling.readAllPlannedEvents()).toEqual([tour]);

    await expect(scheduling.replaceManagerTaskPlannedEvents("manager-1", [taskEvent("manager-1")])).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const retryBody = JSON.parse(String((fetchMock.mock.calls[3]![1] as RequestInit).body)) as {
      expectedPayload?: unknown;
      row?: { payload?: unknown };
    };
    expect(retryBody.expectedPayload).toEqual([tour]);
    expect(retryBody.row?.payload).toEqual([tour, taskEvent("manager-1")]);
  });

  it("treats a missing singleton as an observed empty baseline", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ rows: [] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { scheduling } = await loadModules();

    await scheduling.syncScheduleRecordsFromServer({ force: true });
    await expect(scheduling.replaceManagerTaskPlannedEvents("manager-1", [taskEvent("manager-1")])).resolves.toBe(true);
    const body = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.expectedPayloadKnown).toBe(true);
    expect(body.expectedPayload).toEqual([]);
  });

  it("does not let an older GET overwrite a completed planned write", async () => {
    let releaseGet!: (response: Response) => void;
    const oldGet = new Promise<Response>((resolve) => {
      releaseGet = resolve;
    });
    const event = taskEvent("manager-1");
    const fetchMock = vi.fn()
      .mockReturnValueOnce(oldGet)
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { scheduling } = await loadModules();

    const sync = scheduling.syncScheduleRecordsFromServer({ force: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await expect(scheduling.replaceManagerTaskPlannedEvents("manager-1", [event])).resolves.toBe(true);
    releaseGet(plannedResponse([]));
    await expect(sync).resolves.toBe(true);
    expect(scheduling.readAllPlannedEvents()).toEqual([event]);
  });

  it("uses the real manager task reapply path without rewriting an unchanged projection", async () => {
    const event = taskEvent("manager-1");
    const task = {
      id: event.sourceTaskId,
      title: "manager-1",
      start: event.start,
      end: event.end,
      completed: false,
      assignee: { type: "team", id: "manager-1", name: "Manager" },
      createdAt: "2098-01-01T00:00:00.000Z",
      updatedAt: "2098-01-01T00:00:00.000Z",
    };
    const exactEvent = { ...event, id: `task_${task.id}`, title: "Task · manager-1", assignee: task.assignee };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(plannedResponse([exactEvent]))
      .mockResolvedValueOnce(jsonResponse({ tasks: [task] }));
    vi.stubGlobal("fetch", fetchMock);
    const { scheduling, managerTasks } = await loadModules();

    await scheduling.syncScheduleRecordsFromServer({ force: true });
    expect(scheduling.readAllPlannedEvents()).toEqual([exactEvent]);
    // Let the successful sync finish its asynchronous real-module reapply
    // before loading the manager task list.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(managerTasks.fetchManagerTasks("manager-1")).resolves.toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps independent managers in one ordered shared projection", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(plannedResponse())
      .mockResolvedValueOnce(jsonResponse({ tasks: [{ id: "a", title: "A", start: "2099-01-01T17:00:00.000Z", end: "2099-01-01T17:30:00.000Z", completed: false, assignee: { type: "team", id: "a", name: "A" }, createdAt: "2098-01-01T00:00:00.000Z", updatedAt: "2098-01-01T00:00:00.000Z" }] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ tasks: [{ id: "b", title: "B", start: "2099-01-01T18:00:00.000Z", end: "2099-01-01T18:30:00.000Z", completed: false, assignee: { type: "team", id: "b", name: "B" }, createdAt: "2098-01-01T00:00:00.000Z", updatedAt: "2098-01-01T00:00:00.000Z" }] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { scheduling, managerTasks } = await loadModules();

    await scheduling.syncScheduleRecordsFromServer({ force: true });
    await managerTasks.fetchManagerTasks("a");
    await managerTasks.fetchManagerTasks("b");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const secondWrite = JSON.parse(String((fetchMock.mock.calls[4]![1] as RequestInit).body)) as { row?: { payload?: Array<{ sourceTaskId?: string }> } };
    expect(secondWrite.row?.payload?.map((row) => row.sourceTaskId)).toEqual(["a", "b"]);
  });
});
