/**
 * `POST /api/portal/listing-prefill`.
 *
 * Pins the order the route promises: signed-in → cache (free) → quota →
 * provider; the fixture provider's stable answers; the Free plan's fourth
 * lookup refused; and that no second search runs beside the records lookup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUser, tierResult, rows, track, fetchSpy } = vi.hoisted(() => ({
  getUser: vi.fn(),
  tierResult: { value: { ok: true, tier: null } as { ok: true; tier: "free" | "pro" | "business" | null } | { ok: false; error: string } },
  rows: {
    cache: new Map<string, Record<string, unknown>>(),
    usage: new Map<string, number>(),
  },
  track: vi.fn(),
  fetchSpy: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/tools/context", () => ({
  resolveAgentContext: async () => {
    const { data } = await getUser();
    return data.user ? { userId: data.user.id, role: "manager" } : null;
  },
}));
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: async () => tierResult.value,
}));
vi.mock("@/lib/analytics/posthog", () => ({ track }));
vi.mock("@/lib/observability/langfuse", () => ({ traceAgentTurn: async (_a: unknown, _b: unknown, run: () => Promise<unknown>) => run() }));

/** Just enough of the query builder for the two tables the route touches. */
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        },
        gte: () => chain,
        maybeSingle: async () => {
          if (table === "listing_prefill_cache") {
            const hit = rows.cache.get(String(filters.address_key));
            return { data: hit && (!filters.source || hit.source === filters.source) ? hit : null, error: null };
          }
          const count = rows.usage.get(`${filters.manager_user_id}|${filters.month}`);
          return { data: count == null ? null : { count }, error: null };
        },
        upsert: async (row: Record<string, unknown>) => {
          if (table === "listing_prefill_cache") rows.cache.set(String(row.address_key), row);
          else rows.usage.set(`${row.manager_user_id}|${row.month}`, Number(row.count));
          return { error: null };
        },
      };
      return chain;
    },
  }),
}));

import { POST as prefill } from "@/app/api/portal/listing-prefill/route";

const USER = { id: "11111111-1111-1111-1111-111111111111" };

function req(path: string, body: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ADDRESS = { address: "142 Ash St", city: "Seattle", state: "WA", zip: "98109" };

beforeEach(() => {
  vi.clearAllMocks();
  rows.cache.clear();
  rows.usage.clear();
  tierResult.value = { ok: true, tier: null };
  getUser.mockResolvedValue({ data: { user: USER } });
  process.env.LISTING_PREFILL_PROVIDER = "fixture";
  delete process.env.VERCEL_ENV;
  delete process.env.ANTHROPIC_API_KEY;
  vi.stubGlobal("fetch", fetchSpy);
});

describe("POST /api/portal/listing-prefill", () => {
  it("rejects a signed-out caller", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const res = await prefill(req("/api/portal/listing-prefill", ADDRESS));
    expect(res.status).toBe(401);
  });

  it("stays dark without a provider", async () => {
    delete process.env.LISTING_PREFILL_PROVIDER;
    delete process.env.RENTCAST_API_KEY;
    const res = await prefill(req("/api/portal/listing-prefill", ADDRESS));
    const body = await res.json();
    expect(body.status).toBe("unavailable");
    expect(rows.usage.size).toBe(0);
  });

  it("answers found with facts and a rent estimate, nothing else, and spends one lookup", async () => {
    const res = await prefill(req("/api/portal/listing-prefill", ADDRESS));
    const body = await res.json();
    expect(body.status).toBe("found");
    expect(body.facts.bedrooms).toBeGreaterThan(0);
    expect(body.rent.rentUsd).toBeGreaterThan(0);
    // Facts only: no earlier-ad pointer rides along any more.
    expect(body).not.toHaveProperty("priorAd");
    expect(body.cached).toBe(false);
    expect(body.lookupsLeft).toBe(2);
    expect(body.source).toBe("fixture");
    // The fixture never touches the network.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves a repeat address from the cache without spending a lookup", async () => {
    await prefill(req("/api/portal/listing-prefill", ADDRESS));
    const res = await prefill(req("/api/portal/listing-prefill", { ...ADDRESS, address: " 142  ash st " }));
    const body = await res.json();
    expect(body.cached).toBe(true);
    expect(body.status).toBe("found");
    expect([...rows.usage.values()]).toEqual([1]);
  });

  it("never replays a fixture answer for a real-provider lookup", async () => {
    await prefill(req("/api/portal/listing-prefill", ADDRESS));
    expect([...rows.cache.values()][0]!.source).toBe("fixture");
    delete process.env.LISTING_PREFILL_PROVIDER;
    process.env.RENTCAST_API_KEY = "test-key";
    fetchSpy.mockResolvedValue({ ok: false, status: 404, json: async () => null });
    const res = await prefill(req("/api/portal/listing-prefill", ADDRESS));
    const body = await res.json();
    // The fixture row was skipped: RentCast was asked (and answered 404 → none).
    expect(fetchSpy).toHaveBeenCalled();
    expect(body.cached).toBe(false);
    expect(body.status).toBe("none");
    delete process.env.RENTCAST_API_KEY;
  });

  it("refuses the Free plan's fourth lookup of the month", async () => {
    for (const n of [1, 2, 3]) {
      const res = await prefill(req("/api/portal/listing-prefill", { ...ADDRESS, address: `${n} Pine St` }));
      expect((await res.json()).status).toBe("found");
    }
    const res = await prefill(req("/api/portal/listing-prefill", { ...ADDRESS, address: "4 Pine St" }));
    const body = await res.json();
    expect(body.status).toBe("quota");
    expect(body.lookupsLeft).toBe(0);
  });

  it("never caps a Pro workspace", async () => {
    tierResult.value = { ok: true, tier: "pro" };
    for (const n of [1, 2, 3, 4, 5]) {
      const res = await prefill(req("/api/portal/listing-prefill", { ...ADDRESS, address: `${n} Pine St` }));
      const body = await res.json();
      expect(body.status).toBe("found");
      expect(body.lookupsLeft).toBeNull();
    }
  });

  it("reports an unreadable plan as an error rather than guessing Free or unlimited", async () => {
    tierResult.value = { ok: false, error: "db down" };
    const res = await prefill(req("/api/portal/listing-prefill", ADDRESS));
    expect((await res.json()).status).toBe("error");
  });

  it("answers none for an address with no record", async () => {
    const res = await prefill(req("/api/portal/listing-prefill", { ...ADDRESS, address: "9 Nowhere Ln" }));
    const body = await res.json();
    expect(body.status).toBe("none");
    expect(body.facts).toBeNull();
  });
});
