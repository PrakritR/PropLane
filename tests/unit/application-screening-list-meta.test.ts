import { describe, expect, it } from "vitest";
import {
  screeningListTrailForApplicant,
  screeningListTrailForCosigner,
} from "@/lib/application-screening-list-meta";

describe("application-screening-list-meta", () => {
  it("labels applicant screening pending without consent", () => {
    const trail = screeningListTrailForApplicant({
      id: "AXIS-1",
      application: { consentCredit: false },
    } as never);
    expect(trail.label).toBe("Pending");
    expect(trail.tone).toBe("pending");
  });

  it("labels applicant screening ready when consented and not started", () => {
    const trail = screeningListTrailForApplicant({
      id: "AXIS-1",
      application: { consentCredit: true },
    } as never);
    expect(trail.label).toBe("Get check");
    expect(trail.tone).toBe("ready");
  });

  it("labels cosigner screening complete", () => {
    const trail = screeningListTrailForCosigner({
      consentCredit: true,
      backgroundCheck: { status: "complete" },
    } as never);
    expect(trail.label).toBe("Complete");
    expect(trail.tone).toBe("complete");
  });
});
