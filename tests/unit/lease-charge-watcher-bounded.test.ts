// @vitest-environment jsdom
/**
 * The executed-lease charge watcher runs on EVERY lease-pipeline event, so three things have to
 * hold at once, and the first two pull against each other:
 *
 *  1. Only an ACKNOWLEDGED write is remembered as done. A batch that merely ran out of tries is
 *     not a completed write, and recording it as one would leave a signed lease unbilled with
 *     nothing saying so.
 *  2. Repeated events are still bounded. Each attempt costs an authoritative charges GET and a
 *     write, so an unbounded retry is a per-page-load egress bill (AGENTS.md § Performance &
 *     egress). Exhaustion is therefore kept SEPARATE from success.
 *  3. Both are keyed on the BASIS — the scope this browser acts in, the lease's generation, and
 *     every billed application's billing revision — so a workspace or viewer switch inherits
 *     neither success nor exhaustion, and an edit earns a fresh budget rather than being refused
 *     by a stale one.
 *
 * And within one joint batch: every member's authoritative read is taken AFTER the previous
 * member's write was acknowledged, because joint members are not provably disjoint (the resolver
 * dedupes application ids, not emails, and a scoped recurring profile is selected by owner +
 * email + property).
 *
 * Deliberately NOT here: an "already has some charge, skip it" short-circuit. That read local,
 * optimistic rows as proof the executed lease had been billed in full.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LEASE_PIPELINE_EVENT = "axis:lease-pipeline";

let leases: Array<Record<string, unknown>> = [];
let apps: Array<Record<string, unknown>> = [];
let scope = { workspace: "ws-1", viewer: "mgr-1", oversight: "/api/portal-household-charges" };
const snapshotRead = vi.fn(async () => ({ charges: [] as unknown[], rentProfiles: [] as unknown[] }));
const mirror = vi.fn(async () => true);
const generate = vi.fn((...args: unknown[]) => {
  void args;
  return { ok: true, changed: true, stage: { charges: [], profiles: [], scopeValid: () => true, commit: () => true } } as
    { ok: boolean; changed: boolean; stage?: { charges: unknown[]; profiles: unknown[]; scopeValid: () => boolean; commit: () => boolean } };
});

vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/workspaces/selection", () => ({ selectedWorkspaceId: () => scope.workspace }));
vi.mock("@/lib/auth/portal-session-gate", () => ({ portalSessionViewerId: () => scope.viewer }));
vi.mock("@/lib/auth/admin-oversight.client", () => ({ adminOversightUrl: () => scope.oversight }));
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

const {
  watchExecutedLeaseCharges,
  resetExecutedLeaseChargeWatchState,
  clearExecutedLeaseChargeBackoff,
  createChargesForExecutedLease,
} = await import("@/lib/lease-signing-charges.client");

const app = (id: string, email: string, over: Record<string, unknown> = {}) =>
  ({ id, email, name: id, bucket: "approved", managerUserId: "owner", propertyId: "house", ...over });

const jointLease = (over: Record<string, unknown> = {}) => ({
  id: "l1", managerUserId: "owner", propertyId: "house", status: "Fully Signed",
  fullySignedAt: new Date().toISOString(), updatedAtIso: "2026-11-01T00:00:00.000Z", versionNumber: 1,
  leaseKind: "joint_bundle",
  jointLeaseMembers: [{ applicationId: "AXIS-1", residentEmail: "a@x.com" }, { applicationId: "AXIS-2", residentEmail: "b@x.com" }],
  ...over,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const stagingCommit = () => ({ ok: true, changed: true, stage: { charges: [], profiles: [], scopeValid: () => true, commit: () => true } });

let stop: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  resetExecutedLeaseChargeWatchState();
  scope = { workspace: "ws-1", viewer: "mgr-1", oversight: "/api/portal-household-charges" };
  generate.mockImplementation(() => stagingCommit());
  snapshotRead.mockImplementation(async () => ({ charges: [], rentProfiles: [] }));
  mirror.mockImplementation(async () => true);
  apps = [app("AXIS-1", "a@x.com"), app("AXIS-2", "b@x.com")];
  leases = [jointLease()];
});

afterEach(() => {
  stop?.();
  stop = undefined;
});

describe("one authoritative read per member", () => {
  it("re-reads for each joint member, after the previous member was acknowledged", async () => {
    const order: string[] = [];
    snapshotRead.mockImplementation(async () => { order.push("read"); return { charges: [], rentProfiles: [] }; });
    mirror.mockImplementation(async () => { order.push("ack"); return true; });

    stop = watchExecutedLeaseCharges("owner");
    await settle();

    expect(generate).toHaveBeenCalledTimes(2);
    // A reused pre-loop snapshot would restore state from before the first member's rows landed.
    expect(order).toEqual(["read", "ack", "read", "ack"]);
  });

  it("acknowledges the write even when the generator reports nothing changed", async () => {
    // `changed` is a legacy boolean, not a diff of the staged payload: the generator can stage an
    // application fee and still return false from a later branch.
    const commit = vi.fn(() => true);
    generate.mockImplementation(() => ({ ok: true, changed: false, stage: { charges: [], profiles: [], scopeValid: () => true, commit } }));

    stop = watchExecutedLeaseCharges("owner");
    await settle();

    expect(mirror).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("never publishes staged rows locally when the acknowledged write fails", async () => {
    const commit = vi.fn(() => true);
    generate.mockImplementation(() => ({ ok: true, changed: false, stage: { charges: [], profiles: [], scopeValid: () => true, commit } }));
    mirror.mockImplementation(async () => false);

    const result = await createChargesForExecutedLease(jointLease() as never, "owner");

    expect(result.ok).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it("refuses a later member after the workspace changed mid-batch", async () => {
    mirror.mockImplementationOnce(async () => { scope = { ...scope, workspace: "ws-2" }; return true; });

    const result = await createChargesForExecutedLease(jointLease() as never, "owner");

    expect(result.ok).toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("refuses to stage a same-email overlap from a stale basis", async () => {
    // Two distinct application ids sharing one email: the resolver dedupes ids, not emails, so
    // these two members select the same recurring-profile slice.
    apps = [app("AXIS-1", "shared@x.com"), app("AXIS-2", "shared@x.com")];
    leases = [jointLease({ jointLeaseMembers: [
      { applicationId: "AXIS-1", residentEmail: "shared@x.com" },
      { applicationId: "AXIS-2", residentEmail: "shared@x.com" },
    ] })];
    const seen: unknown[] = [];
    let acknowledged = 0;
    snapshotRead.mockImplementation(async () => ({ charges: [{ id: `after-${acknowledged}` }], rentProfiles: [] }));
    mirror.mockImplementation(async () => { acknowledged += 1; return true; });
    generate.mockImplementation((...args: unknown[]) => { seen.push(args[4]); return stagingCommit(); });

    const result = await createChargesForExecutedLease(leases[0] as never, "owner");

    expect(result.ok).toBe(true);
    // The second member was staged from a snapshot taken after the first member's acknowledgement.
    expect(seen).toEqual([{ charges: [{ id: "after-0" }], rentProfiles: [] }, { charges: [{ id: "after-1" }], rentProfiles: [] }]);
  });
});

describe("acknowledged success, bounded retries", () => {
  it("dedupes an acknowledged batch on an unchanged basis", async () => {
    stop = watchExecutedLeaseCharges("owner");
    await settle();
    snapshotRead.mockClear();
    generate.mockClear();

    window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
    await settle();

    expect(snapshotRead).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("never remembers a failure as done, and stops after four tries", async () => {
    generate.mockImplementation(() => ({ ok: false, changed: false }));
    stop = watchExecutedLeaseCharges("owner");
    await settle();
    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
      await settle();
    }
    expect(snapshotRead).toHaveBeenCalledTimes(4);
    expect(mirror).not.toHaveBeenCalled();

    // Exhaustion is not success: once the batch CAN succeed, an explicit retry still bills it.
    generate.mockImplementation(() => stagingCommit());
    clearExecutedLeaseChargeBackoff();
    window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
    await settle();
    expect(mirror).toHaveBeenCalled();
  });

  it("earns a fresh budget when the lease generation or an application revision changes", async () => {
    generate.mockImplementation(() => ({ ok: false, changed: false }));
    stop = watchExecutedLeaseCharges("owner");
    await settle();
    for (let i = 0; i < 6; i++) {
      window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
      await settle();
    }
    expect(snapshotRead).toHaveBeenCalledTimes(4);

    // A new lease version is a new basis, not a retry of the exhausted one.
    leases = [jointLease({ versionNumber: 2 })];
    window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
    await settle();
    expect(snapshotRead).toHaveBeenCalledTimes(5);

    // So is an edit to what an application bills.
    apps = [app("AXIS-1", "a@x.com", { signedMonthlyRent: 2400 }), app("AXIS-2", "b@x.com")];
    window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
    await settle();
    expect(snapshotRead).toHaveBeenCalledTimes(6);
  });

  it("retries after deposit, move-in fee and manual resident billing inputs change", async () => {
    generate.mockImplementation(() => ({ ok: false, changed: false }));
    stop = watchExecutedLeaseCharges("owner");
    await settle();
    for (let i = 0; i < 6; i++) { window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT)); await settle(); }
    expect(snapshotRead).toHaveBeenCalledTimes(4);
    for (const revision of [
      { application: { managerSecurityDepositOverride: "400" } },
      { application: { managerMoveInFeeOverride: "200" } },
      { manualResidentDetails: { moveInDate: "2026-12-01" } },
      { application: { applicationFee: "75" } },
    ]) {
      const previous = snapshotRead.mock.calls.length;
      apps = [app("AXIS-1", "a@x.com", revision), app("AXIS-2", "b@x.com")];
      window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
      await settle();
      expect(snapshotRead).toHaveBeenCalledTimes(previous + 1);
    }
  });

  it("inherits neither success nor exhaustion across a workspace or viewer switch", async () => {
    stop = watchExecutedLeaseCharges("owner");
    await settle();
    expect(mirror).toHaveBeenCalledTimes(2);

    // Same lease, another workspace: the earlier acknowledgement says nothing about this one.
    scope = { ...scope, workspace: "ws-2" };
    window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
    await settle();
    expect(mirror).toHaveBeenCalledTimes(4);

    // And exhaustion in one viewer's scope never refuses another's.
    generate.mockImplementation(() => ({ ok: false, changed: false }));
    for (let i = 0; i < 6; i++) {
      window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
      await settle();
    }
    const spentInWs2 = snapshotRead.mock.calls.length;
    scope = { ...scope, viewer: "mgr-2" };
    window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
    await settle();
    expect(snapshotRead.mock.calls.length).toBe(spentInWs2 + 1);
  });

  it("keeps the sent-lease budget separate from the executed one", async () => {
    leases = [{
      id: "l1", managerUserId: "owner", propertyId: "house", status: "Resident Signature Pending",
      updatedAtIso: "2026-11-01T00:00:00.000Z", versionNumber: 1,
      axisId: "AXIS-1", residentEmail: "a@x.com",
    }];
    apps = [app("AXIS-1", "a@x.com")];

    stop = watchExecutedLeaseCharges("owner");
    await settle();
    expect(mirror).toHaveBeenCalledTimes(1);

    // The same lease, now fully signed: a different stage, a different basis, its own budget.
    leases = [{ ...leases[0], status: "Fully Signed", fullySignedAt: new Date().toISOString() }];
    window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
    await settle();
    expect(mirror).toHaveBeenCalledTimes(2);
  });
});
