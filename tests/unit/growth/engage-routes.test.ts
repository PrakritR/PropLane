import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const build = vi.fn(async () => ({ forDate: "2026-10-09", considered: 0, inserted: 0, skipped: 0 }));
vi.mock("@/lib/growth/engage/build.server", () => ({ buildEngageList: build }));

const root = process.cwd();

describe("growth-engage cron auth", () => {
  beforeEach(() => {
    build.mockClear();
    vi.stubEnv("CRON_SECRET", "s3cret");
  });
  it("rejects a missing or wrong bearer", async () => {
    const { GET } = await import("@/app/api/cron/growth-engage/route");
    expect((await GET(new Request("http://x/api/cron/growth-engage"))).status).toBe(401);
    expect((await GET(new Request("http://x/api/cron/growth-engage", { headers: { authorization: "Bearer nope" } }))).status).toBe(401);
    expect(build).not.toHaveBeenCalled();
  });
  it("runs with the right bearer", async () => {
    const { GET } = await import("@/app/api/cron/growth-engage/route");
    const res = await GET(new Request("http://x/api/cron/growth-engage", { headers: { authorization: "Bearer s3cret" } }));
    expect(res.status).toBe(200);
    expect(build).toHaveBeenCalledOnce();
  });
  it("is scheduled at 12:00 UTC", () => {
    const cfg = JSON.parse(readFileSync(`${root}/vercel.json`, "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(cfg.crons).toContainEqual({ path: "/api/cron/growth-engage", schedule: "0 12 * * *" });
  });
});

describe("admin engage routes go through adminRoute", () => {
  for (const f of [
    "engage/route.ts",
    "engage/[id]/route.ts",
    "engage/build-now/route.ts",
    "watchlist/route.ts",
    "watchlist/[id]/route.ts",
    "keywords/route.ts",
  ]) {
    it(f, () => {
      const src = readFileSync(`${root}/src/app/api/admin/growth/${f}`, "utf8");
      const handlers = src.match(/export async function (GET|POST|PATCH|DELETE)/g) ?? [];
      expect(handlers.length).toBeGreaterThan(0);
      expect((src.match(/return adminRoute\(/g) ?? []).length).toBe(handlers.length);
    });
  }
});

describe("admin engage route rejects non-admins", () => {
  it("returns the guard response", async () => {
    vi.resetModules();
    vi.doMock("@/lib/admin/admin-route-guard.server", () => ({
      requireAdminRoute: async () => ({ ok: false, response: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) }),
    }));
    const { GET } = await import("@/app/api/admin/growth/engage/route");
    expect((await GET(new Request("http://x/api/admin/growth/engage"))).status).toBe(403);
  });
});
