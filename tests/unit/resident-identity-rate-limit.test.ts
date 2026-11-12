import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  actor: vi.fn(),
  limit: vi.fn(),
  calls: [] as unknown[][],
}));
vi.mock("@/lib/resident-identity/auth.server", () => ({ residentIdentityActor: h.actor }));
vi.mock("@/lib/resident-identity/persona.server", () => ({ personaEnabled: () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "resident-1" } } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => {
    throw new Error("must not reach the database when throttled");
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: (...args: unknown[]) => {
    h.calls.push(args);
    return h.limit();
  },
}));

import { POST as start } from "@/app/api/resident/identity/route";
import { POST as retry } from "@/app/api/resident/identity/retry/route";
import { POST as manualReview } from "@/app/api/resident/identity/manual-review/route";

beforeEach(() => {
  h.actor.mockReset();
  h.limit.mockReset();
  h.calls.length = 0;
  process.env.RESIDENT_IDENTITY_ENABLED = "true"; process.env.RESIDENT_IDENTITY_PROVIDER = "persona";
  h.actor.mockResolvedValue({ userId: "resident-1", db: {} });
});

describe("resident identity writes are rate limited per resident", () => {
  it.each([
    ["start", start],
    ["retry", retry],
    ["manual review", manualReview],
  ])("%s answers 429 once the budget is spent, before any database work", async (_name, handler) => {
    h.limit.mockResolvedValue({ ok: false });
    const res = await handler();
    expect(res.status).toBe(429);
    expect(h.calls[0]).toEqual(["resident-identity:resident-1", 10, 60_000]);
  });

  it("an unavailable limiter fails closed with 503", async () => {
    h.limit.mockResolvedValue({ ok: false, unavailable: true });
    expect((await retry()).status).toBe(503);
  });
});
