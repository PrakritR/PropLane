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
  it("shows no example amount on a new room card, and draws no Default room card", () => {
    openPricing();
    expect(document.querySelector('[data-attr="listing-v2-price-defaults-card"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Open .* prices$/ }));
    const rent = screen.getByLabelText(/rent on /i) as HTMLInputElement;
    const util = screen.getByLabelText(/utilities on /i) as HTMLInputElement;
    const deposit = screen.getByLabelText(/deposit on /i) as HTMLInputElement;

    expect(rent.value).toBe("");
    expect(rent.placeholder).toBe("");
    expect(util.value).toBe("");
    expect(util.placeholder).toBe("");
    expect(deposit.value).toBe("");
    expect(deposit.placeholder).toBe("");

    for (const example of ["1,100", "150", "1,000"]) {
      expect(document.body.textContent).not.toContain(example);
    }
  });

  it("offers no application fee on the listing — it is set once in Application system settings", () => {
    // PLAN-0924-1254: the account-wide fee is authoritative for every listing.
    openPricing();
    expect(document.querySelector('[data-attr="listing-v2-application-fee-on"]')).toBeNull();
    expect(screen.queryByLabelText("Application fee")).toBeNull();
  });

  it("typing Room 1 rent does not fill another room", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    function TwoRooms() {
      const [sub, setSub] = useState<ManagerListingSubmissionV1>(() => {
        const base = createDefaultListingSubmission();
        return {
          ...base,
          listingPlaceCategoryId: "shared_home",
          allowedLeaseTerms: ["Long-term"],
          rooms: [
            { ...base.rooms[0]!, id: "r1", name: "Room 1", monthlyRent: 0 },
            { ...base.rooms[0]!, id: "r2", name: "Room 2", monthlyRent: 0 },
          ],
        };
      });
      return (
        <ListingEditorV2
          title="Add listing"
          submission={sub}
          onChange={(next) => {
            setSub(next);
            latest = next;
          }}
          onClose={() => {}}
          onSaveExit={() => {}}
          onPublish={() => {}}
        />
      );
    }
    render(<TwoRooms />);
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    fireEvent.click(Array.from(nav.querySelectorAll("button")).find((b) => /pricing/i.test(b.textContent ?? ""))!);
    fireEvent.click(screen.getByRole("button", { name: "Open Room 1 prices" }));
    fireEvent.change(screen.getByLabelText(/Room 1 rent on/i), { target: { value: "900" } });
    expect(latest?.rooms[0]?.monthlyRent).toBe(900);
    expect(latest?.rooms[1]?.monthlyRent ?? 0).toBe(0);
  });
});
