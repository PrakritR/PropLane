import { beforeEach, describe, expect, it, vi } from "vitest";

const VENDOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

type FeedRow = { version: number; revoked_at: string | null } | null;
const state = {
  feed: null as FeedRow,
  feedError: null as { code?: string; message: string } | null,
  upsertError: null as { message: string } | null,
  jobs: [] as Array<{ id: string; row_data: unknown }>,
  jobVendorFilter: "" as string,
};

function fakeDb() {
  return {
    from(table: string) {
      if (table === "vendor_calendar_feeds") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.feed, error: state.feedError }),
            }),
          }),
          upsert: async (payload: { version: number; revoked_at: null }) => {
            if (state.upsertError) return { error: state.upsertError };
            state.feed = { version: payload.version, revoked_at: payload.revoked_at };
            return { error: null };
          },
        };
      }
      return {
        select: () => ({
          eq: (_col: string, value: string) => {
            state.jobVendorFilter = value;
            return {
              order: () => ({
                range: async () => ({ data: state.jobs, error: null }),
              }),
            };
          },
        }),
      };
    },
  };
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => fakeDb() }));
const rateLimit = vi.fn(async () => ({ ok: true }) as { ok: boolean; unavailable?: true });
vi.mock("@/lib/rate-limit", () => ({ rateLimit: (...args: unknown[]) => (rateLimit as (...a: unknown[]) => unknown)(...args), clientIpFrom: () => "1.2.3.4" }));
const resolveVendor = vi.fn();
vi.mock("@/lib/auth/vendor-api-access", () => ({ resolveVendorPortalUserId: () => resolveVendor() }));

import {
  loadVendorCalendarFeedState,
  resetVendorCalendarFeed,
  vendorCalendarFeedToken,
  vendorCalendarFeedUrl,
  verifyVendorCalendarFeedToken,
} from "@/lib/vendor-calendar-feed.server";
import { GET as feedGet } from "@/app/api/calendar/vendor/[vendorUserId]/[token]/route";
import { GET as apiGet, POST as apiPost } from "@/app/api/vendor/calendar-feed/route";

const db = () => fakeDb() as never;

function feedRequest(vendorUserId: string, token: string) {
  return feedGet(new Request(`http://localhost/api/calendar/vendor/${vendorUserId}/${token}`), {
    params: Promise.resolve({ vendorUserId, token }),
  });
}

beforeEach(() => {
  state.feed = null;
  state.feedError = null;
  state.upsertError = null;
  state.jobs = [];
  rateLimit.mockResolvedValue({ ok: true });
  resolveVendor.mockReset();
});

describe("vendor calendar feed token", () => {
  it("is deterministic per (vendor, version) and differs across both", () => {
    expect(vendorCalendarFeedToken(VENDOR, 1)).toBe(vendorCalendarFeedToken(VENDOR, 1));
    expect(vendorCalendarFeedToken(VENDOR, 1)).not.toBe(vendorCalendarFeedToken(VENDOR, 2));
    expect(vendorCalendarFeedToken(VENDOR, 1)).not.toBe(vendorCalendarFeedToken(OTHER, 1));
  });

  it("builds the .ics URL from origin, vendor id and token", () => {
    const url = vendorCalendarFeedUrl("https://proplane.ai/", VENDOR, 1);
    expect(url).toBe(`https://proplane.ai/api/calendar/vendor/${VENDOR}/${vendorCalendarFeedToken(VENDOR, 1)}.ics`);
  });

  it("treats an absent row, or a table that is not migrated yet, as version 1 and not revoked", async () => {
    expect(await loadVendorCalendarFeedState(db(), VENDOR)).toEqual({ version: 1, revoked: false });
    state.feedError = { code: "42P01", message: 'relation "public.vendor_calendar_feeds" does not exist' };
    expect(await loadVendorCalendarFeedState(db(), VENDOR)).toEqual({ version: 1, revoked: false });
  });

  it("surfaces any other database error instead of guessing", async () => {
    state.feedError = { message: "connection reset" };
    await expect(loadVendorCalendarFeedState(db(), VENDOR)).rejects.toThrow("connection reset");
  });

  it("accepts the valid token (with or without .ics) and rejects wrong token, wrong vendor, malformed id", async () => {
    const token = vendorCalendarFeedToken(VENDOR, 1);
    expect(await verifyVendorCalendarFeedToken(db(), VENDOR, token)).toBe(true);
    expect(await verifyVendorCalendarFeedToken(db(), VENDOR, `${token}.ics`)).toBe(true);
    expect(await verifyVendorCalendarFeedToken(db(), VENDOR, `${token.slice(0, -1)}x`)).toBe(false);
    expect(await verifyVendorCalendarFeedToken(db(), VENDOR, "short")).toBe(false);
    expect(await verifyVendorCalendarFeedToken(db(), OTHER, token)).toBe(false);
    expect(await verifyVendorCalendarFeedToken(db(), "not-a-uuid", token)).toBe(false);
  });

  it("reset bumps the version, so the old token goes stale and the new one works", async () => {
    const oldToken = vendorCalendarFeedToken(VENDOR, 1);
    expect(await resetVendorCalendarFeed(db(), VENDOR)).toEqual({ ok: true, version: 2 });
    expect(await verifyVendorCalendarFeedToken(db(), VENDOR, oldToken)).toBe(false);
    expect(await verifyVendorCalendarFeedToken(db(), VENDOR, vendorCalendarFeedToken(VENDOR, 2))).toBe(true);
    expect(await resetVendorCalendarFeed(db(), VENDOR)).toEqual({ ok: true, version: 3 });
  });

  it("a revoked feed rejects even the current token", async () => {
    state.feed = { version: 1, revoked_at: "2026-10-06T00:00:00Z" };
    expect(await verifyVendorCalendarFeedToken(db(), VENDOR, vendorCalendarFeedToken(VENDOR, 1))).toBe(false);
  });

  it("reports a failed upsert as not ok", async () => {
    state.upsertError = { message: "boom" };
    expect(await resetVendorCalendarFeed(db(), VENDOR)).toEqual({ ok: false });
  });
});

