import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth/manager-application-access", () => ({ managerCanAccessApplicationRecord: vi.fn(async () => true) }));
vi.mock("@/lib/workspaces/scope.server", () => ({ assertPropertyInActiveWorkspace: vi.fn(async () => true) }));
import { freezeSignedTermsForApplication } from "@/lib/rental-application/freeze-signed-terms.server";
let application: Record<string, unknown>;
let lease: Record<string, unknown>;
let written: Record<string, unknown> | null;
let conflict: boolean;
function db() {
  return { from(table: string) { let values: Record<string, unknown> | null = null;
    const query = { select: () => values ? Promise.resolve({ data: conflict ? [] : [{ id: "app" }], error: null }) : query,
      update: (row: Record<string, unknown>) => { values = row; written = row; return query; }, eq: () => query, is: () => query,
      maybeSingle: async () => ({ data: table === "manager_application_records" ? application : lease, error: null }) };
    return query;
  } };
}
beforeEach(() => {
  application = { id: "app", manager_user_id: "owner", property_id: "house", updated_at: "version", row_data: { id: "app", name: "New concurrent name", managerUserId: "owner", application: { propertyId: "house", roomChoice1: "house::room", managerRentOverride: "", managerUtilitiesOverride: "", managerSecurityDepositOverride: "500", managerMoveInFeeOverride: "" } } };
  lease = { id: "lease", manager_user_id: "owner", property_id: "house", row_data: { axisId: "app", residentEmail: "r@example.invalid", roomChoice: "house::room", status: "Fully Signed", managerSignature: { name: "M", signedAtIso: "now" }, residentSignature: { name: "R", signedAtIso: "now" }, generatedHtml: "<table><tr><th>Monthly rent</th><td>$1,000.00</td></tr><tr><th>Security deposit</th><td>$900.00</td></tr></table>" } };
  written = null; conflict = false;
});
describe("freezing signed lease terms on current application", () => {
  it("preserves concurrent name and explicit override while filling missing terms", async () => {
    const result = await freezeSignedTermsForApplication(db() as never, "manager", "app", "lease", { signedMonthlyRent: 1000, managerRentOverride: "1000", managerSecurityDepositOverride: "900", managerUtilitiesOverride: "0" });
    expect(result.ok).toBe(true);
    expect((written?.row_data as Record<string, unknown>).name).toBe("New concurrent name");
    expect((written?.row_data as { application: Record<string, unknown> }).application).toMatchObject({ managerRentOverride: "1000", managerSecurityDepositOverride: "500", managerUtilitiesOverride: "0" });
  });
  it("refuses changed property or room, document mismatch, and concurrent CAS", async () => {
    application.property_id = "other";
    expect((await freezeSignedTermsForApplication(db() as never, "manager", "app", "lease", { signedMonthlyRent: 1000 })).ok).toBe(false);
    expect(written).toBeNull();
    application.property_id = "house";
    expect((await freezeSignedTermsForApplication(db() as never, "manager", "app", "lease", { signedMonthlyRent: 1200 })).ok).toBe(false);
    expect(written).toBeNull();
    conflict = true;
    expect((await freezeSignedTermsForApplication(db() as never, "manager", "app", "lease", { signedMonthlyRent: 1000 })).ok).toBe(false);
  });
  it("refuses conflicting application and lease JSON identities before writing", async () => {
    const appRow = application.row_data as Record<string, unknown>;
    appRow.managerUserId = "other";
    expect((await freezeSignedTermsForApplication(db() as never, "manager", "app", "lease", { signedMonthlyRent: 1000 })).ok).toBe(false);
    expect(written).toBeNull();
    appRow.managerUserId = "owner";
    const leaseRow = lease.row_data as Record<string, unknown>;
    leaseRow.propertyId = "other";
    expect((await freezeSignedTermsForApplication(db() as never, "manager", "app", "lease", { signedMonthlyRent: 1000 })).ok).toBe(false);
    expect(written).toBeNull();
    leaseRow.propertyId = "house";
    appRow.id = undefined;
    expect((await freezeSignedTermsForApplication(db() as never, "manager", "app", "lease", { signedMonthlyRent: 1000 })).ok).toBe(false);
    expect(written).toBeNull();
  });
  it("fails closed on unreadable identity and returns the physical owner for legacy rows", async () => {
    const row = application.row_data as Record<string, unknown>;
    row._applicantIdentity = { version: 1, originOwnerId: "owner", ciphertext: "unreadable" };
    expect((await freezeSignedTermsForApplication(db() as never, "manager", "app", "lease", { signedMonthlyRent: 1000 })).ok).toBe(false);
    expect(written).toBeNull();
    delete row._applicantIdentity;
    delete row.managerUserId;
    const result = await freezeSignedTermsForApplication(db() as never, "manager", "app", "lease", { signedMonthlyRent: 1000 });
    expect(result.ok && result.row.managerUserId).toBe("owner");
    expect((written?.row_data as Record<string, unknown>).managerUserId).toBeUndefined();
  });
});
