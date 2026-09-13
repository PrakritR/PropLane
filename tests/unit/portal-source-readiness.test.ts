// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/demo/demo-session", async (original) => ({ ...(await original<typeof import("@/lib/demo/demo-session")>()), isDemoModeActive: () => false }));
beforeEach(() => { vi.resetModules(); window.sessionStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const empty = () => new Response(JSON.stringify({ rows: [] }), { status: 200 });

describe("resident source readiness belongs to the requesting identity", () => {
  it("does not reuse application success from the previous manager", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(empty()).mockReturnValueOnce(pending.promise));
    const store = await import("@/lib/manager-applications-storage");
    await store.syncManagerApplicationsFromServer({ managerUserId: "a" });
    expect(store.managerApplicationsReadSucceeded()).toBe(true);
    const next = store.syncManagerApplicationsFromServer({ managerUserId: "b" });
    expect(store.managerApplicationsReadSucceeded()).toBe(false);
    pending.resolve(new Response("unavailable", { status: 503 }));
    await next;
    expect(store.managerApplicationsReadSucceeded()).toBe(false);
  });

  it("an old applications request rejecting after a new successful read cannot reset its readiness", async () => {
    const old = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(empty()));
    const store = await import("@/lib/manager-applications-storage");
    const first = store.syncManagerApplicationsFromServer({ managerUserId: "a" });
    await store.syncManagerApplicationsFromServer({ managerUserId: "b" });
    old.reject(new Error("network"));
    await first;
    expect(store.managerApplicationsReadSucceeded()).toBe(true);
  });

  it("a lease response body finishing after the identity changes cannot restore the previous actor's rows", async () => {
    const oldBody = deferred<{ rows: unknown[] }>();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: () => oldBody.promise }).mockResolvedValueOnce(empty()));
    const store = await import("@/lib/lease-pipeline-storage");
    const first = store.syncLeasePipelineFromServer("a");
    await Promise.resolve();
    await store.syncLeasePipelineFromServer("b");
    oldBody.resolve({ rows: [{ id: "private-a", managerUserId: "a", residentEmail: "a@example.com" }] });
    expect(await first).toEqual([]);
    expect(store.readLeasePipeline("b")).toEqual([]);
    expect(store.leasePipelineReadSucceeded()).toBe(true);
  });

  it("a failed refresh retries immediately instead of accepting a fresh-but-failed TTL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(empty()).mockResolvedValueOnce(new Response("unavailable", { status: 503 })).mockResolvedValueOnce(empty()));
    const store = await import("@/lib/lease-pipeline-storage");
    await store.syncLeasePipelineFromServer("a");
    await store.syncLeasePipelineFromServer("a", { force: true });
    expect(store.leasePipelineReadSucceeded()).toBe(false);
    await store.syncLeasePipelineFromServer("a");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(store.leasePipelineReadSucceeded()).toBe(true);
  });
});


describe("concurrent portal consumers", () => {
  it("keeps application reads alive when session hydration confirms their scoped actor", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending.promise));
    const store = await import("@/lib/manager-applications-storage");
    const gate = await import("@/lib/auth/portal-session-gate");
    const read = store.syncManagerApplicationsFromServer({ managerUserId: "a" });
    gate.setPortalSessionViewer("a");
    const joined = store.syncManagerApplicationsFromServer();
    pending.resolve(empty());
    await Promise.all([read, joined]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.managerApplicationsReadSucceeded("a")).toBe(true);
    expect(store.managerApplicationsReadSucceeded("b")).toBe(false);
  });

  it("does not clear lease readiness when an unscoped consumer reads during the slower applications load", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("manager-applications") ? pending.promise : Promise.resolve(empty())));
    const gate = await import("@/lib/auth/portal-session-gate");
    gate.setPortalSessionViewer("a");
    const leases = await import("@/lib/lease-pipeline-storage");
    const applications = await import("@/lib/manager-applications-storage");
    const slow = applications.syncManagerApplicationsFromServer({ managerUserId: "a" });
    await leases.syncLeasePipelineFromServer("a");
    leases.readLeasePipeline();
    await leases.syncLeasePipelineFromServer();
    pending.resolve(empty());
    await slow;
    expect(leases.leasePipelineReadSucceeded("a")).toBe(true);
    expect(applications.managerApplicationsReadSucceeded("a")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    gate.setPortalSessionViewer("b");
    expect(leases.leasePipelineReadSucceeded("b")).toBe(false);
    expect(applications.managerApplicationsReadSucceeded("b")).toBe(false);
  });

  it("shares handled failure results with every joined lease consumer", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending.promise));
    const store = await import("@/lib/lease-pipeline-storage");
    const first = store.syncLeasePipelineFromServer("a");
    const joined = store.syncLeasePipelineFromServer("a");
    pending.reject(new Error("offline"));
    await expect(Promise.all([first, joined])).resolves.toEqual([[], []]);
    expect(store.leasePipelineReadSucceeded("a")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["malformed", "network"])("returns the last lease snapshot on a %s failure and allows immediate retry", async (failure) => {
    const row = { id: "lease-a", managerUserId: "a", residentName: "Resident A", residentEmail: "a@example.com", status: "Manager Review" };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ rows: [row] })));
    if (failure === "network") fetchMock.mockRejectedValueOnce(new Error("offline"));
    else fetchMock.mockResolvedValueOnce(new Response("{}"));
    fetchMock.mockResolvedValueOnce(empty());
    vi.stubGlobal("fetch", fetchMock);
    const store = await import("@/lib/lease-pipeline-storage");
    await store.syncLeasePipelineFromServer("a");
    const stale = await store.syncLeasePipelineFromServer("a", { force: true });
    expect(stale.map((item) => item.id)).toEqual(["lease-a"]);
    expect(store.leasePipelineReadSucceeded("a")).toBe(false);
    await store.syncLeasePipelineFromServer("a");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(store.leasePipelineReadSucceeded("a")).toBe(true);
  });

  const propertyResponse = () => new Response(JSON.stringify({ snapshot: { pendingByUser: {}, extrasByUser: {}, sideGlobal: { requestChange: [], unlisted: [], rejected: [], drafts: [] }, sideByUser: {} } }));

  it("accepts a property request started before hydration when the confirmed actor matches", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending.promise));
    const store = await import("@/lib/demo-property-pipeline");
    const gate = await import("@/lib/auth/portal-session-gate");
    const read = store.syncPropertyPipelineFromServer({ userId: "a" });
    gate.setPortalSessionViewer("a");
    const joined = store.syncPropertyPipelineFromServer({ userId: "a" });
    pending.resolve(propertyResponse());
    expect(await read).toBe(true);
    expect(await joined).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale property response after switching away and back to the original actor", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(propertyResponse()));
    const gate = await import("@/lib/auth/portal-session-gate");
    gate.setPortalSessionViewer("a");
    const store = await import("@/lib/demo-property-pipeline");
    const old = store.syncPropertyPipelineFromServer({ userId: "a" });
    gate.setPortalSessionViewer("b");
    gate.setPortalSessionViewer("a");
    expect(await store.syncPropertyPipelineFromServer({ userId: "a" })).toBe(true);
    pending.resolve(propertyResponse());
    expect(await old).toBe(false);
    expect(store.hasCachedPropertyPipeline()).toBe(true);
  });
});
