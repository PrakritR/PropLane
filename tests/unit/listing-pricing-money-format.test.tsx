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

function seededRoom(room: Partial<ManagerListingSubmissionV1["rooms"][number]>): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    allowedLeaseTerms: ["Long-term"],
    rooms: [{ id: "r1", name: "Room A", monthlyRent: 1200, utilitiesEstimate: "150", ...room }],
  } as ManagerListingSubmissionV1;
}

function EditorWithRoom({ room }: { room: Partial<ManagerListingSubmissionV1["rooms"][number]> }) {
  const [sub, setSub] = useState(() => seededRoom(room));
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
  fireEvent.click(screen.getByRole("button", { name: "Open Room A prices" }));
}

describe("Room card — Rent formats like Utilities and Deposit (PRP-499)", () => {
  it("trims stray whitespace on Rent exactly like it already does on Utilities and Deposit", () => {
    render(
      <EditorWithRoom
        room={{
          monthlyRent: " 1200" as unknown as number,
          utilitiesEstimate: " 150",
          securityDeposit: " 900",
        }}
      />,
    );
    openPricing();

    const rent = screen.getByLabelText(/Room A rent on/i) as HTMLInputElement;
    const util = screen.getByLabelText(/Room A utilities on/i) as HTMLInputElement;
    const dep = screen.getByLabelText(/Room A deposit on/i) as HTMLInputElement;

    expect(rent.value).toBe("1200");
    expect(util.value).toBe("150");
    expect(dep.value).toBe("900");
  });

  it("still shows a clean whole-number Rent with no formatting regression", () => {
    render(<EditorWithRoom room={{ monthlyRent: 1450, utilitiesEstimate: "120", securityDeposit: "1000" }} />);
    openPricing();
    expect((screen.getByLabelText(/Room A rent on/i) as HTMLInputElement).value).toBe("1450");
  });

  it("shows an empty Rent field (not '0') when no rent has been set yet", () => {
    render(<EditorWithRoom room={{ monthlyRent: 0, utilitiesEstimate: "", securityDeposit: "" }} />);
    openPricing();
    expect((screen.getByLabelText(/Room A rent on/i) as HTMLInputElement).value).toBe("");
  });
});
