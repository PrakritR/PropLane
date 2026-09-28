// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { ServiceRequest } from "@/lib/service-requests-storage";

vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
const viewer = "multi-role-viewer";
const app = { id: "PROPLANE-OWNAPPLICATI", name: "Resident", email: "resident@example.test", property: "Other landlord home", propertyId: "other-house", stage: "Approved", bucket: "approved", detail: "", managerUserId: "other-landlord" } as DemoApplicantRow;
const service = { id: "own-service", residentEmail: app.email, status: "approved" } as ServiceRequest;
function response(rows: unknown[], ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => ({ rows }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function portal(role: "manager" | "resident") {
  document.cookie = `axis_active_portal=${role}; path=/`;
}
async function setup() {
  const identity = await import("@/lib/auth/portal-session-gate");
  identity.setPortalSessionViewer(viewer);
  return {
    identity,
    applications: await import("@/lib/manager-applications-storage"),
    services: await import("@/lib/service-requests-storage"),
    dashboard: await import("@/lib/resident-dashboard-sync-client"),
  };
}
beforeEach(() => { vi.resetModules(); localStorage.clear(); sessionStorage.clear(); portal("manager"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("resident dashboard fresh mount reads with real shared stores", () => {
  it("replaces manager TTL hits with the resident application and service slices", async () => {
    const { applications, services, dashboard } = await setup();
    const fetcher = vi.fn().mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([app])).mockResolvedValueOnce(response([service]));
    vi.stubGlobal("fetch", fetcher);
    await applications.syncManagerApplicationsFromServer();
    await services.syncServiceRequestsFromServer();
    portal("resident");
    await dashboard.refreshResidentDashboardApplications(viewer);
    await dashboard.refreshResidentDashboardServices(viewer);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/manager-applications", "/api/portal-service-requests",
      "/api/manager-applications?scope=self", "/api/portal-service-requests",
    ]);
    expect(applications.readManagerApplicationRows()).toMatchObject([app]);
    expect(services.readServiceRequestsForResident(app.email)).toMatchObject([service]);
  });

  it("discards manager flights that settle after resident reads and preserves the newest flight slot", async () => {
    const { applications, services, dashboard } = await setup();
    const oldApp = deferred<ReturnType<typeof response>>();
    const oldService = deferred<ReturnType<typeof response>>();
    const residentApp = deferred<ReturnType<typeof response>>();
    const residentService = deferred<ReturnType<typeof response>>();
    const fetcher = vi.fn().mockReturnValueOnce(oldApp.promise).mockReturnValueOnce(oldService.promise)
      .mockReturnValueOnce(residentApp.promise).mockReturnValueOnce(residentService.promise);
    vi.stubGlobal("fetch", fetcher);
    const managerAppRead = applications.syncManagerApplicationsFromServer();
    const managerServiceRead = services.syncServiceRequestsFromServer();
    portal("resident");
    const residentAppRead = dashboard.refreshResidentDashboardApplications(viewer);
    const residentServiceRead = dashboard.refreshResidentDashboardServices(viewer);
    const duplicateApp = dashboard.refreshResidentDashboardApplications(viewer);
    const duplicateService = dashboard.refreshResidentDashboardServices(viewer);
    expect(fetcher).toHaveBeenCalledTimes(4);
    residentApp.resolve(response([app])); residentService.resolve(response([service]));
    await Promise.all([residentAppRead, residentServiceRead, duplicateApp, duplicateService]);
    oldApp.resolve(response([])); oldService.resolve(response([]));
    await Promise.all([managerAppRead, managerServiceRead]);
    expect(applications.readManagerApplicationRows()).toMatchObject([app]);
    expect(services.readServiceRequestsForResident(app.email)).toMatchObject([service]);
    // TTL and events from the completed resident reads cause no extra fetch.
    await applications.syncManagerApplicationsFromServer({ selfScope: true });
    await services.syncServiceRequestsFromServer();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("old service settlement does not clear the resident flight or force duplicate unforced reads", async () => {
    const { services, dashboard } = await setup();
    const old = deferred<ReturnType<typeof response>>();
    const fresh = deferred<ReturnType<typeof response>>();
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    vi.stubGlobal("fetch", fetcher);
    const manager = services.syncServiceRequestsFromServer();
    portal("resident");
    const resident = dashboard.refreshResidentDashboardServices(viewer);
    old.resolve(response([])); await manager;
    const joined = services.syncServiceRequestsFromServer();
    expect(fetcher).toHaveBeenCalledTimes(2);
    fresh.resolve(response([service]));
    expect(await joined).toMatchObject([service]); await resident;
  });

  it("returning to manager and changing viewer require the appropriate new read", async () => {
    const { identity, applications, services, dashboard } = await setup();
    const fetcher = vi.fn().mockResolvedValue(response([])); vi.stubGlobal("fetch", fetcher);
    portal("resident");
    await dashboard.refreshResidentDashboardApplications(viewer); await dashboard.refreshResidentDashboardServices(viewer);
    portal("manager");
    await applications.syncManagerApplicationsFromServer(); await services.syncServiceRequestsFromServer();
    expect(fetcher.mock.calls[2][0]).toBe("/api/manager-applications");
    identity.setPortalSessionViewer("new-viewer"); portal("resident");
    await dashboard.refreshResidentDashboardApplications("new-viewer"); await dashboard.refreshResidentDashboardServices("new-viewer");
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("viewer changes discard late application and service publication before the next mount", async () => {
    const { identity, applications, services, dashboard } = await setup();
    portal("resident");
    const oldApp = deferred<ReturnType<typeof response>>();
    const oldService = deferred<ReturnType<typeof response>>();
    const fetcher = vi.fn().mockReturnValueOnce(oldApp.promise).mockReturnValueOnce(oldService.promise)
      .mockResolvedValue(response([]));
    vi.stubGlobal("fetch", fetcher);
    const appRead = dashboard.refreshResidentDashboardApplications(viewer);
    const serviceRead = dashboard.refreshResidentDashboardServices(viewer);
    identity.setPortalSessionViewer("new-viewer");
    oldApp.resolve(response([app])); oldService.resolve(response([service]));
    await Promise.all([appRead, serviceRead]);
    expect(applications.readManagerApplicationRows()).toEqual([]);
    expect(services.readAllServiceRequests()).toEqual([]);
    await dashboard.refreshResidentDashboardApplications("new-viewer");
    await dashboard.refreshResidentDashboardServices("new-viewer");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("failed resident reads are retryable and a later mount is fresh", async () => {
    const { dashboard } = await setup(); portal("resident");
    const fetcher = vi.fn().mockResolvedValueOnce(response([], false)).mockResolvedValueOnce(response([], false))
      .mockResolvedValueOnce(response([app])).mockResolvedValueOnce(response([service]))
      .mockResolvedValue(response([]));
    vi.stubGlobal("fetch", fetcher);
    await dashboard.refreshResidentDashboardApplications(viewer); await dashboard.refreshResidentDashboardServices(viewer);
    expect(await dashboard.refreshResidentDashboardApplications(viewer)).toMatchObject([app]);
    expect(await dashboard.refreshResidentDashboardServices(viewer)).toMatchObject([service]);
    await dashboard.refreshResidentDashboardApplications(viewer); await dashboard.refreshResidentDashboardServices(viewer);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
});
