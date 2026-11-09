import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
const mocks = vi.hoisted(() => ({ upsert: vi.fn(), cache: vi.fn(), generate: vi.fn(), mirror: vi.fn(), freeze: vi.fn(), snapshot: vi.fn() }));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/household-charges", () => ({ recordApprovedApplicationChargesScoped: mocks.generate, mirrorApplicationHouseholdChargesAwait: mocks.mirror, readAuthoritativeBillingSnapshot: mocks.snapshot, readChargesForManager: () => [] }));
vi.mock("@/lib/lease-pipeline-storage", () => ({ LEASE_PIPELINE_EVENT: "lease", readLeasePipeline: () => [] }));
vi.mock("@/lib/manager-applications-storage", () => ({ normalizeApplicationAxisId: (id: string) => id, readManagerApplicationRows: () => [app, other], upsertApplicationRowToServerAwait: mocks.upsert, replaceManagerApplicationRowInCache: mocks.cache }));
vi.mock("@/lib/lease-signed-terms", () => ({ freezeSignedLeaseTerms: mocks.freeze, persistFrozenSignedLeaseTerms: mocks.upsert }));
import { createChargesForExecutedLease } from "@/lib/lease-signing-charges.client";
const app = { id: "AXIS-1", email: "r@example.invalid", managerUserId: "owner", propertyId: "house", application: {} } as DemoApplicantRow;
const other = { ...app, id: "AXIS-OTHER" };
const lease = { id: "lease", axisId: "AXIS-1", managerUserId: "owner", propertyId: "house", residentEmail: app.email, status: "Fully Signed" } as LeasePipelineRow;
beforeEach(() => { vi.clearAllMocks(); mocks.snapshot.mockResolvedValue({ charges: [], rentProfiles: [] }); mocks.freeze.mockReturnValue({ row: { ...app, signedMonthlyRent: 1000 }, changed: true }); mocks.upsert.mockResolvedValue({ ok: true, rows: [{ ...app, signedMonthlyRent: 1000 }] }); mocks.generate.mockReturnValue({ ok: true, changed: true, stage: { charges: [], profiles: [], commit: vi.fn(() => true) } }); mocks.mirror.mockResolvedValue(true); });
describe("executed lease billing confirmation", () => {
  it("waits for the exact application before generation and confirms scoped charges", async () => {
    let release!: (value: unknown) => void;
    mocks.upsert.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const pending = createChargesForExecutedLease(lease, "co-manager");
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.mirror).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.upsert).toHaveBeenCalled());
    release({ ok: true, rows: [{ ...app, signedMonthlyRent: 1000 }] });
    expect((await pending).ok).toBe(true);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ id: app.id, signedMonthlyRent: 1000 }), app, false, { leaseExecuted: true }, { charges: [], rentProfiles: [] });
    expect(mocks.mirror).toHaveBeenCalledTimes(1);
  });
  it("does not generate on rejected terms and retries after confirmation failure", async () => {
    mocks.upsert.mockResolvedValueOnce({ ok: false });
    expect((await createChargesForExecutedLease(lease, "co-manager")).ok).toBe(false);
    expect(mocks.generate).not.toHaveBeenCalled();
    mocks.mirror.mockResolvedValueOnce(false);
    expect((await createChargesForExecutedLease(lease, "co-manager")).ok).toBe(false);
    expect((await createChargesForExecutedLease(lease, "co-manager")).ok).toBe(true);
  });
  it("does not generate or write charges when the authoritative read fails", async () => {
    mocks.snapshot.mockRejectedValueOnce(new Error("offline"));
    expect((await createChargesForExecutedLease(lease, "co-manager")).ok).toBe(false);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.mirror).not.toHaveBeenCalled();
  });
});
