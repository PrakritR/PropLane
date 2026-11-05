import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ role: vi.fn(), tier: vi.fn(), owner: vi.fn(), db: vi.fn() }));
vi.mock("@/lib/auth/resident-role-access", () => ({ authorizeResidentRole: mocks.role }));
vi.mock("@/lib/manager-access-server", () => ({ getManagerSubscriptionTierByManagerId: mocks.tier }));
vi.mock("@/lib/property-owner.server", () => ({ resolvePropertyOwnerUserId: mocks.owner }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: mocks.db }) }));
// Keep the real lifecycle signature predicates without pulling unrelated access loaders into this unit.
vi.mock("@/lib/resident-portal-access", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/resident-portal-access")>();
  return { leaseRowAttestsTenancy: original.leaseRowAttestsTenancy, leaseRowIsFullySigned: original.leaseRowIsFullySigned };
});
import { getResidentPortalManagerTier } from "@/lib/resident-portal-entitlement.server";

const subject = "resident-subject";
const owner = "22222222-2222-2222-2222-222222222222";
const app = () => ({ manager_user_id: owner, property_id: "house", assigned_property_id: null, row_data: { id: "AXIS-OWN", residentUserId: subject, bucket: "approved", propertyId: "house", email: "fixture@example.invalid" } });
const lease = () => ({ manager_user_id: owner, resident_user_id: subject, row_data: { propertyId: "house", managerSignature: { name: "Manager", signedAtIso: "2026-01-01" }, residentSignature: { name: "Resident", signedAtIso: "2026-01-02" }, application: { leaseEnd: "2099-12-31" } } });
let apps: unknown[];
let leases: unknown[];
let readError = false;
beforeEach(() => {
  vi.clearAllMocks(); apps = [app()]; leases = []; readError = false;
  mocks.role.mockResolvedValue(true); mocks.tier.mockResolvedValue("paid"); mocks.owner.mockResolvedValue(owner);
  mocks.db.mockImplementation((table: string) => {
    const result = { data: table === "manager_application_records" ? apps : leases, error: readError ? { message: "unavailable" } : null };
    const query = { select: vi.fn(), eq: vi.fn(), limit: vi.fn() };
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.limit.mockResolvedValue(result);
    return query;
  });
});

describe("resident portal tier from authenticated placement", () => {
  it("resolves a normal AXIS application through its current property's owning account", async () => {
    expect(await getResidentPortalManagerTier(subject)).toBe("paid");
    expect(mocks.tier).toHaveBeenCalledWith(owner);
    expect(mocks.owner).toHaveBeenCalledWith(expect.anything(), "house");
    expect(apps[0]).toHaveProperty("row_data.id", "AXIS-OWN");
  });
  it("deduplicates placements under one owner", async () => {
    apps.push(app()); leases.push(lease());
    expect(await getResidentPortalManagerTier(subject)).toBe("paid");
    expect(mocks.tier).toHaveBeenCalledTimes(1);
  });
  it.each([null, "free"])("preserves canonical denied/unknown tier %s", async (tier) => {
    mocks.tier.mockResolvedValue(tier);
    expect(await getResidentPortalManagerTier(subject)).toBe("free");
  });
  it("rejects a row for another subject even if email or profile hint matches", async () => {
    apps = [{ ...app(), row_data: { ...app().row_data, residentUserId: "other" } }];
    expect(await getResidentPortalManagerTier(subject)).toBe("free"); expect(mocks.tier).not.toHaveBeenCalled();
  });
  it.each([null, "transferred-owner"])("rejects orphan or transferred property owner %s", async (actual) => {
    mocks.owner.mockResolvedValue(actual);
    expect(await getResidentPortalManagerTier(subject)).toBe("free"); expect(mocks.tier).not.toHaveBeenCalled();
  });
  it("fails closed across distinct owners rather than inheriting any paid owner", async () => {
    apps.push({ ...app(), manager_user_id: "other-owner" });
    expect(await getResidentPortalManagerTier(subject)).toBe("free"); expect(mocks.tier).not.toHaveBeenCalled();
  });
  it("does not let a historical paid owner outrank current Free ownership", async () => {
    apps.push({ ...app(), manager_user_id: "historic-paid", row_data: { ...app().row_data, stage: "Former" } });
    mocks.tier.mockResolvedValue("paid");
    expect(await getResidentPortalManagerTier(subject)).toBe("free"); expect(mocks.tier).not.toHaveBeenCalled();
  });
  it.each(["rejected", "withdrawn", "former", "ended"])("excludes %s application evidence", async (kind) => {
    const row = app();
    if (kind === "rejected") row.row_data.bucket = "rejected";
    if (kind === "withdrawn") Object.assign(row.row_data, { withdrawnAt: "2026-01-01" });
    if (kind === "former") Object.assign(row.row_data, { stage: "Former" });
    if (kind === "ended") Object.assign(row.row_data, { application: { leaseEnd: "2000-01-01" } });
    apps = [row];
    expect(await getResidentPortalManagerTier(subject)).toBe("free"); expect(mocks.tier).not.toHaveBeenCalled();
  });
  it("allows a subject-bound signed or attested tenancy without an application", async () => {
    apps = []; leases = [lease()]; expect(await getResidentPortalManagerTier(subject)).toBe("paid");
    leases = [{ ...lease(), row_data: { propertyId: "house", managerAttestedTenancyAt: "2026-01-01" } }];
    expect(await getResidentPortalManagerTier(subject)).toBe("paid");
  });
  it.each(["voided", "ended", "wrong-subject"])("rejects %s lease evidence", async (kind) => {
    apps = []; const row = lease();
    if (kind === "voided") Object.assign(row.row_data, { status: "Voided" });
    if (kind === "ended") row.row_data.application.leaseEnd = "2000-01-01";
    if (kind === "wrong-subject") row.resident_user_id = "other";
    leases = [row]; expect(await getResidentPortalManagerTier(subject)).toBe("free"); expect(mocks.tier).not.toHaveBeenCalled();
  });
  it("fails closed without role, subject evidence, or readable complete rows", async () => {
    mocks.role.mockResolvedValue(false); expect(await getResidentPortalManagerTier(subject)).toBe("free");
    mocks.role.mockResolvedValue(true); apps = []; expect(await getResidentPortalManagerTier(subject)).toBe("free");
    apps = [app()]; readError = true; expect(await getResidentPortalManagerTier(subject)).toBe("free");
    readError = false; apps = Array.from({ length: 201 }, app); expect(await getResidentPortalManagerTier(subject)).toBe("free");
    expect(mocks.tier).not.toHaveBeenCalled();
  });
});

// Both portal doors must use the same subject resolver; neither may interpret
// profiles.manager_id as a purchase credential again.
describe("resident portal entitlement entry points", () => {
  it("passes the authenticated subject from layout and section renderer", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of ["src/app/resident/layout.tsx", "src/lib/render-portal-section.tsx"]) {
      const source = await readFile(file, "utf8");
      expect(source).toContain("getResidentPortalManagerTier(");
      expect(source).not.toContain("getManagerSubscriptionTierByManagerId(");
    }
  });
});
