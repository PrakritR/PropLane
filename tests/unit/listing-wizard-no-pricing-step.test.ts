// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { LISTING_V2_STEPS } from "@/components/portal/listing-wizard-v2/listing-editor";

describe("listing wizard steps (captain, Oct 3: Application, Lease, Move-in and Pricing joined the wizard)", () => {
  it("lists the nine steps in order, the four leasing steps between Shared spaces and Review", () => {
    expect(LISTING_V2_STEPS.map((s) => s.label)).toEqual([
      "Basics",
      "Rooms",
      "Bathrooms",
      "Shared spaces",
      "Application",
      "Lease",
      "Move-in",
      "Pricing",
      "Review",
    ]);
    expect(LISTING_V2_STEPS.map((s) => s.id)).toEqual([
      "basics",
      "rooms",
      "bathrooms",
      "spaces",
      "application",
      "lease",
      "movein",
      "pricing",
      "review",
    ]);
  });
});
