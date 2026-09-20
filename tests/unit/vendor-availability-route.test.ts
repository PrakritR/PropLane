import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../helpers/api-request";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  services: [] as Row[],
  inserts: [] as Row[],
  filters: [] as Array<[string, string, unknown]>,
  ranges: [] as Array<[number, number]>,
}));

const mocks = vi.hoisted(() => ({
  resolveVendorPortalUserId: vi.fn(),
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/auth/vendor-api-access", () => ({
  resolveVendorPortalUserId: mocks.resolveVendorPortalUserId,
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: mocks.createSupabaseServiceRoleClient,
}));

function fakeDb() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let range: [number, number] | null = null;
      const api = {
        select() {
          return api;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          state.filters.push([table, column, value]);
          return api;
        },
        insert(row: Row) {
          state.inserts.push(row);
          return api;
        },
        order() {
          return api;
        },
        range(from: number, to: number) {
          range = [from, to];
          state.ranges.push(range);
          return api;
        },
        single() {
          const row = state.inserts.at(-1);
          return Promise.resolve({ data: row ? { ...row, id: "availability-1" } : null, error: null });
        },
        then(resolve: (value: { data: Row[]; error: null }) => unknown) {
          const rows = table === "portal_work_order_records"
            ? state.services.filter((row) => filters.every(([column, value]) => row[column] === value))
            : [];
          const ordered = [...rows].sort((left, right) => String(left.id).localeCompare(String(right.id)));
          return Promise.resolve(resolve({ data: range ? ordered.slice(range[0], range[1] + 1) : ordered, error: null }));
        },
      };
      return api;
    },
  };
}

import { POST } from "@/app/api/vendor/availability/route";

describe("vendor availability route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.services = [];
    state.inserts = [];
    state.filters = [];
    state.ranges = [];
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: "vendor-1" });
    mocks.createSupabaseServiceRoleClient.mockReturnValue(fakeDb());
  });

  it.each([
    ["open", { action: "upsert-open", specificDate: "2026-06-15", startMinute: 570, endMinute: 630 }],
    ["block", { action: "upsert-block", specificDate: "2026-06-15", startMinute: 570, endMinute: 630 }],
    ["weekly", { action: "upsert-weekly", weekday: 1, startMinute: 570, endMinute: 630 }],
  ])("rejects a %s window that overlaps the vendor's booked service", async (_kind, body) => {
    state.services = [
      {
        id: "booked-service",
        vendor_user_id: "vendor-1",
        row_data: { bucket: "scheduled", scheduledAtIso: "2026-06-15T16:00:00.000Z" },
      },
      {
        id: "other-vendor-service",
        vendor_user_id: "vendor-2",
        row_data: { bucket: "scheduled", scheduledAtIso: "2026-06-15T16:00:00.000Z" },
      },
    ];

    const response = await POST(jsonRequest("http://t/api/vendor/availability", {
      method: "POST",
      body,
    }));
    const { status, data } = await parseJsonResponse<{ error?: string }>(response);

    expect(status).toBe(409);
    expect(data.error).toMatch(/overlaps a scheduled service/i);
    expect(state.inserts).toEqual([]);
    expect(state.filters).toContainEqual(["portal_work_order_records", "vendor_user_id", "vendor-1"]);
  });

  it("allows a Pacific window touching a booked service's end, ignoring completed, cancelled, and other-vendor rows", async () => {
    state.services = [
      {
        id: "booked-service",
        vendor_user_id: "vendor-1",
        row_data: { bucket: "completed", scheduledAtIso: "2026-06-15T16:00:00.000Z" },
      },
      {
        id: "cancelled-service",
        vendor_user_id: "vendor-1",
        row_data: { bucket: "cancelled", scheduledAtIso: "2026-06-15T16:00:00.000Z" },
      },
      {
        id: "booked-service",
        vendor_user_id: "vendor-1",
        row_data: { bucket: "scheduled", scheduledAtIso: "2026-06-15T16:00:00.000Z" },
      },
      {
        id: "other-vendor-service",
        vendor_user_id: "vendor-2",
        row_data: { bucket: "scheduled", scheduledAtIso: "2026-06-15T16:00:00.000Z" },
      },
    ];

    const response = await POST(jsonRequest("http://t/api/vendor/availability", {
      method: "POST",
      body: { action: "upsert-open", specificDate: "2026-06-15", startMinute: 600, endMinute: 630 },
    }));
    const { status, data } = await parseJsonResponse<{ ok?: boolean }>(response);

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(state.inserts).toHaveLength(1);
  });

  it("checks a booked service beyond the first database page", async () => {
    state.services = [
      ...Array.from({ length: 500 }, (_, index) => ({
        id: `complete-${String(index).padStart(3, "0")}`,
        vendor_user_id: "vendor-1",
        row_data: { bucket: "completed", scheduledAtIso: "2026-03-08T16:00:00.000Z" },
      })),
      { id: "z-booked", vendor_user_id: "vendor-1", row_data: { bucket: "scheduled", scheduledAtIso: "2026-03-08T16:00:00.000Z" } },
    ];

    const response = await POST(jsonRequest("http://t/api/vendor/availability", {
      method: "POST",
      body: { action: "upsert-open", specificDate: "2026-03-08", startMinute: 570, endMinute: 630 },
    }));

    expect(response.status).toBe(409);
    expect(state.ranges).toEqual([[0, 499], [500, 999]]);
  });

  it("rejects impossible calendar dates before checking services", async () => {
    const response = await POST(jsonRequest("http://t/api/vendor/availability", {
      method: "POST",
      body: { action: "upsert-open", specificDate: "2026-02-31", startMinute: 540, endMinute: 570 },
    }));
    expect(response.status).toBe(400);
    expect(state.ranges).toEqual([]);
  });

  it("rejects a nonexistent Pacific spring-forward time and accepts a valid fall-back time", async () => {
    const missing = await POST(jsonRequest("http://t/api/vendor/availability", {
      method: "POST",
      body: { action: "upsert-open", specificDate: "2026-03-08", startMinute: 150, endMinute: 180 },
    }));
    expect(missing.status).toBe(400);

    const fallback = await POST(jsonRequest("http://t/api/vendor/availability", {
      method: "POST",
      body: { action: "upsert-open", specificDate: "2026-11-01", startMinute: 90, endMinute: 120 },
    }));
    expect(fallback.status).toBe(200);
  });
});
