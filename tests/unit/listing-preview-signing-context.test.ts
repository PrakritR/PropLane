import { describe, expect, it } from "vitest";
import type { MockProperty } from "@/data/types";
import { withListingSigningContext } from "@/hooks/use-listing-signing-context";
import { DEFAULT_LEASING_PIPELINE, signingContextForPipeline } from "@/lib/leasing-pipeline-preferences";
import { resolvePublicSigningContext } from "@/lib/public-listings.server";

/**
 * The manager's Preview and the public projection must answer "Apply" with the SAME rule.
 */
describe("signing context — one rule for the public page and the manager Preview", () => {
  const leaseFirst = { ...DEFAULT_LEASING_PIPELINE, pipelineOrder: "lease_then_application" as const, leaseSigningFeeCents: 10000 };

  it("collapses the pipeline preference to the derived pair", () => {
    expect(signingContextForPipeline(DEFAULT_LEASING_PIPELINE)).toEqual({ signingOrder: "application_first", leaseSigningFeeCents: 0 });
    expect(signingContextForPipeline(leaseFirst)).toEqual({ signingOrder: "application_first", leaseSigningFeeCents: 10000 });
  });

  it("carries Application before a tour only when Required", () => {
    expect(signingContextForPipeline(DEFAULT_LEASING_PIPELINE)).not.toHaveProperty("applicationBeforeTour");
    expect(signingContextForPipeline({ ...DEFAULT_LEASING_PIPELINE, applicationBeforeTour: "required" })).toMatchObject({
      applicationBeforeTour: true,
    });
  });

  it("is exactly what the public projection resolves for the same preference", () => {
    const state = { portfolio: leaseFirst, byPropertyId: {} };
    expect(resolvePublicSigningContext(state, "prop-1")).toEqual(signingContextForPipeline(leaseFirst));
    expect(resolvePublicSigningContext(undefined, "prop-1")).toEqual(signingContextForPipeline(DEFAULT_LEASING_PIPELINE));
  });

  it("stamps the pair onto the Preview's property and leaves it alone before the answer lands", () => {
    const property = { id: "prop-1", title: "Home" } as unknown as MockProperty;
    expect(withListingSigningContext(property, null)).toBe(property);
    expect(withListingSigningContext(property, signingContextForPipeline(leaseFirst))).toMatchObject({
      signingOrder: "application_first",
      leaseSigningFeeCents: 10000,
    });
  });
});
