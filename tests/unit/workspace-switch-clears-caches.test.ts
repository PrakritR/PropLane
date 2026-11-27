// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #103 (mechanism A): opening another workspace is a navigation in the same tab, and sessionStorage survives it.
 * The schedule and property caches are not keyed by workspace, so the next workspace's first paint drew the previous
 * one's tours and houses. Every switch wipes them before navigating.
 */

vi.mock("@/lib/auth/fetch-with-timeout", () => ({
  fetchWithTimeout: vi.fn(async (url: string) =>
    new Response(JSON.stringify(url.includes("service-workspaces") ? { href: "/portal/dashboard" } : {}), { status: 200 }),
  ),
}));

import { readPartnerInquiries, resetScheduleClientCache } from "@/lib/demo-admin-scheduling";
import { clearWorkspaceScopedClientCaches } from "@/lib/workspaces/clear-client-caches";
import { openServiceWorkspace, switchToPropertyPortal } from "@/lib/service/open-service-workspace";

const ambikaInquiry = { id: "req-a1", propertyId: "house-a", name: "Ambika's prospect", status: "pending" };

function seed() {
  window.sessionStorage.setItem("axis_sched_cache_v1:axis_admin_partner_inquiries_v1", JSON.stringify([ambikaInquiry]));
  window.sessionStorage.setItem("axis_sched_cache_v1:__synced_at", String(Date.now()));
  window.sessionStorage.setItem("axis_property_pipeline_cache_v1:axis_manager_pending_by_user_v1", JSON.stringify({ u: [{ id: "house-a" }] }));
  window.sessionStorage.setItem("axis:manager-work-orders:v1", JSON.stringify([{ id: "wo-a" }]));
  window.sessionStorage.setItem("axis:household-charges:v1", JSON.stringify([{ id: "ch-a" }]));
  window.sessionStorage.setItem("proplane:workspaces:v1", JSON.stringify({ userId: "u", payload: { workspaces: [], activeWorkspaceId: null } }));
  window.sessionStorage.setItem("axis.applicationSetupToken.x", "token");
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetScheduleClientCache();
});
afterEach(() => vi.clearAllMocks());

describe("workspace switch clears workspace-scoped caches", () => {
  it("seeded schedule cache is readable before the clear and empty after", () => {
    seed();
    expect(readPartnerInquiries()).toEqual([ambikaInquiry]);
    clearWorkspaceScopedClientCaches();
    expect(readPartnerInquiries()).toEqual([]);
    expect(window.sessionStorage.getItem("axis_sched_cache_v1:__synced_at")).toBeNull();
    expect(window.sessionStorage.getItem("axis_property_pipeline_cache_v1:axis_manager_pending_by_user_v1")).toBeNull();
    expect(window.sessionStorage.getItem("axis:manager-work-orders:v1")).toBeNull();
    expect(window.sessionStorage.getItem("axis:household-charges:v1")).toBeNull();
  });

  it("keeps the workspace list and unrelated session keys", () => {
    seed();
    clearWorkspaceScopedClientCaches();
    expect(window.sessionStorage.getItem("proplane:workspaces:v1")).not.toBeNull();
    expect(window.sessionStorage.getItem("axis.applicationSetupToken.x")).toBe("token");
  });

  it("openServiceWorkspace wipes the caches BEFORE it navigates", async () => {
    seed();
    expect(readPartnerInquiries()).toHaveLength(1);
    let atNavigate: unknown[] | null = null;
    const navigate = vi.fn(() => {
      atNavigate = readPartnerInquiries();
    });
    expect(await openServiceWorkspace("ws-vinod", navigate)).toBeNull();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(atNavigate).toEqual([]);
    expect(window.sessionStorage.getItem("axis_sched_cache_v1:axis_admin_partner_inquiries_v1")).toBeNull();
  });

  it("a helper's ordinary switch and the Property-portal switch wipe them too", async () => {
    seed();
    const navigate = vi.fn();
    expect(await openServiceWorkspace("ws-vinod", navigate, { isAdmin: false })).toBeNull();
    expect(window.sessionStorage.getItem("axis:manager-work-orders:v1")).toBeNull();
    seed();
    expect(await switchToPropertyPortal("ws-own", navigate)).toBeNull();
    expect(window.sessionStorage.getItem("axis:manager-work-orders:v1")).toBeNull();
  });

  it("a failed switch leaves the caches alone", async () => {
    seed();
    const { fetchWithTimeout } = await import("@/lib/auth/fetch-with-timeout");
    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(new Response("{}", { status: 500 }));
    expect(await openServiceWorkspace("ws-vinod", vi.fn())).not.toBeNull();
    expect(window.sessionStorage.getItem("axis:manager-work-orders:v1")).not.toBeNull();
  });
});
