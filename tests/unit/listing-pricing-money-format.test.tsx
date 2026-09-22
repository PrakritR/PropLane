// @vitest-environment jsdom
//
// PRP-499: the Default room card's Rent field used to skip the moneyValue()
// wrapper its two neighbors (Utilities, Deposit) both go through — Rent just
// stringified the raw number. A stray whitespace character surviving on a
// persisted monthlyRent (import, legacy row) rendered inside the input
// unstripped, while the same stray character on Utilities/Deposit was already
// trimmed. All three now read through the same wrapper and format identically.
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import {
  createDefaultListingSubmission,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

afterEach(() => cleanup());

function seededWithHouseDefaults(
  houseDefaults: ManagerListingSubmissionV1["houseDefaults"],
): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    allowedLeaseTerms: ["Long-term"],
    rooms: [{ id: "r1", name: "Room A", monthlyRent: 1200, utilitiesEstimate: "150" }],
    houseDefaults,
  } as ManagerListingSubmissionV1;
}

function EditorWithHouseDefaults({
  houseDefaults,
}: {
  houseDefaults: ManagerListingSubmissionV1["houseDefaults"];
}) {
  const [sub, setSub] = useState(() => seededWithHouseDefaults(houseDefaults));
  return (
    <ListingEditorV2
      title="Edit listing"
      submission={sub}
      onChange={setSub}
      onClose={() => {}}
      onSaveExit={() => {}}
      onPublish={() => {}}
    />
  );
}

function openPricing() {
  const nav = screen.getByRole("navigation", { name: "Listing sections" });
  const pricing = Array.from(nav.querySelectorAll("button")).find((b) => /pricing|rent/i.test(b.textContent ?? ""));
  expect(pricing, "Pricing nav entry").toBeTruthy();
  fireEvent.click(pricing!);
}

describe("Default room card — Rent formats like Utilities and Deposit (PRP-499)", () => {
  it("trims stray whitespace on Rent exactly like it already does on Utilities and Deposit", () => {
    render(
      <EditorWithHouseDefaults
        // A stray leading space is the kind of thing a legacy row or an import
        // can leave behind on a persisted number-typed field. It still passes
        // the field's own "is this set" check (it coerces to a real number),
        // so before this fix it reached the input unstripped.
        houseDefaults={{
          monthlyRent: " 1200" as unknown as number,
          utilitiesEstimate: " 150",
          securityDeposit: " 900",
        }}
      />,
    );
    openPricing();

    const rent = screen.getByLabelText("Rent for every room") as HTMLInputElement;
    const util = screen.getByLabelText("Utilities for every room") as HTMLInputElement;
    const dep = screen.getByLabelText("Deposit for every room") as HTMLInputElement;

    expect(rent.value).toBe("1200");
    expect(util.value).toBe("150");
    expect(dep.value).toBe("900");
  });

  it("still shows a clean whole-number Rent with no formatting regression", () => {
    render(
      <EditorWithHouseDefaults
        houseDefaults={{ monthlyRent: 1450, utilitiesEstimate: "120", securityDeposit: "1000" }}
      />,
    );
    openPricing();
    expect((screen.getByLabelText("Rent for every room") as HTMLInputElement).value).toBe("1450");
  });

  it("shows an empty Rent field (not '0') when no default rent has been set yet", () => {
    render(<EditorWithHouseDefaults houseDefaults={{ monthlyRent: 0 }} />);
    openPricing();
    expect((screen.getByLabelText("Rent for every room") as HTMLInputElement).value).toBe("");
  });
});
