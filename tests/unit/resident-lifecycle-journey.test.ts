import { describe, expect, it } from "vitest";
import {
  residentLifecycleSteps,
  resolveResidentLifecycleNextAction,
} from "@/lib/resident-lifecycle-journey";

describe("residentLifecycleSteps", () => {
  it("orders lease-first with sign lease before application received", () => {
    const steps = residentLifecycleSteps({
      signingOrder: "lease_first",
      applicationFeePaid: true,
      applicationSubmitted: true,
      applicationApproved: false,
      residentSignedLease: false,
      managerCountersigned: false,
      moveInChargesPaid: false,
      movedIn: false,
    });
    expect(steps[0]?.id).toBe("sign_lease");
    expect(steps[1]?.id).toBe("received");
  });

  it("surfaces pay fee when the card was declined", () => {
    const action = resolveResidentLifecycleNextAction({
      signingOrder: "application_first",
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
