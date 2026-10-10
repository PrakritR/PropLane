import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  lastFetchedAt: null as string | null,
  updates: [] as Array<Record<string, unknown>>,
  updateError: false,
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        or: () => chain,
        like: () => chain,
        order: () => chain,
        range: () => chain,
        limit: () => chain,
        update: (value: Record<string, unknown>) => {
          if (state.updateError) throw new Error("db down");
          state.updates.push({ table, ...value });
          return chain;
        },
        then: (resolve: (value: unknown) => void) => resolve({ data: [], error: null }),
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/channel-calendar/sync.server", () => ({
  loadConnectionByExportToken: async () => ({ id: "c", property_id: "p", room_id: "r", manager_user_id: "m", export_last_fetched_at: state.lastFetchedAt }),
  loadPropertyRecord: async () => ({ property: null }),
}));

import { GET } from "@/app/api/calendar/export/[token]/route";
import { EXPORT_FETCH_STAMP_THROTTLE_MS, shouldStampExportFetch } from "@/lib/channel-calendar/export-fetch-stamp";

const request = (userAgent?: string) =>
  GET(new Request("https://example.com/api/calendar/export/token.ics", userAgent ? { headers: { "user-agent": userAgent } } : undefined), { params: Promise.resolve({ token: "token.ics" }) });

beforeEach(() => { state.lastFetchedAt = null; state.updates = []; state.updateError = false; });

describe("export route stamps export_last_fetched_at", () => {
  it("stamps for an Airbnb User-Agent (any case)", async () => {
    const response = await request("Mozilla/5.0 (compatible; AIRBNB-Calendar/1.0)");
    expect(response.status).toBe(200);
    expect(state.updates).toEqual([expect.objectContaining({ table: "external_calendar_connections", export_last_fetched_at: expect.any(String) })]);
  });

  it("does not stamp for a browser, another channel, or no User-Agent", async () => {
    await request("Mozilla/5.0 (Macintosh) Chrome/120");
    await request("Booking.com calendar fetcher");
    await request();
    expect(state.updates).toEqual([]);
  });

  it("throttles: no write when the last stamp is under five minutes old, a write once it is older", async () => {
    state.lastFetchedAt = new Date(Date.now() - 60_000).toISOString();
    await request("Airbnb");
    expect(state.updates).toEqual([]);
    state.lastFetchedAt = new Date(Date.now() - EXPORT_FETCH_STAMP_THROTTLE_MS - 1000).toISOString();
    await request("Airbnb");
    expect(state.updates).toHaveLength(1);
  });

  it("never fails the feed when the stamp write throws", async () => {
    state.updateError = true;
    const response = await request("Airbnb");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("BEGIN:VCALENDAR");
  });
});

describe("shouldStampExportFetch", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  it("stamps a never-fetched connection and an old one, not a recent one", () => {
    expect(shouldStampExportFetch({ userAgent: "Airbnb", lastFetchedAt: null, now })).toBe(true);
    expect(shouldStampExportFetch({ userAgent: "Airbnb", lastFetchedAt: "2026-10-09T11:00:00Z", now })).toBe(true);
    expect(shouldStampExportFetch({ userAgent: "Airbnb", lastFetchedAt: "2026-10-09T11:58:00Z", now })).toBe(false);
    expect(shouldStampExportFetch({ userAgent: "curl/8", lastFetchedAt: null, now })).toBe(false);
  });
});
