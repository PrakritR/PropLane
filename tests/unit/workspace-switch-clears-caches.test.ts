// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #103 (mechanism A): opening another workspace is a navigation in the same tab, and sessionStorage survives it.
 * The schedule and property caches are not keyed by workspace, so the next workspace's first paint drew the previous
 * one's tours and houses. Every switch wipes them before navigating.
 */

vi.mock("@/lib/auth/fetch-with-timeout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/fetch-with-timeout")>()),
  fetchWithTimeout: vi.fn(async (url: string) =>
    new Response(JSON.stringify(url.includes("service-workspaces") ? { href: "/portal/dashboard" } : {}), { status: 200 }),
  ),
}));

import { readPartnerInquiries, resetScheduleClientCache } from "@/lib/demo-admin-scheduling";
import { clearWorkspaceScopedClientCaches } from "@/lib/workspaces/clear-client-caches";
import { openServiceWorkspace, switchToPropertyPortal } from "@/lib/service/open-service-workspace";
import { readManagerWorkOrderRows, syncManagerWorkOrdersFromServer } from "@/lib/manager-work-orders-storage";
import { readManagerPromotionRows, syncManagerPromotionsFromServer } from "@/lib/manager-promotions-storage";
import { readManagerVendorRows, syncManagerVendorsFromServer } from "@/lib/manager-vendors-storage";
import {
  readAllServiceRequests,
  serviceRequestsLastReadSucceeded,
  syncServiceRequestsFromServer,
} from "@/lib/service-requests-storage";

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

// A client-side switch (the switcher's router.push) keeps every module's memory mirror. A sync inside the 15s TTL
// answered from that mirror, so workspace B drew A's rows. After the clear, the next sync must hit the server.
describe("workspace switch resets in-memory store mirrors", () => {
  const rowsFetch = (rows: unknown[]) =>
    vi.fn(async () => new Response(JSON.stringify({ rows }), { status: 200, headers: { "Content-Type": "application/json" } }));
  beforeEach(() => window.history.replaceState(null, "", "/portal/dashboard"));
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("work orders: memory is empty after the switch and the next sync refetches inside the TTL", async () => {
    const first = rowsFetch([{ id: "wo-a" }]);
    vi.stubGlobal("fetch", first);
    expect((await syncManagerWorkOrdersFromServer()).map((r) => r.id)).toEqual(["wo-a"]);
    clearWorkspaceScopedClientCaches();
    expect(readManagerWorkOrderRows()).toEqual([]);
    const second = rowsFetch([{ id: "wo-b" }]);
    vi.stubGlobal("fetch", second);
    expect((await syncManagerWorkOrdersFromServer()).map((r) => r.id)).toEqual(["wo-b"]);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("promotions: the next sync refetches inside the TTL", async () => {
    vi.stubGlobal("fetch", rowsFetch([{ id: "promo-a" }]));
    await syncManagerPromotionsFromServer();
    clearWorkspaceScopedClientCaches();
    expect(readManagerPromotionRows()).toEqual([]);
    const second = rowsFetch([{ id: "promo-b" }]);
    vi.stubGlobal("fetch", second);
    expect((await syncManagerPromotionsFromServer()).map((r) => r.id)).toEqual(["promo-b"]);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("service requests: a sync after the switch reads the server, never reports the wiped cache as a good read", async () => {
    vi.stubGlobal("fetch", rowsFetch([{ id: "SR-a" }]));
    await syncServiceRequestsFromServer();
    clearWorkspaceScopedClientCaches();
    expect(readAllServiceRequests()).toEqual([]);
    expect(serviceRequestsLastReadSucceeded()).toBe(false);
    const second = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", second);
    await syncServiceRequestsFromServer();
    expect(second).toHaveBeenCalledTimes(1);
    expect(serviceRequestsLastReadSucceeded()).toBe(false);
  });

  // A read sent before the switch is answered with the OLD workspace's rows; landing after the clear, it must not
  // put them back in memory or sessionStorage, nor stamp the TTL that would keep them on screen.
  it.each([
    ["work orders", "axis:manager-work-orders:v1", () => syncManagerWorkOrdersFromServer(), () => readManagerWorkOrderRows()],
    ["promotions", "axis:manager-promotions:v1", () => syncManagerPromotionsFromServer(), () => readManagerPromotionRows()],
    ["vendors", "axis:manager-vendors:v1", () => syncManagerVendorsFromServer(), () => readManagerVendorRows()],
  ] as const)("%s: a read in flight across the switch does not repopulate the old workspace", async (_name, sessionKey, sync, read) => {
    let release: (res: Response) => void = () => undefined;
    const slow = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", slow);
    const pending = sync();
    await Promise.resolve();
    clearWorkspaceScopedClientCaches();
    release(new Response(JSON.stringify({ rows: [{ id: "old-a" }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await pending;
    expect(read()).toEqual([]);
    expect(window.sessionStorage.getItem(sessionKey)).toBeNull();
    const next = rowsFetch([{ id: "new-b" }]);
    vi.stubGlobal("fetch", next);
    expect((await sync()).map((r) => (r as { id: string }).id)).toEqual(["new-b"]);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
