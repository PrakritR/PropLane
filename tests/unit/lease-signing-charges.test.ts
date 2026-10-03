// Which applications a fully signed lease bills: its own, plus every member of a joint bundle.
import { describe, expect, it } from "vitest";
import { applicationsBilledByLease } from "@/lib/lease-signing-charges.client";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

const app = (id: string, email: string) => ({ id, email, name: id, bucket: "approved" }) as unknown as DemoApplicantRow;
const lease = (over: Partial<LeasePipelineRow>) =>
  ({ id: "l1", axisId: "AXIS-1", residentEmail: "a@x.com", residentName: "A", status: "Fully Signed", ...over }) as unknown as LeasePipelineRow;

describe("applicationsBilledByLease", () => {
  const apps = [app("AXIS-1", "a@x.com"), app("AXIS-2", "b@x.com"), app("AXIS-3", "c@x.com")];

  it("is the lease's own application", () => {
    expect(applicationsBilledByLease(lease({}), apps).map((a) => a.id)).toEqual(["AXIS-1"]);
  });

  it("falls back to the resident email when the id does not match", () => {
    expect(applicationsBilledByLease(lease({ axisId: "AXIS-9", residentEmail: "B@x.com" }), apps).map((a) => a.id)).toEqual(["AXIS-2"]);
  });

  it("bills every member of a joint bundle once", () => {
    const joint = lease({
      leaseKind: "joint_bundle",
      jointLeaseMembers: [
        { applicationId: "AXIS-1", residentEmail: "a@x.com" },
        { applicationId: "AXIS-3", residentEmail: "c@x.com" },
        { applicationId: "AXIS-3", residentEmail: "c@x.com" },
      ],
    } as never);
    expect(applicationsBilledByLease(joint, apps).map((a) => a.id)).toEqual(["AXIS-1", "AXIS-3"]);
  });

  it("is empty when no application is on file", () => {
    expect(applicationsBilledByLease(lease({ axisId: "none", residentEmail: "z@x.com" }), apps)).toEqual([]);
  });
});
