// @vitest-environment jsdom
// The preview's Bathrooms fact agrees with the Basics stepper (basicsBathroomCount), including a stored count with no cards.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ListingPreviewPanel } from "@/components/portal/listing-wizard-v2/listing-side-panel";
import { basicsBathroomCount } from "@/lib/listing-basics-sync";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

afterEach(cleanup);

function bathroomsFact(container: HTMLElement): string {
  const dt = Array.from(container.querySelectorAll("*")).find((el) => el.children.length === 0 && el.textContent === "Bathrooms");
  return (dt?.nextElementSibling?.textContent ?? "").trim();
}

describe("preview bathroom count", () => {
  it("shows the stored count when no bathroom cards exist, like the Basics stepper", () => {
    const sub = { ...createDefaultListingSubmission(), bathrooms: [], listingTotalBathroomsId: "3" };
    expect(basicsBathroomCount(sub)).toBe(3);
    const { container } = render(<ListingPreviewPanel sub={sub} />);
    expect(bathroomsFact(container)).toBe("3");
  });
});
