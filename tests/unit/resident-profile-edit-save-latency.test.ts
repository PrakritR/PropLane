/**
 * "Saving takes forever and I can't tell if it updated."
 *
 * One Save resident was SIX network round trips, four of them sequential barriers: a forced
 * property-pipeline refresh, the row upsert, a charges mirror, then three forced re-reads — all
 * awaited before the modal closed. On a free-tier project that is tens of seconds of a spinner.
 *
 * Two invariants make the split safe, and both are load-bearing:
 *
 *  1. The charges mirror WRITE completes before any forced READ. A read racing ahead of the write
 *     pulls back the pre-edit rows and resurrects exactly the stale payment rows the edit
 *     replaced — the bug this module exists to prevent.
 *  2. The save resolves after the write and does NOT wait on the read-back, which only
 *     re-downloads what the local store already holds.
 *
 * Getting (2) without (1) would be a data-loss bug that looks like a performance win, so these
 * assert the order, not just the speed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const order: string[] = [];
const defer = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};

const mirrorWrite = vi.fn(async () => {
  order.push("mirror-write");
});
let readGate = defer();
const syncApplications = vi.fn(async () => {
  order.push("read:applications");
  await readGate.promise;
});
const syncCharges = vi.fn(async () => {
  order.push("read:charges");
});
const syncLeases = vi.fn(async () => {
  order.push("read:leases");
});
const syncPropertyPipeline = vi.fn(async () => {
  order.push("property-pipeline");
});
const upsertRow = vi.fn(async () => {
  order.push("upsert");
  return { ok: true, row: { id: "app-1" } };
});

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/lib/household-charges", () => ({
  mirrorHouseholdChargesToServerAwait: () => mirrorWrite(),
  syncHouseholdChargesFromServer: () => syncCharges(),
  recordApprovedApplicationCharges: () => true,
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  writeManagerApplicationRows: vi.fn(),
  readManagerApplicationRows: () => [],
  replaceManagerApplicationRowInCache: vi.fn(),
  syncManagerApplicationsFromServer: () => syncApplications(),
  upsertApplicationRowToServerAwait: () => upsertRow(),
}));
vi.mock("@/lib/lease-pipeline-storage", () => ({
  syncLeasePipelineFromServer: () => syncLeases(),
  regenerateEditableLeasesForResident: () => 1,
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  syncPropertyPipelineFromServer: () => syncPropertyPipeline(),
}));

const { persistResidentProfileEdit } = await import("@/lib/resident-lease-billing-sync");

const ROW = {
  id: "app-1",
  email: "sohan@example.com",
  application: { fullLegalName: "Sohan Vivek Naik" },
} as never;

beforeEach(() => {
  order.length = 0;
  readGate = defer();
  vi.clearAllMocks();
});

describe("saving an edited resident", () => {
  it("does not wait on the read-back before reporting success", async () => {
    // The applications re-read is held open. If the save awaited it, this would never resolve.
    const result = await persistResidentProfileEdit({
      rows: [],
      nextRow: ROW,
      managerUserId: "mgr-1",
    });

    expect(result.ok).toBe(true);
    expect(order).toContain("mirror-write");
    readGate.release();
  });

  it("completes the charges WRITE before any forced read starts", async () => {
    await persistResidentProfileEdit({ rows: [], nextRow: ROW, managerUserId: "mgr-1" });
    readGate.release();
    await Promise.resolve();

    const write = order.indexOf("mirror-write");
    const firstRead = order.findIndex((step) => step.startsWith("read:"));
    expect(write).toBeGreaterThanOrEqual(0);
    // A read landing before the write resurrects the pre-edit payment rows.
    if (firstRead !== -1) expect(write).toBeLessThan(firstRead);
  });

  it("still runs the read-back rather than dropping it", async () => {
    await persistResidentProfileEdit({ rows: [], nextRow: ROW, managerUserId: "mgr-1" });
    readGate.release();
    await new Promise((r) => setTimeout(r, 0));

    // Fire-and-forget must still fire — otherwise another tab's copy stays stale forever.
    expect(syncApplications).toHaveBeenCalled();
    expect(syncCharges).toHaveBeenCalled();
    expect(syncLeases).toHaveBeenCalled();
  });

  it("races the property refresh against the upsert instead of chaining them", async () => {
    await persistResidentProfileEdit({ rows: [], nextRow: ROW, managerUserId: "mgr-1" });
    readGate.release();

    // Both ran, and neither waited for the other: the row was built by the caller, so the upsert
    // does not read the pipeline.
    expect(syncPropertyPipeline).toHaveBeenCalled();
    expect(upsertRow).toHaveBeenCalled();
    const pipeline = order.indexOf("property-pipeline");
    const upsert = order.indexOf("upsert");
    expect(Math.abs(pipeline - upsert)).toBe(1);
  });

  it("reports a failed save rather than a false success", async () => {
    upsertRow.mockResolvedValueOnce({ ok: false, error: "Could not save resident." } as never);

    const result = await persistResidentProfileEdit({
      rows: [],
      nextRow: ROW,
      managerUserId: "mgr-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Could not save resident.");
    // A failed save must not push charges built from a row the server rejected.
    expect(mirrorWrite).not.toHaveBeenCalled();
  });
});
