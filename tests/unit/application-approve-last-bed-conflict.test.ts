// The last bed is arbitrated by the server when the approval is written. A refusal names the bed and who
// holds it, nothing is written locally for the refused approval, and a patch (the bed + its rent from the
// Approve popup) reaches the server write and the local copy only once the server accepts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";

let ROWS: DemoApplicantRow[] = [];
let viewer = "viewer-1";
let workspace = "workspace-1";
let ended = false;
let oversight = false;
vi.mock("@/lib/auth/portal-session-gate", () => ({ portalSessionViewerId: () => viewer, portalSessionEnded: () => ended }));
vi.mock("@/lib/workspaces/selection", () => ({ selectedWorkspaceId: () => workspace }));
vi.mock("@/lib/auth/admin-oversight.client", () => ({ adminOversightUrl: (url: string) => oversight ? `${url}?oversight=admin` : url }));
const writes: DemoApplicantRow[][] = [];
const syncProperty = vi.fn(async () => true);
const mirrorCharges = vi.fn(async () => true);
const recordCharges = vi.fn(() => true);
const readCharges = vi.fn<() => { applicationId: string }[]>(() => []);
const upsertNegotiated = vi.fn();

vi.mock("@/lib/manager-applications-storage", () => ({
  upsertApplicationRowToServerAwait: (...args: unknown[]) => upsertNegotiated(...args),
  normalizeApplicationAxisId: (id: string) => id,
  readManagerApplicationRows: () => ROWS,
  writeManagerApplicationRows: (rows: DemoApplicantRow[]) => {
    writes.push(rows);
    ROWS = rows;
  },
}));
vi.mock("@/lib/household-charges", () => ({
  recordApprovedApplicationCharges: () => recordCharges(),
  mirrorApplicationHouseholdChargesAwait: () => mirrorCharges(),
  readChargesForManager: () => readCharges(),
  recordSubmittedApplicationFeeCharge: () => true,
  removeAllApplicationCharges: () => undefined,
  removeApprovedApplicationCharges: () => undefined,
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ syncPropertyPipelineFromServer: () => syncProperty() }));
vi.mock("@/lib/rental-application/data", () => ({ getPropertyById: () => ({ listingSubmission: {} }) }));
vi.mock("@/lib/application-approval-placement", () => ({ approvalPlacementBlocker: () => null }));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));

import { transitionApplicationBucket } from "@/lib/application-review";

const row = (over: Partial<DemoApplicantRow> = {}): DemoApplicantRow =>
  ({
    id: "AP1",
    name: "Marcus Hale",
    email: "marcus@example.com",
    property: "Alder House",
    stage: "Submitted",
    bucket: "pending",
    detail: "",
    application: { roomChoice1: "p::r8", residentSlot: 2 },
    ...over,
  }) as unknown as DemoApplicantRow;

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const r = handler(String(url), init);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body, clone() { return this; } } as unknown as Response;
    }),
  );
}

