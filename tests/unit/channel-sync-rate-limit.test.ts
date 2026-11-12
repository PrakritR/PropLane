import { beforeEach, describe, expect, it, vi } from "vitest";

const requireManagerRouteUser = vi.fn();
const rateLimit = vi.fn();
const syncIds = vi.fn();

vi.mock("@/lib/manager-route-guard.server", () => ({ requireManagerRouteUser: () => requireManagerRouteUser() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: (...a: unknown[]) => rateLimit(...a) }));
vi.mock("@/lib/channel-calendar/sync.server", () => ({
  syncChannelCalendarConnectionIds: (...a: unknown[]) => syncIds(...a),
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerCanWriteCalendarForProperties: async () => new Set<string>(),
}));

const { POST } = await import("@/app/api/portal/channel-calendar/sync-all/route");

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/portal/channel-calendar/sync-all", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  const query: Record<string, unknown> = {
    in: () => query,
    eq: () => query,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
  };
  requireManagerRouteUser.mockResolvedValue({ userId: "mgr-1", db: { from: () => ({ select: () => query }) } });
  rateLimit.mockResolvedValue({ ok: true });
  syncIds.mockResolvedValue({ synced: 0, failed: 0, skipped: 0 });
});

describe("POST channel-calendar/sync-all", () => {
  it("rate limits per user at 20 a minute and answers 429", async () => {
    rateLimit.mockResolvedValue({ ok: false });
    const res = await post({});
    expect(res.status).toBe(429);
    expect(rateLimit).toHaveBeenCalledWith("channel-sync:mgr-1", 20, 60_000);
    expect(syncIds).not.toHaveBeenCalled();
  });

  it("refuses more than 50 propertyIds", async () => {
    const res = await post({ propertyIds: Array.from({ length: 51 }, (_, i) => `p${i}`) });
    expect(res.status).toBe(400);
    expect(syncIds).not.toHaveBeenCalled();
  });

  it("accepts exactly 50", async () => {
    const res = await post({ propertyIds: Array.from({ length: 50 }, (_, i) => `p${i}`) });
    expect(res.status).toBe(200);
  });
});

describe("Sync all now from a portfolio larger than the cap", () => {
  it("sends sequential batches of at most the cap and merges their counts", async () => {
    const { syncAllChannelCalendarConnections } = await import("@/lib/channel-calendar/client");
    const { MAX_SYNC_ALL_PROPERTY_IDS } = await import("@/lib/channel-calendar/types");
    const batches: string[][] = [];
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { propertyIds: string[]; force?: boolean };
      batches.push(body.propertyIds);
      expect(body.force).toBe(true);
      return { ok: true, json: async () => ({ synced: 2, failed: 1, skipped: 3 }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const ids = Array.from({ length: MAX_SYNC_ALL_PROPERTY_IDS * 2 + 1 }, (_, i) => `p${i}`);
      const total = await syncAllChannelCalendarConnections(ids, { force: true });
      expect(batches.map((b) => b.length)).toEqual([MAX_SYNC_ALL_PROPERTY_IDS, MAX_SYNC_ALL_PROPERTY_IDS, 1]);
      expect(batches.flat()).toEqual(ids);
      expect(total).toEqual({ synced: 6, failed: 3, skipped: 9 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still asks once, with no ids, for every connection the manager owns", async () => {
    const { syncAllChannelCalendarConnections } = await import("@/lib/channel-calendar/client");
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ synced: 1, failed: 0, skipped: 0 }) }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await syncAllChannelCalendarConnections([])).toEqual({ synced: 1, failed: 0, skipped: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
