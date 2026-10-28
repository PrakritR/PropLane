import { describe, expect, it } from "vitest";
import { APPLY_WAIVER_CODE_PARAM, buildRentalApplyHref } from "@/lib/rental-application/apply-from-listing";
import { buildManagerApplyUrl } from "@/lib/manager-property-links";

describe("apply link waiver code", () => {
  it("carries the minted code in the param the wizard reads", () => {
    const href = buildRentalApplyHref({ propertyId: "p1", waiverCode: " WAIVED-AB12 " });
    expect(new URLSearchParams(href.split("?")[1]).get(APPLY_WAIVER_CODE_PARAM)).toBe("WAIVED-AB12");
    expect(buildManagerApplyUrl("https://x.test/", { propertyId: "p1", waiverCode: "ZZZZ" })).toContain("code=ZZZZ");
  });
  it("omits it when absent", () => {
    expect(buildRentalApplyHref({ propertyId: "p1" })).not.toContain("code=");
  });
});