beforeEach(() => {
  ROWS = [row()];
  viewer = "viewer-1";
  workspace = "workspace-1";
  ended = false;
  oversight = false;
  writes.length = 0;
  syncProperty.mockReset().mockResolvedValue(true);
  mirrorCharges.mockReset().mockResolvedValue(true);
  recordCharges.mockReset().mockReturnValue(true);
  readCharges.mockReset().mockReturnValue([]);
  upsertNegotiated.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("approving a bed that was just taken", () => {
  it.each(["false", "reject"])("refuses before the approval write when property sync returns %s", async (failure) => {
    if (failure === "false") syncProperty.mockResolvedValueOnce(false);
    else syncProperty.mockRejectedValueOnce(new Error("offline"));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await transitionApplicationBucket("AP1", "approved", { userId: "u1" });
    expect(result?.message).toMatch(/verify/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it.each(["row", "viewer", "workspace", "ended", "oversight"])("stops before approval POST when %s changes during property refresh", async (change) => {
    let release!: () => void;
    syncProperty.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const pending = transitionApplicationBucket("AP1", "approved", { userId: "u1" });
    await vi.waitFor(() => expect(release).toBeDefined());
    if (change === "row") ROWS = [row({ name: "Newer" })];
    if (change === "viewer") viewer = "viewer-2";
    if (change === "workspace") workspace = "workspace-2";
    if (change === "ended") ended = true;
    if (change === "oversight") oversight = true;
    release();
    expect(await pending).toMatchObject({ blocked: "error" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("does not publish negotiated rent when the application changes during its acknowledgement", async () => {
    mockFetch(() => ({ status: 200, body: { ok: true } }));
    let release!: (value: unknown) => void;
    upsertNegotiated.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = transitionApplicationBucket("AP1", "approved", { userId: "u1", negotiatedRent: 900 });
    await vi.waitFor(() => expect(release).toBeDefined());
    ROWS = [row({ name: "Newer" })];
    release({ ok: true, row: row() });
    expect(await pending).toMatchObject({ blocked: "error", approvalSaved: true });
    expect(ROWS[0]?.name).toBe("Newer");
    expect(writes).toEqual([]);
    expect(recordCharges).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer application when approval acknowledgement arrives late", async () => {
    let resolveResponse!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; })));
    const pending = transitionApplicationBucket("AP1", "approved", { userId: "u1" });
    await vi.waitFor(() => expect(resolveResponse).toBeDefined());
    ROWS = [row({ name: "Newer local edit" })];
    resolveResponse({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response);
    expect(await pending).toMatchObject({ blocked: "error", approvalSaved: true });
    expect(ROWS[0]?.name).toBe("Newer local edit");
    expect(writes).toEqual([]);
    expect(recordCharges).not.toHaveBeenCalled();
  });

  it("checks scoped billing even when reconciliation is unchanged", async () => {
    recordCharges.mockReturnValueOnce(false);
    mockFetch(() => ({ status: 200, body: { ok: true } }));
    const result = await transitionApplicationBucket("AP1", "approved", { userId: "u1", skipWelcomeEmail: true });
    expect(result?.approvalSaved).toBe(true);
    expect(mirrorCharges).toHaveBeenCalledOnce();
  });

  it("reports a saved approval when billing mirror fails and leaves retry possible", async () => {
    mirrorCharges.mockResolvedValueOnce(false);
    mockFetch(() => ({ status: 200, body: { ok: true } }));
    const result = await transitionApplicationBucket("AP1", "approved", { userId: "u1" });
    expect(result?.message).toMatch(/Approval saved, but payments/);
    expect(result?.approvalSaved).toBe(true);
    expect(ROWS[0]!.bucket).toBe("approved");
    const retry = await transitionApplicationBucket("AP1", "approved", { userId: "u1", skipWelcomeEmail: true });
    expect(retry?.blocked).toBeUndefined();
  });

  it("retries a failed mirror even when the second reconciliation is unchanged", async () => {
    recordCharges.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mirrorCharges.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    readCharges.mockReturnValue([{ applicationId: "AP1" }]);
    mockFetch(() => ({ status: 200, body: { ok: true } }));
    expect((await transitionApplicationBucket("AP1", "approved", { userId: "u1" }))?.blocked).toBe("error");
    expect((await transitionApplicationBucket("AP1", "approved", { userId: "u1", skipWelcomeEmail: true }))?.blocked).toBeUndefined();
    expect(mirrorCharges).toHaveBeenCalledTimes(2);
  });

  it("persists negotiated rent before charges and uses the server-confirmed row", async () => {
    mockFetch(() => ({ status: 200, body: { ok: true } }));
    upsertNegotiated.mockImplementation(async (next) => ({ ok: true, row: next }));
    const result = await transitionApplicationBucket("AP1", "approved", { userId: "u1", negotiatedRent: 900, skipWelcomeEmail: true });
    expect(result?.blocked).toBeUndefined();
    expect(upsertNegotiated).toHaveBeenCalledOnce();
    expect(upsertNegotiated.mock.invocationCallOrder[0]).toBeLessThan(recordCharges.mock.invocationCallOrder[0]!);
    expect(ROWS[0]!.application?.managerRentOverride).toBe("900");
  });

  it("stops downstream work after an unconfirmed negotiated rent write", async () => {
    mockFetch(() => ({ status: 200, body: { ok: true } }));
    upsertNegotiated.mockResolvedValue({ ok: false });
    const result = await transitionApplicationBucket("AP1", "approved", { userId: "u1", negotiatedRent: 900 });
    expect(result).toMatchObject({ approvalSaved: true, blocked: "error" });
    expect(recordCharges).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("answers blocked: capacity with the bed and the holder, and writes nothing locally", async () => {
    mockFetch(() => ({ status: 409, body: { ok: false, blocked: "capacity", error: "That rent is already held by Nora Vance", conflict: { slot: 2, holderName: "Nora Vance" } } }));
    const result = await transitionApplicationBucket("AP1", "approved", { userId: "u1" });
    expect(result).toMatchObject({ blocked: "capacity", conflict: { slot: 2, holderName: "Nora Vance" } });
    expect(writes).toEqual([]);
    expect(ROWS[0]!.bucket).toBe("pending");
  });

  it("a capacity refusal with no detail still blocks and writes nothing", async () => {
    mockFetch(() => ({ status: 409, body: { ok: false, blocked: "capacity", error: "Room is full" } }));
    const result = await transitionApplicationBucket("AP1", "approved", { userId: "u1" });
    expect(result?.blocked).toBe("capacity");
    expect(result?.conflict).toEqual({});
    expect(writes).toEqual([]);
  });

  it("the bed patch reaches the server write, and the local copy only after the server accepts", async () => {
    let sent: DemoApplicantRow | null = null;
    mockFetch((url, init) => {
      if (url.includes("/api/manager-applications")) {
        sent = JSON.parse(String(init?.body)).row;
        return { status: 200, body: { ok: true } };
      }
      return { status: 200, body: {} };
    });
    const result = await transitionApplicationBucket("AP1", "approved", {
      userId: "u1",
      applicationPatch: { residentSlot: 1, managerRentOverride: "650" },
      skipWelcomeEmail: true,
    });
    expect(result?.blocked).toBeUndefined();
    expect(sent!.application).toMatchObject({ residentSlot: 1, managerRentOverride: "650", roomChoice1: "p::r8" });
    expect(ROWS[0]!.application).toMatchObject({ residentSlot: 1, managerRentOverride: "650" });
    expect(ROWS[0]!.bucket).toBe("approved");
  });
});
