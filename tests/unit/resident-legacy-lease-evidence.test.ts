import { describe, expect, it } from "vitest";
import { provenLegacyResidentLeases } from "@/lib/auth/resident-legacy-lease-evidence";
const app = { id: "AXIS-1", manager_user_id: "owner", property_id: "house", resident_email: "r@example.invalid", row_data: { residentUserId: "user", bucket: "approved" } };
const lease = { id: "lease", manager_user_id: "owner", property_id: "house", resident_email: "r@example.invalid", resident_user_id: null, row_data: { axisId: "AXIS-1" } };
const resolve = (a = [app], l = [lease], email = "r@example.invalid") => provenLegacyResidentLeases(a, l, "user", email);
describe("legacy signed lease subject evidence", () => {
  it("accepts only a bound exact application, owner, property and verified mailbox", () => { expect(resolve()).toEqual([lease]); });
  it.each([
    { ...lease, manager_user_id: "other" }, { ...lease, property_id: "other" }, { ...lease, resident_user_id: "other" },
    { ...lease, row_data: { axisId: "AXIS-1", residentUserId: "other" } }, { ...lease, row_data: { axisId: "AXIS-2" } },
    { ...lease, row_data: { axisId: "AXIS-1", leaseKind: "joint_bundle" } },
    { ...lease, row_data: { axisId: "AXIS-1", managerUserId: "other" } },
    { ...lease, row_data: { axisId: "AXIS-1", propertyId: "other" } },
    { ...lease, row_data: { axisId: "AXIS-1", residentEmail: "other@example.invalid" } },
  ])("rejects mismatched candidate %o", (candidate) => { expect(resolve([app], [candidate])).toEqual([]); });
  it("uses assigned property precedence over stale fields", () => {
    expect(resolve([{ ...app, property_id: "stale", assigned_property_id: "house" }])).toEqual([lease]);
    expect(resolve([{ ...app, property_id: "house", assigned_property_id: "other" }])).toEqual([]);
    expect(resolve([{ ...app, row_data: { ...app.row_data, assignedPropertyId: "other" } }])).toEqual([]);
  });
  it("rejects ambiguous applications, wrong subject, withdrawn and absent mailbox", () => {
    expect(resolve([app, app])).toEqual([]);
    expect(resolve([{ ...app, row_data: { ...app.row_data, residentUserId: "other" } }])).toEqual([]);
    expect(resolve([{ ...app, row_data: { ...app.row_data, withdrawnAt: "now" } }])).toEqual([]);
    expect(resolve([app], [lease], "")).toEqual([]);
  });
});
