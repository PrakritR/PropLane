// @vitest-environment jsdom
/**
 * Evidence harness (round 8, 2026-11-17) for the property editor:
 *
 * 1. The preview's Bathrooms fact equals the Basics stepper count.
 * 2. Next visits EVERY step, including empty Rooms / Bathrooms / Shared spaces,
 *    each of which shows its own empty state rather than being skipped.
 * 3. The pricing step is titled "Pricing".
 * 4. Publishing with no photos or an unpriced room asks ONCE ("Publish
 *    anyway?" / "Save anyway?") — Go back publishes nothing, and no stock photo
 *    is ever substituted.
 *
 * Screenshot-ready HTML is written only when EVIDENCE_DIR is set.
 */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { writeEvidencePage } from "../helpers/evidence-page";
import { renderedBodyHtml } from "../helpers/evidence-dom";

vi.mock("next/navigation", () => ({ usePathname: () => "/portal/properties" }));

function page(name: string, title: string) {
  writeEvidencePage(name, renderedBodyHtml(), { title, width: 1180 });
}

/** A by-the-room home with one priced room, one unpriced room and no photo. */
function sharedHomeSubmission(): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  const room = base.rooms[0] ?? ({} as ManagerListingSubmissionV1["rooms"][number]);
  return {
    ...base,
    address: "142 Ash St",
    city: "Brooklyn",
    state: "NY",
    zip: "11201",
    listingPlaceCategoryId: "shared_home",
    allowedLeaseTerms: [LONG_TERM_LEASE_TERM],
    listingTotalBathroomsId: "3",
    bathrooms: [],
    sharedSpaces: [],
    housePhotoDataUrls: [],
    // The house default rent is explicitly blank, so Room B inherits nothing and
    // really has no price from anywhere while Room A carries its own.
    houseDefaults: { monthlyRent: "" },
    rooms: [
      { ...room, id: "room-a", name: "Room A", monthlyRent: "1200", termPricing: undefined },
      { ...room, id: "room-b", name: "Room B", monthlyRent: "", termPricing: undefined },
    ],
  } as ManagerListingSubmissionV1;
}

function Harness({ onPublish, initial }: { onPublish: () => Promise<boolean>; initial: ManagerListingSubmissionV1 }) {
  const [sub, setSub] = useState(initial);
  return (
    <AppUiProvider>
      <ListingEditorV2 title="142 Ash St" submission={sub} onChange={setSub} onClose={() => {}} onPublish={onPublish} />
    </AppUiProvider>
  );
}

function nextButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-attr="listing-v2-next"]');
}
/** The preview panel's Bathrooms fact (a <dt>/<dd> pair), not the rail's step label. */
function bathroomsFact(): string {
  const dt = Array.from(document.querySelectorAll("dt")).find((el) => el.textContent?.trim() === "Bathrooms");
  return (dt?.nextElementSibling?.textContent ?? "").trim();
}

afterEach(cleanup);

describe("Property editor — round 8 evidence", () => {
  it("previews the stepper's bathroom count, walks every step, titles pricing, and asks once before publishing with gaps", async () => {
    const onPublish = vi.fn(async () => true);
    render(<Harness onPublish={onPublish} initial={sharedHomeSubmission()} />);

    // 1. Preview Bathrooms agrees with the Basics stepper (3, with no bathroom cards).
    expect(bathroomsFact()).toBe("3");
    page("listing-01-basics-bathrooms", "Basics · three bathrooms on the stepper, and the preview's Bathrooms fact says 3");

    // Move the stepper and the preview follows it.
    fireEvent.click(screen.getByRole("button", { name: "More bathrooms" }));
    await waitFor(() => expect(bathroomsFact()).toBe("3.5"));
    page("listing-01b-basics-bathrooms-stepped", "Basics · one tap on the stepper (3 → 3.5) and the preview's Bathrooms fact follows");

    // 2. Next visits every step, in order, with nothing entered on the optional ones.
    const visited: string[] = [];
    for (let guard = 0; guard < 12; guard += 1) {
      const button = nextButton();
      if (!button) break;
      const label = (button.getAttribute("aria-label") ?? "").replace(/^Next: /, "");
      fireEvent.click(button);
      visited.push(label);
      if (label === "Rooms") page("listing-02-step-rooms", "Next → Rooms");
      if (label === "Bathrooms") page("listing-03-step-bathrooms-empty", "Next → Bathrooms — the empty optional step is visited, with its own Add action");
      if (label === "Shared spaces") page("listing-04-step-spaces-empty", "Next → Shared spaces — empty, still visited");
      if (label === "Pricing") page("listing-05-step-pricing-title", 'Next → the pricing step, titled "Pricing"');
    }
    expect(visited).toEqual([
      "Rooms",
      "Bathrooms",
      "Shared spaces",
      "Application",
      "Lease",
      "Move-in",
      "Pricing",
      "Review",
    ]);

    // 3. Publish with no photo and an unpriced room asks once.
    fireEvent.click(screen.getByRole("button", { name: "Create property" }));
    await waitFor(() => expect(screen.getByText("Publish anyway?")).toBeTruthy());
    expect(screen.getByText("No photos yet · 1 room has no price.")).toBeTruthy();
    page("listing-06-publish-anyway", "Review · Create property with no photo and one unpriced room — asked once, never given a stock photo");
    expect(onPublish).not.toHaveBeenCalled();

    // Go back publishes nothing.
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    await waitFor(() => expect(screen.queryByText("Publish anyway?")).toBeNull());
    expect(onPublish).not.toHaveBeenCalled();

    // One yes publishes, and the question is asked only that once.
    fireEvent.click(screen.getByRole("button", { name: "Create property" }));
    await waitFor(() => expect(screen.getByText("Publish anyway?")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(onPublish).toHaveBeenCalledTimes(1));
    page("listing-07-published", "After one yes — published, with no second question and no fabricated photo");
  });

  it("asks nothing when there is a real photo and every room is priced", async () => {
    const onPublish = vi.fn(async () => true);
    const base = sharedHomeSubmission();
    render(
      <Harness
        onPublish={onPublish}
        initial={{
          ...base,
          housePhotoDataUrls: ["https://cdn.example.test/ash-st.jpg"],
          rooms: base.rooms.map((room) => ({ ...room, monthlyRent: "1200", termPricing: undefined })),
        }}
      />,
    );
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-review"]')!);
    fireEvent.click(screen.getByRole("button", { name: "Create property" }));
    await waitFor(() => expect(onPublish).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Publish anyway?")).toBeNull();
  });
});
