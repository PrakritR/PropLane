// @vitest-environment jsdom
//
// A brand-new listing's Pricing step must not show example numbers. The
// captain's report (screenshot, 2026-09-22): a NEW listing's Rent /mo,
// Utilities /mo, Deposit and Application fee fields showed "1,100" / "150" /
// "1,000" / "50" as if pre-filled, and "Charge an application fee" was
// ticked. A blank field must show only the "$" prefix, and a genuinely new
// listing must start with the application-fee switch off.
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

/** A truly new listing: `createDefaultListingSubmission()`, untouched. */
function Editor({ onChange }: { onChange?: (sub: ManagerListingSubmissionV1) => void } = {}) {
  const [sub, setSub] = useState<ManagerListingSubmissionV1>(() => ({
    ...createDefaultListingSubmission(),
    listingPlaceCategoryId: "shared_home",
    allowedLeaseTerms: ["Long-term"],
  }));
  return (
    <ListingEditorV2
      title="Add listing"
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

function openPricing() {
  render(<Editor />);
  const nav = screen.getByRole("navigation", { name: "Listing sections" });
  const pricing = Array.from(nav.querySelectorAll("button")).find((b) => /pricing/i.test(b.textContent ?? ""));
  expect(pricing, "Pricing nav entry").toBeTruthy();
  fireEvent.click(pricing!);
}

describe("a new listing's Pricing step starts blank", () => {
  it("shows no example amount in Rent /mo, Utilities /mo or Deposit on the Default room card", () => {
    openPricing();
    const rent = screen.getByLabelText("Rent for every room") as HTMLInputElement;
    const util = screen.getByLabelText("Utilities for every room") as HTMLInputElement;
    const deposit = screen.getByLabelText("Deposit for every room") as HTMLInputElement;

    expect(rent.value).toBe("");
    expect(rent.placeholder).toBe("");
    expect(util.value).toBe("");
    expect(util.placeholder).toBe("");
    expect(deposit.value).toBe("");
    expect(deposit.placeholder).toBe("");

    // None of the old example numbers leak into the Default room card at all.
    const defaultsCard = document.querySelector('[data-attr="listing-v2-price-defaults-card"]') as HTMLElement;
    expect(defaultsCard).toBeTruthy();
    for (const example of ["1,100", "150", "1,000"]) {
      expect(defaultsCard.textContent).not.toContain(example);
    }
  });

  it("starts with Charge an application fee unticked, and reveals a blank fee field with no placeholder when ticked", () => {
    openPricing();
    const toggle = document.querySelector('[data-attr="listing-v2-application-fee-on"]') as HTMLInputElement;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(false);
    // The fee row itself is hidden until the switch is on.
    expect(screen.queryByLabelText("Application fee")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    const fee = screen.getByLabelText("Application fee") as HTMLInputElement;
    expect(fee.value).toBe("");
    expect(fee.placeholder).toBe("");
  });

  it("a room whose Default room rent is 900 still shows placeholder 900", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Editor onChange={(s) => (latest = s)} />);
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    const pricing = Array.from(nav.querySelectorAll("button")).find((b) => /pricing/i.test(b.textContent ?? ""));
    fireEvent.click(pricing!);

    const rent = screen.getByLabelText("Rent for every room") as HTMLInputElement;
    fireEvent.change(rent, { target: { value: "900" } });
    expect(latest?.rooms[0]?.monthlyRent).toBe(900);

    const openRoom = screen.getByRole("button", { name: /^Open .* prices$/ });
    fireEvent.click(openRoom);
    const roomRent = screen.getByLabelText(/rent on /i) as HTMLInputElement;
    // The room still follows the Default room, so its own field is blank —
    // but the placeholder shows the real Default room number, not an example.
    expect(roomRent.value).toBe("");
    expect(roomRent.placeholder).toBe("900");
  });
});
