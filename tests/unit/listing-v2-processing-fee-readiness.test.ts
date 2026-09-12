/**
 * The three-pane editor's Review step says when "PropLane pays" is not actually
 * backed by a promo code: the choice is stored, but checkout bills the resident
 * until a valid code (or an account grant) backs it. A warning, never a blocker.
 */
import { describe, expect, it } from "vitest";
import { listingReadiness } from "@/components/portal/listing-wizard-v2/listing-editor";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const processing = (sub: Parameters<typeof listingReadiness>[0]) =>
  listingReadiness(sub).find((c) => c.id === "processing");

describe("listing v2 · PropLane pays needs a promo code", () => {
  it("warns when PropLane is chosen without a valid code", () => {
    const sub = { ...createDefaultListingSubmission(), serviceFeePayer: "proplane" as const };
    expect(processing(sub)?.state).toBe("warn");
    expect(processing({ ...sub, serviceFeeWaiverCode: "NOPE" })?.state).toBe("warn");
  });

  it("is satisfied by the promo code and absent for the other payers", () => {
    const base = createDefaultListingSubmission();
    expect(processing({ ...base, serviceFeePayer: "proplane", serviceFeeWaiverCode: "free100" })).toBeUndefined();
    expect(processing({ ...base, serviceFeePayer: "resident" })).toBeUndefined();
    expect(processing({ ...base, serviceFeePayer: "manager" })).toBeUndefined();
    expect(processing(base)).toBeUndefined();
  });
});
