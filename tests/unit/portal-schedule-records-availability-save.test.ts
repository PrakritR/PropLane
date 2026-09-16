/**
 * WS3 + WS5 review finding: the availability SAVE path
 * (`POST /api/portal-schedule-records` upserting a `manager_availability`
 * record) must, after the row is written,
 *
 * - push the painted windows to the manager's Google Calendar, and
 * - emit `availability_changed` to the PROPERTY OWNER's team (a co-manager
 *   painting on the owner's house is the owner's team's news), keyed on what
 *   changed so a retried save never re-posts,
 *
 * and stay a successful local save even when either side effect throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const syncToGoogle = vi.fn(async () => undefined);
const emitAvailabilityChanged = vi.fn(async () => undefined);
const upsert = vi.fn(async () => ({ error: null }));
let existingRow: Record<string, unknown> | null = null;
let propertyOwner: string | null = null;

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (task: () => unknown) => void task() };
});
vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: async () => ({
    user: { id: "comgr-1", email: "co@example.com" },
    roles: ["manager"],
    effectiveRole: "manager",
    profile: { email: "co@example.com", role: "manager" },
  }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self,
        eq: self,
        or: self,
        limit: self,
        // Awaiting the chain (`.limit(1)` / `.limit(1).or(...)`) yields the row read.
        then: (resolve: (v: unknown) => void) => resolve({ data: existingRow ? [existingRow] : [], error: null }),
        maybeSingle: async () => ({
          data: table === "manager_property_records" ? { manager_user_id: propertyOwner } : null,
          error: null,
        }),
        upsert: (...args: unknown[]) => upsert(...(args as [])),
      });
      return chain;
    },
  }),
}));
vi.mock("@/lib/google-calendar/sync.server", () => ({
  syncManagerAvailabilityToGoogleCalendar: (...args: unknown[]) => syncToGoogle(...(args as [])),
}));
vi.mock("@/lib/tour-events.server", () => ({
  emitAvailabilityChangedEvent: (...args: unknown[]) => emitAvailabilityChanged(...(args as [])),
}));

const RECORD_ID = "axis_mgr_avail_slots_v2_comgr-1_prop_house-1";
const futureDay = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d.toISOString().slice(0, 10);
})();

function post(payload: string[]) {
  return new Request("http://localhost/api/portal-schedule-records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "upsert",
      row: { id: RECORD_ID, recordType: "manager_availability", propertyId: "house-1", payload },
    }),
  });
}

beforeEach(() => {
  syncToGoogle.mockClear();
  emitAvailabilityChanged.mockClear();
  upsert.mockClear();
  existingRow = null;
  propertyOwner = null;
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/portal-schedule-records — availability save side effects", () => {
  it("pushes to Google and announces the opened window to the property OWNER's team", async () => {
    propertyOwner = "owner-9";
    existingRow = { id: RECORD_ID, manager_user_id: "comgr-1", row_data: { payload: [] } };
    const { POST } = await import("@/app/api/portal-schedule-records/route");

    const res = await POST(post([`${futureDay}:20`, `${futureDay}:21`]));
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(1);

    expect(syncToGoogle).toHaveBeenCalledTimes(1);
    expect(syncToGoogle.mock.calls[0]![1]).toBe("comgr-1");
    expect(syncToGoogle.mock.calls[0]![2]).toMatchObject({ recordId: RECORD_ID, previousRowData: { payload: [] } });

    expect(emitAvailabilityChanged).toHaveBeenCalledTimes(1);
    const args = emitAvailabilityChanged.mock.calls[0]![1] as Record<string, unknown>;
    expect(args).toMatchObject({
      managerUserId: "owner-9",
      changedByUserId: "comgr-1",
      entityId: RECORD_ID,
      propertyId: "house-1",
    });
    expect(String(args.summary)).toMatch(/^opened /);
    expect(String(args.changeKey)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("falls back to the writer's own team when the house has no resolvable owner", async () => {
    propertyOwner = null;
    const { POST } = await import("@/app/api/portal-schedule-records/route");
    await POST(post([`${futureDay}:20`]));
    expect(emitAvailabilityChanged).toHaveBeenCalledTimes(1);
    expect((emitAvailabilityChanged.mock.calls[0]![1] as { managerUserId: string }).managerUserId).toBe("comgr-1");
  });

  it("does not announce a no-op save (same slots re-written) but still runs the Google push", async () => {
    existingRow = { id: RECORD_ID, manager_user_id: "comgr-1", row_data: { payload: [`${futureDay}:20`] } };
    const { POST } = await import("@/app/api/portal-schedule-records/route");
    await POST(post([`${futureDay}:20`]));
    expect(emitAvailabilityChanged).not.toHaveBeenCalled();
    expect(syncToGoogle).toHaveBeenCalledTimes(1);
  });

  it("keeps the save successful when both side effects throw", async () => {
    syncToGoogle.mockRejectedValueOnce(new Error("google down"));
    emitAvailabilityChanged.mockRejectedValueOnce(new Error("bus down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { POST } = await import("@/app/api/portal-schedule-records/route");
    const res = await POST(post([`${futureDay}:22`]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalled();
  });
});
