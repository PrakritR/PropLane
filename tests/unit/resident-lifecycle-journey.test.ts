import { describe, expect, it } from "vitest";
import {
  residentLifecycleSteps,
  resolveResidentLifecycleNextAction,
} from "@/lib/resident-lifecycle-journey";

describe("residentLifecycleSteps", () => {
  it("always puts the application before the lease: no lease-first order exists", () => {
    const steps = residentLifecycleSteps({
      applicationFeePaid: true,
      applicationSubmitted: true,
      applicationApproved: false,
      residentSignedLease: false,
      managerCountersigned: false,
      moveInChargesPaid: false,
      movedIn: false,
    });
    const ids = steps.map((step) => step.id);
    expect(ids.indexOf("received")).toBeLessThan(ids.indexOf("sign_lease"));
    expect(ids[0]).not.toBe("sign_lease");
  });

  it("surfaces pay fee when the card was declined", () => {
    const action = resolveResidentLifecycleNextAction({
      applicationFeePaid: false,
      applicationSubmitted: true,
      applicationApproved: false,
      residentSignedLease: false,
      managerCountersigned: false,
      moveInChargesPaid: false,
      movedIn: false,
      applicationFeeDeclined: true,
      basePath: "/resident",
    });
    expect(action.title).toBe("Pay the application fee");
    expect(action.urgent).toBe(true);
  });
});