describe("public feed route", () => {
  const job = {
    id: "wo-1",
    row_data: {
      id: "wo-1",
      title: "Fix sink",
      bucket: "scheduled",
      propertyName: "Maple House",
      unit: "—",
      propertyAddress: "123 Main St, Seattle, WA 98101",
      scheduledAtIso: "2026-10-08T17:00:00.000Z",
      vendorId: "v1",
    },
  };

  it("serves text/calendar for a valid token, uncached, with only this vendor's jobs query", async () => {
    state.jobs = [job];
    const res = await feedRequest(VENDOR, `${vendorCalendarFeedToken(VENDOR, 1)}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.text();
    expect(body).toContain("X-WR-CALNAME:PropLane jobs");
    expect(body).toContain("UID:wo-1@proplane.ai");
    expect(body).toContain("LOCATION:123 Main St\\, Seattle\\, WA 98101");
    expect(state.jobVendorFilter).toBe(VENDOR);
  });

  it("404s a wrong token, a token for another vendor, and a stale token after reset, with no detail", async () => {
    state.jobs = [job];
    for (const [vendor, token] of [
      [VENDOR, "nope"],
      [OTHER, vendorCalendarFeedToken(VENDOR, 1)],
      [VENDOR, `${vendorCalendarFeedToken(VENDOR, 1).slice(0, -1)}A.ics`],
    ] as const) {
      const res = await feedRequest(vendor, token);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not found");
    }
    const oldToken = vendorCalendarFeedToken(VENDOR, 1);
    await resetVendorCalendarFeed(db(), VENDOR);
    expect((await feedRequest(VENDOR, `${oldToken}.ics`)).status).toBe(404);
    expect((await feedRequest(VENDOR, `${vendorCalendarFeedToken(VENDOR, 2)}.ics`)).status).toBe(200);
  });

  it("rate limits", async () => {
    rateLimit.mockResolvedValue({ ok: false });
    expect((await feedRequest(VENDOR, vendorCalendarFeedToken(VENDOR, 1))).status).toBe(429);
  });
});

describe("authenticated feed API", () => {
  it("401s a non-vendor on GET and POST", async () => {
    resolveVendor.mockResolvedValue({ ok: false, status: 401 });
    expect((await apiGet(new Request("http://localhost/api/vendor/calendar-feed"))).status).toBe(401);
    const post = await apiPost(new Request("http://localhost/api/vendor/calendar-feed", { method: "POST", body: JSON.stringify({ action: "reset" }) }));
    expect(post.status).toBe(401);
    expect(state.feed).toBeNull();
  });

  it("403s a signed-in non-vendor", async () => {
    resolveVendor.mockResolvedValue({ ok: false, status: 403 });
    expect((await apiGet(new Request("http://localhost/api/vendor/calendar-feed"))).status).toBe(403);
  });

  it("GET returns the current URL; POST reset rotates it and invalidates the old one", async () => {
    resolveVendor.mockResolvedValue({ ok: true, userId: VENDOR });
    const first = (await (await apiGet(new Request("http://localhost/api/vendor/calendar-feed"))).json()) as { ok: boolean; url: string; revoked: boolean };
    expect(first.ok).toBe(true);
    expect(first.revoked).toBe(false);
    expect(first.url).toContain(`/api/calendar/vendor/${VENDOR}/${vendorCalendarFeedToken(VENDOR, 1)}.ics`);
    const res = await apiPost(new Request("http://localhost/api/vendor/calendar-feed", { method: "POST", body: JSON.stringify({ action: "reset" }) }));
    const next = (await res.json()) as { url: string };
    expect(next.url).toContain(vendorCalendarFeedToken(VENDOR, 2));
    expect(next.url).not.toBe(first.url);
  });

  it("surfaces a failed reset as 503 and rejects an unknown action with 400", async () => {
    resolveVendor.mockResolvedValue({ ok: true, userId: VENDOR });
    state.upsertError = { message: "boom" };
    const failed = await apiPost(new Request("http://localhost/api/vendor/calendar-feed", { method: "POST", body: JSON.stringify({ action: "reset" }) }));
    expect(failed.status).toBe(503);
    const bad = await apiPost(new Request("http://localhost/api/vendor/calendar-feed", { method: "POST", body: JSON.stringify({ action: "delete" }) }));
    expect(bad.status).toBe(400);
  });
});
