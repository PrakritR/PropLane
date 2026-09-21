import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const loadManagerTourSettings = vi.fn();
const saveManagerTourSettings = vi.fn();

function managerDb() {
  return {
    from: vi.fn((table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { role: "manager" } }),
            }),
          }),
        };
      }
      if (table === "profile_roles") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: [{ role: "manager" }] }),
          }),
        };
      }
      // `manager_property_records` — no propertyId/workspaceId is named in
      // these tests, so this only backs `listPropertyOverrides` (property
      // override listing) and the analytics count query; empty is correct.
      if (table === "manager_property_records") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: [], error: null, count: 0 }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
        }),
      };
    }),
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(() => managerDb()),
}));
vi.mock("@/lib/manager-tour-settings", () => ({
  loadManagerTourSettings: (...a: unknown[]) => loadManagerTourSettings(...a),
  saveManagerTourSettings: (...a: unknown[]) => saveManagerTourSettings(...a),
  normalizeManagerTourSettings: (raw: unknown) => raw,
}));

const route = await import("@/app/api/portal/manager-tour-settings/route");

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: "mgr-1", user_metadata: { role: "manager" } } } });
  loadManagerTourSettings.mockResolvedValue({ tourNoticeDays: 0 });
  saveManagerTourSettings.mockResolvedValue({ tourNoticeDays: 1 });
});

describe("GET /api/portal/manager-tour-settings", () => {
  it("returns tour settings for an authenticated manager", async () => {
    const res = await route.GET(new Request("http://localhost/api/portal/manager-tour-settings"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      settings: { tourNoticeDays: 0 },
      scope: "workspace",
      inherited: false,
      overriddenPropertyIds: [],
      source: "account",
    });
    expect(loadManagerTourSettings).toHaveBeenCalledWith(expect.anything(), "mgr-1");
  });

  it("refuses unauthenticated callers", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const res = await route.GET(new Request("http://localhost/api/portal/manager-tour-settings"));
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/portal/manager-tour-settings", () => {
  it("persists notice days", async () => {
    const res = await route.PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({ tourNoticeDays: 1 }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      settings: { tourNoticeDays: 1 },
      scope: "workspace",
      inherited: false,
      overriddenPropertyIds: [],
      source: "account",
    });
    expect(saveManagerTourSettings).toHaveBeenCalledWith(expect.anything(), "mgr-1", { tourNoticeDays: 1 });
  });
});
