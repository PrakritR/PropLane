import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { residentEditLeaseIds } from "@/lib/resident-edit-lease-scope";
const app = { id: "app-1", managerUserId: "owner", propertyId: "new" } as DemoApplicantRow;
const previous = { ...app, propertyId: "old" };
const lease = { id: "lease", axisId: "app-1", managerUserId: "owner", propertyId: "old", residentEmail: "same@example.invalid" } as LeasePipelineRow;
describe("resident edit lease scope", () => {
  it("selects exact application and owner across a property transfer, not same-email other applications", () => {
    const rows = [lease, { ...lease, id: "other", axisId: "app-2", propertyId: "new" }, { ...lease, id: "wrong-owner", managerUserId: "actor" }, { ...lease, id: "unknown", axisId: undefined }];
    expect(residentEditLeaseIds(rows, app, previous).ids).toEqual(["lease"]);
  });
  it("permits the exact joint organizer, but explicitly skips a secondary member", () => {
    const joint = { ...lease, leaseKind: "joint_bundle", primaryApplicationId: "app-1", jointLeaseMembers: [{ applicationId: "app-2" }] } as LeasePipelineRow;
    expect(residentEditLeaseIds([joint], app, previous)).toEqual({ ids: ["lease"], skippedJointMember: false });
    expect(residentEditLeaseIds([joint], { ...app, id: "app-2" }, previous)).toEqual({ ids: [], skippedJointMember: true });
  });
  it("fails closed without owner or placement and does not fan out to shared-room siblings", () => {
    expect(residentEditLeaseIds([lease], { ...app, managerUserId: null }, previous).ids).toEqual([]);
    expect(residentEditLeaseIds([lease, { ...lease, id: "sibling", axisId: "app-2", jointRoomGroupId: "group" }], app, previous).ids).toEqual(["lease"]);
  });
});
