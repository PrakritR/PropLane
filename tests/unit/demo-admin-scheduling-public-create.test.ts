import { afterEach, describe, expect, it, vi } from "vitest";

function makeSessionStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("public partner inquiry client writes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("keeps the returned inquiry in the browser cache without posting a partial schedule singleton", async () => {
    const sessionStorage = makeSessionStorage();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage, dispatchEvent: vi.fn() } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ row: {
      id: "server-inquiry",
      name: "Ava Prospect",
      email: "ava@example.test",
      phone: "+15550000001",
      notes: "",
      proposedStart: "2030-01-01T18:00:00.000Z",
      proposedEnd: "2030-01-01T18:30:00.000Z",
      status: "pending",
      createdAt: "2030-01-01T00:00:00.000Z",
    } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { appendPartnerInquiryToServer, readPartnerInquiries } = await import("@/lib/demo-admin-scheduling");

    const result = await appendPartnerInquiryToServer({
      name: "Ava Prospect",
      email: "ava@example.test",
      phone: "+15550000001",
      notes: "",
      proposedStart: "2030-01-01T18:00:00.000Z",
      proposedEnd: "2030-01-01T18:30:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(readPartnerInquiries().map((row) => row.id)).toEqual(["server-inquiry"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/public/partner-inquiries");
    expect(sessionStorage.values.has("axis_sched_cache_v1:axis_admin_partner_inquiries_v1")).toBe(true);
    expect([...fetchMock.mock.calls].some(([url]) => url === "/api/portal-schedule-records")).toBe(false);
  });

  it("keeps demo-local append behavior local while still using the public persistence route", async () => {
    const sessionStorage = makeSessionStorage();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage, dispatchEvent: vi.fn() } });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { appendPartnerInquiry, readPartnerInquiries } = await import("@/lib/demo-admin-scheduling");

    const row = appendPartnerInquiry({
      name: "Demo Prospect",
      email: "demo@example.test",
      phone: "+15550000002",
      notes: "",
      proposedStart: "2030-01-02T18:00:00.000Z",
      proposedEnd: "2030-01-02T18:30:00.000Z",
    });

    expect(readPartnerInquiries()).toEqual([row]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/public/partner-inquiries");
    expect([...fetchMock.mock.calls].some(([url]) => url === "/api/portal-schedule-records")).toBe(false);
  });

  it("clears the authoritative cache after the last inquiry is accepted or deleted", async () => {
    const sessionStorage = makeSessionStorage();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage, dispatchEvent: vi.fn() } });
    vi.doMock("@/lib/manager-tasks", () => ({ reapplyAllManagerTasksToCalendar: vi.fn(async () => undefined) }));
    const inquiry = {
      id: "last-visible-inquiry",
      name: "Ava Prospect",
      email: "ava@example.test",
      phone: "+15550000001",
      notes: "",
      proposedStart: "2030-01-01T18:00:00.000Z",
      proposedEnd: "2030-01-01T18:30:00.000Z",
      status: "pending",
      createdAt: "2030-01-01T00:00:00.000Z",
    };
    const responseRows = [
      [{ id: "axis_admin_partner_inquiries_v1", recordType: "axis_admin_partner_inquiries_v1", payload: [inquiry] }],
      // The accept route removes the request from the pending projection.
      [{ id: "axis_admin_partner_inquiries_v1", recordType: "axis_admin_partner_inquiries_v1", payload: [] }],
      [{ id: "axis_admin_partner_inquiries_v1", recordType: "axis_admin_partner_inquiries_v1", payload: [inquiry] }],
      // The delete/decline route likewise leaves an observed empty singleton.
      [{ id: "axis_admin_partner_inquiries_v1", recordType: "axis_admin_partner_inquiries_v1", payload: [] }],
    ];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ rows: responseRows.shift() ?? [] })));
    const scheduling = await import("@/lib/demo-admin-scheduling");

    await expect(scheduling.syncScheduleRecordsFromServer({ force: true })).resolves.toBe(true);
    expect(scheduling.readPartnerInquiries().map((row) => row.id)).toEqual(["last-visible-inquiry"]);
    await expect(scheduling.syncScheduleRecordsFromServer({ force: true })).resolves.toBe(true);
    expect(scheduling.readPartnerInquiries()).toEqual([]);
    await expect(scheduling.syncScheduleRecordsFromServer({ force: true })).resolves.toBe(true);
    expect(scheduling.readPartnerInquiries().map((row) => row.id)).toEqual(["last-visible-inquiry"]);
    await expect(scheduling.syncScheduleRecordsFromServer({ force: true })).resolves.toBe(true);
    expect(scheduling.readPartnerInquiries()).toEqual([]);
  });

  it("clears a grant-removed inquiry while preserving canonical state over a stale standalone mirror", async () => {
    const sessionStorage = makeSessionStorage();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage, dispatchEvent: vi.fn() } });
    vi.doMock("@/lib/manager-tasks", () => ({ reapplyAllManagerTasksToCalendar: vi.fn(async () => undefined) }));
    const canonical = {
      id: "shared-inquiry",
      name: "Ava Prospect",
      email: "ava@example.test",
      phone: "+15550000001",
      notes: "",
      proposedStart: "2030-01-01T19:00:00.000Z",
      proposedEnd: "2030-01-01T19:30:00.000Z",
      status: "declined",
      createdAt: "2030-01-01T00:00:00.000Z",
    };
    const staleMirror = { ...canonical, status: "pending", proposedStart: "2030-01-01T18:00:00.000Z" };
    const responseRows = [
      [
        { id: "axis_admin_partner_inquiries_v1", recordType: "axis_admin_partner_inquiries_v1", payload: [canonical] },
        { id: "standalone-shared-inquiry", recordType: "partner_inquiry_request", payload: staleMirror },
      ],
      // Another owner's inquiry still exists server-side, but after this
      // viewer's grant is removed the projection is authoritatively empty.
      [{ id: "axis_admin_partner_inquiries_v1", recordType: "axis_admin_partner_inquiries_v1", payload: [] }],
    ];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ rows: responseRows.shift() ?? [] })));
    const scheduling = await import("@/lib/demo-admin-scheduling");

    await scheduling.syncScheduleRecordsFromServer({ force: true });
    expect(scheduling.readPartnerInquiries()).toEqual([expect.objectContaining({
      id: "shared-inquiry",
      status: "declined",
      proposedStart: "2030-01-01T19:00:00.000Z",
    })]);
    await scheduling.syncScheduleRecordsFromServer({ force: true });
    expect(scheduling.readPartnerInquiries()).toEqual([]);
  });
});
