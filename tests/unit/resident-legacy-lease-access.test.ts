import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ apps: [] as Record<string, unknown>[], leases: [] as Record<string, unknown>[], fail: "", verified: true, authEmail: "resident@example.invalid" }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({
  auth: { admin: { getUserById: async () => ({ data: { user: { email: state.authEmail, email_confirmed_at: state.verified ? "yes" : null } }, error: state.fail === "auth" ? {} : null }) } },
  from: (table: string) => {
    let nullSubject = false;
    const q = { select: () => q, eq: () => q, is: () => { nullSubject = true; return q; }, ilike: () => q,
      order: async () => ({ data: table === "portal_lease_pipeline_records" ? [] : state.apps, error: state.fail === "direct" ? {} : null }),
      limit: async () => ({ data: table === "manager_application_records" ? state.apps : nullSubject ? state.leases : [], error: state.fail === table ? {} : null }) };
    return q;
  },
}) }));
import { loadResidentLeaseSignedStatus, loadResidentManagerAttestedTenancy } from "@/lib/resident-portal-access";
const app = { id: "AXIS-1", manager_user_id: "owner", property_id: "house", resident_email: "resident@example.invalid", row_data: { residentUserId: "user", bucket: "approved" } };
const lease = { id: "lease", manager_user_id: "owner", property_id: "house", resident_email: "resident@example.invalid", resident_user_id: null, row_data: { axisId: "AXIS-1", managerSignature: { name: "M", signedAtIso: "now" }, residentSignature: { name: "R", signedAtIso: "now" } } };
beforeEach(() => { state.apps = [app]; state.leases = [lease]; state.fail = ""; state.verified = true; state.authEmail = "resident@example.invalid"; });
describe("legacy lease standalone readers", () => {
  it("recognizes a signed null-subject lease for the exact bound resident", async () => { expect(await loadResidentLeaseSignedStatus("resident@example.invalid", "owner", "user")).toBe(true); });
  it("recognizes an attested tenancy using the same proof", async () => { state.leases = [{ ...lease, row_data: { axisId: "AXIS-1", managerAttestedTenancyAt: "now" } }]; expect(await loadResidentManagerAttestedTenancy("resident@example.invalid", "owner", "user")).toBe(true); });
  it.each(["manager_application_records", "portal_lease_pipeline_records", "direct"])("fails closed when %s read fails", async (failed) => { state.fail = failed; expect(await loadResidentLeaseSignedStatus("resident@example.invalid", "owner", "user")).toBe(false); });
  it("fails closed at the candidate limit", async () => { state.leases = Array.from({ length: 100 }, () => lease); expect(await loadResidentLeaseSignedStatus("resident@example.invalid", "owner", "user")).toBe(false); });
  it("rejects a mismatched mailbox or failed Auth read", async () => {
    state.authEmail = "other@example.invalid";
    expect(await loadResidentLeaseSignedStatus("resident@example.invalid", "owner", "user")).toBe(false);
    state.authEmail = "resident@example.invalid"; state.fail = "auth";
    expect(await loadResidentLeaseSignedStatus("resident@example.invalid", "owner", "user")).toBe(false);
  });
  it("rejects an unconfirmed mailbox", async () => { state.verified = false; expect(await loadResidentLeaseSignedStatus("resident@example.invalid", "owner", "user")).toBe(false); });
});
