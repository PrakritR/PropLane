// @vitest-environment jsdom
/**
 * The executed-lease charge watcher runs on EVERY lease-pipeline event, and each attempt costs a
 * full authoritative charges read plus a write. Two things keep that from becoming a per-page-load
 * egress bill on a manager with several leases signed inside the 30-day window:
 *
 *  1. One authoritative read per joint batch. The read was inside the per-member loop, so a
 *     three-person lease paid three full `/api/portal-household-charges` GETs; each member stages
 *     from its own disjoint slice (its application id, its own resident email) of the same one.
 *  2. A bounded attempt budget. A lease that keeps refusing is retried a few times, not on every
 *     subsequent event forever. The cap stops the RETRY only — nothing is recorded as billed that
 *     was not, and reopening the portal starts a fresh budget.
 *
 * Deliberately NOT restored: the old "this application already has some charge, skip it"
 * short-circuit. That read local, optimistic rows as proof the executed lease had been billed in
 * full, and a money write must never be skipped merely because some charges exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LEASE_PIPELINE_EVENT = "axis:lease-pipeline";

let leases: Array<Record<string, unknown>> = [];
let apps: Array<Record<string, unknown>> = [];
const snapshotRead = vi.fn(async () => ({ charges: [], rentProfiles: [] }));
const mirror = vi.fn(async () => true);
const generate = vi.fn((...args: unknown[]) => { void args; return { ok: true, changed: true, stage: { charges: [], profiles: [], scopeValid: () => true, commit: () => true } } as { ok: boolean; changed: boolean; stage?: unknown }; });

vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/household-charges", () => ({
  readAuthoritativeBillingSnapshot: () => snapshotRead(),
  recordApprovedApplicationChargesScoped: (...args: unknown[]) => generate(...args),
  mirrorApplicationHouseholdChargesAwait: (...args: unknown[]) => mirror(...(args as [])),
  readChargesForManager: () => [],
}));
vi.mock("@/lib/lease-pipeline-storage", () => ({
  LEASE_PIPELINE_EVENT,
  readLeasePipeline: () => leases,
}));
vi.mock("@/lib/lease-signed-terms", () => ({
  freezeSignedLeaseTerms: (row: unknown) => ({ row, changed: false }),
  persistFrozenSignedLeaseTerms: async (rows: unknown[]) => ({ ok: true, rows }),
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  readManagerApplicationRows: () => apps,
  normalizeApplicationAxisId: (id: string) => id.trim().toUpperCase(),
}));

const { watchExecutedLeaseCharges, resetExecutedLeaseChargeWatchState } = await import("@/lib/lease-signing-charges.client");

const app = (id: string, email: string) => ({ id, email, name: id, bucket: "approved", managerUserId: "owner", propertyId: "house" });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let stop: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  resetExecutedLeaseChargeWatchState();
  generate.mockReturnValue({ ok: true, changed: true, stage: { charges: [], profiles: [], scopeValid: () => true, commit: () => true } });
  apps = [app("AXIS-1", "a@x.com"), app("AXIS-2", "b@x.com")];
  leases = [{
    id: "l1", managerUserId: "owner", propertyId: "house", status: "Fully Signed",
    fullySignedAt: new Date().toISOString(), leaseKind: "joint_bundle",
    jointLeaseMembers: [{ applicationId: "AXIS-1", residentEmail: "a@x.com" }, { applicationId: "AXIS-2", residentEmail: "b@x.com" }],
  }];
});

afterEach(() => {
  stop?.();
  stop = undefined;
});

describe("executed-lease charge watcher", () => {
  it("reads the authoritative charges once for a whole joint batch", async () => {
    stop = watchExecutedLeaseCharges("owner");
    await settle();

    expect(generate).toHaveBeenCalledTimes(2);
    expect(snapshotRead).toHaveBeenCalledTimes(1);
  });

  it("does not read or write again for a lease it already billed", async () => {
    stop = watchExecutedLeaseCharges("owner");
    await settle();
    snapshotRead.mockClear();
    generate.mockClear();

    window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
    await settle();

    expect(snapshotRead).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("stops retrying a refusing lease after a bounded number of attempts", async () => {
    generate.mockReturnValue({ ok: false, changed: false });
    stop = watchExecutedLeaseCharges("owner");
    await settle();

    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
      await settle();
    }

    expect(snapshotRead.mock.calls.length).toBeGreaterThan(0);
    expect(snapshotRead.mock.calls.length).toBeLessThanOrEqual(4);
    expect(mirror).not.toHaveBeenCalled();
  });

  it("skips the write when the generator had nothing to post, and still commits locally", async () => {
    const commit = vi.fn(() => true);
    generate.mockReturnValue({ ok: true, changed: false, stage: { charges: [], profiles: [], scopeValid: () => true, commit } });
    stop = watchExecutedLeaseCharges("owner");
    await settle();

    expect(mirror).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(2);
  });
});
