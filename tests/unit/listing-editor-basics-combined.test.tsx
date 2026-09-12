// @vitest-environment jsdom
//
// Adding a property and editing a listing are ONE editor. A brand-new listing
// opens straight in it at Basics — no "What are you adding?" modal in front —
// and Basics carries the questions that modal used to ask: the property type as
// tiles, how it is rented as two cards, and the bedroom count as a stepper.
// Every answer is stamped on the same submission the rest of the editor reads.
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { ListingWizardV2 } from "@/components/portal/listing-wizard-v2";
import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

afterEach(() => cleanup());

/** Holds the submission the way the wizard does, so a patch shows up on screen. */
function Editor({ onChange }: { onChange?: (sub: ManagerListingSubmissionV1) => void }) {
  const [sub, setSub] = useState(() => createDefaultListingSubmission());
  return (
    <ListingEditorV2
      title="New listing"
      submission={sub}
      onChange={(next) => {
        setSub(next);
        onChange?.(next);
      }}
      onClose={() => {}}
      onSaveExit={() => {}}
      onPublish={() => {}}
    />
  );
}

describe("a new property opens in the editor itself", () => {
  it("starts on Basics with the property-type tiles, not a separate quick-add modal", () => {
    render(<ListingWizardV2 onClose={() => {}} userId="mgr-1" skuTier="starter" />);
    expect(screen.queryByText("What are you adding?")).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "Listing sections" })).toBeTruthy();
    expect(document.querySelector('[data-attr="listing-v2-kind-house"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="quick-add-kind-house"]')).toBeNull();
    // The full editor's own affordances are on the first screen.
    expect(screen.getByRole("button", { name: "Save & exit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Continue to Rooms$/ })).toBeTruthy();
  });
});

describe("Basics carries what Quick Add used to ask", () => {
  it("stamps the property type from a tile", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    render(<Editor onChange={(s) => seen.push(s)} />);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-kind-townhouse"]')!);
    expect(seen.at(-1)?.listingPropertyTypeId).toBe("townhouse");
    expect(document.querySelector('[data-attr="listing-v2-kind-townhouse"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("switches by-the-room and whole-place with the two cards, stamping the rental model", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    render(<Editor onChange={(s) => seen.push(s)} />);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rent-model-entire"]')!);
    expect(seen.at(-1)?.listingPlaceCategoryId).toBe("entire_home");
    expect(seen.at(-1)?.rentalModelStamp).toBe("entire_home");
    expect(screen.getByText("Bedrooms")).toBeTruthy();
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rent-model-shared"]')!);
    expect(seen.at(-1)?.listingPlaceCategoryId).toBe("shared_home");
    expect(screen.getByText("Bedrooms to rent")).toBeTruthy();
  });

  it("counts bedrooms with a stepper and grows the room list to match", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    render(<Editor onChange={(s) => seen.push(s)} />);
    expect(screen.getByRole("button", { name: "Fewer bedrooms" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "More bedrooms" }));
    fireEvent.click(screen.getByRole("button", { name: "More bedrooms" }));
    expect(seen.at(-1)?.listingBedroomSlots).toBe(3);
    expect(seen.at(-1)?.rooms).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Fewer bedrooms" }));
    expect(seen.at(-1)?.rooms).toHaveLength(2);
  });
});
