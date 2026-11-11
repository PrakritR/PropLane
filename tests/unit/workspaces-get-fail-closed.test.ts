/**
 * GET /api/workspaces runs the workspace list and the plan's reads together. The access check still gates both:
 * a refused actor never reaches either read, and a failure of either read fails the whole request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
  user: { id: "u" } as { id: string } | null,
  access: "allowed" as "allowed" | "denied",
  loadWorkspaces: vi.fn(),
  readWorkspacePlanInputs: vi.fn(),
  loadWorkspacePlan: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: state.access === "denied" ? "denied" : "normal" }),
}));
vi.mock("@/lib/workspaces/server", () => ({
  loadWorkspaces: (...args: unknown[]) => state.loadWorkspaces(...args),
  readWorkspacePlanInputs: (...args: unknown[]) => state.readWorkspacePlanInputs(...args),
  loadWorkspacePlan: (...args: unknown[]) => state.loadWorkspacePlan(...args),
}));
vi.mock("@/lib/service/service-mode.server", () => ({
  loadServiceStaffIds: async () => ({ ids: new Set<string>(), failed: false }),
}));
vi.mock("@/lib/property-owner/route-auth.server", () => ({ refuseOwnerOnly: async () => null }));

const route = await import("@/app/api/workspaces/route");

beforeEach(() => {
  state.user = { id: USER };
  state.access = "allowed";
  state.loadWorkspaces.mockReset().mockResolvedValue([
    { id: "w1", name: "Homes", ownerUserId: USER, owned: true, isDefault: true, propertyIds: [], propertyPermissions: {} },
  ]);
  state.readWorkspacePlanInputs.mockReset().mockResolvedValue({ marker: "reads" });
  state.loadWorkspacePlan.mockReset().mockResolvedValue({ tier: "pro", unknown: false });
});

describe("GET /api/workspaces fails closed", () => {
  it("signed out: 401 and neither read starts", async () => {
    state.user = null;
    const res = await route.GET();
    expect(res.status).toBe(401);
    expect(state.loadWorkspaces).not.toHaveBeenCalled();
    expect(state.readWorkspacePlanInputs).not.toHaveBeenCalled();
  });

  it("a refused test-workspace actor: 403 and neither read starts", async () => {
    state.access = "denied";
    const res = await route.GET();
    expect(res.status).toBe(403);
    expect(state.loadWorkspaces).not.toHaveBeenCalled();
    expect(state.readWorkspacePlanInputs).not.toHaveBeenCalled();
    expect(state.loadWorkspacePlan).not.toHaveBeenCalled();
  });

  it("an allowed actor gets both reads, the plan is built from the pre-read inputs, and Server-Timing is set", async () => {
    const res = await route.GET();
    expect(res.status).toBe(200);
    expect(state.loadWorkspaces).toHaveBeenCalledTimes(1);
    expect(state.readWorkspacePlanInputs).toHaveBeenCalledTimes(1);
    expect(state.loadWorkspacePlan.mock.calls[0]?.[3]).toEqual({ marker: "reads" });
    const timing = res.headers.get("Server-Timing") ?? "";
    expect(timing).toMatch(/auth;dur=/);
    expect(timing).toMatch(/total;dur=/);
    // Names and numbers only: nothing from the user or a row.
    expect(timing).not.toContain(USER);
  });

  it("a failed workspace list is a 503, never a partial answer", async () => {
    state.loadWorkspaces.mockRejectedValue(new Error("db down"));
    const res = await route.GET();
    expect(res.status).toBe(503);
    expect(state.loadWorkspacePlan).not.toHaveBeenCalled();
  });

  it("a failed plan read is a 503, never a list with a guessed plan", async () => {
    state.readWorkspacePlanInputs.mockRejectedValue(new Error("tier lookup failed"));
    const res = await route.GET();
    expect(res.status).toBe(503);
    expect(state.loadWorkspacePlan).not.toHaveBeenCalled();
  });
});
