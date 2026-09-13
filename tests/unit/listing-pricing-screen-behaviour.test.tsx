// @vitest-environment jsdom
//
// The edit-listing Pricing screen, driven the way a manager drives it. These are
// the captain's own complaints of 2026-09-13, each one turned into a thing the
// screen must actually do:
//   - payment setup comes FIRST, not below three sections that cannot matter yet
//   - the application fee and waiver code are asked once, not in two places
//   - a room's utilities can be set to $0 and stay $0
//   - a room that has its own numbers offers a way back to the house numbers
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

function seeded(): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    applicationFee: "50",
    applicationFeeWaiverCode: "JHASDA",
    allowedLeaseTerms: ["Long-term", "Month-to-Month", "Custom"],
    rooms: [
      { id: "r1", name: "Room A", monthlyRent: 1100, utilitiesEstimate: "150" },
      { id: "r2", name: "Room B", monthlyRent: 1100, utilitiesEstimate: "150" },
    ],
  } as ManagerListingSubmissionV1;
}

function Editor({ onChange }: { onChange?: (sub: ManagerListingSubmissionV1) => void } = {}) {
  const [sub, setSub] = useState(seeded);
  return (
    <ListingEditorV2
      title="Edit listing"
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

/** Open the Pricing section of the editor. */
function openPricing() {
  render(<Editor />);
  const nav = screen.getByRole("navigation", { name: "Listing sections" });
  const pricing = Array.from(nav.querySelectorAll("button")).find((b) =>
    /rent|pricing|deposit/i.test(b.textContent ?? ""),
  );
  expect(pricing, "Pricing nav entry").toBeTruthy();
  fireEvent.click(pricing!);
}

describe("Pricing puts payment setup first", () => {
  it("leads with How you get paid, then Applications, then the rooms", () => {
    openPricing();
    const headings = Array.from(document.querySelectorAll("h3")).map((h) => h.textContent ?? "");
    const paid = headings.findIndex((h) => h.includes("How you get paid"));
    const apps = headings.findIndex((h) => h.includes("Applications"));
    const rooms = headings.findIndex((h) => h.includes("Each room"));
    const signing = headings.findIndex((h) => h.includes("At signing"));

    expect(paid).toBeGreaterThanOrEqual(0);
    expect(paid).toBeLessThan(apps);
    expect(apps).toBeLessThan(rooms);
    expect(rooms).toBeLessThan(signing);
  });

  it("asks for the application fee and waiver code exactly once", () => {
    openPricing();
    // Both used to appear here AND on Advanced — and the Advanced copies wrote
    // the raw input, so letters typed there were stored as the fee.
    const labelTexts = Array.from(document.querySelectorAll("label")).map((l) => l.textContent ?? "");
    const count = (re: RegExp) => labelTexts.filter((t) => re.test(t)).length;

    expect(count(/^Long-term application fee/)).toBe(1);
    expect(count(/^Short-term application fee/)).toBe(1);
    expect(count(/^Waiver code/)).toBe(1);
    // The retired second copy carried this exact label.
    expect(count(/^Application fee waive code/)).toBe(0);
  });
});

describe("a room can be priced at $0", () => {
  it("keeps a typed 0 in the utilities cell instead of snapping back to the house number", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Editor onChange={(s) => (latest = s)} />);
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    const pricing = Array.from(nav.querySelectorAll("button")).find((b) =>
      /rent|pricing|deposit/i.test(b.textContent ?? ""),
    );
    fireEvent.click(pricing!);

    const cell = screen.getByLabelText(/Room A utilities on/i) as HTMLInputElement;
    fireEvent.change(cell, { target: { value: "0" } });

    const roomA = (latest?.rooms ?? []).find((r) => r.id === "r1");
    expect(roomA?.utilitiesEstimate).toBe("0");

    // And it survives back onto the screen as a real 0, not an empty box showing
    // the house placeholder — which is exactly what used to happen.
    const after = screen.getByLabelText(/Room A utilities on/i) as HTMLInputElement;
    expect(after.value).toBe("0");
  });
});

describe("a room with its own numbers can go back to the house numbers", () => {
  it("offers Reset only once the row differs, and clears the row when pressed", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Editor onChange={(s) => (latest = s)} />);
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    fireEvent.click(
      Array.from(nav.querySelectorAll("button")).find((b) => /rent|pricing|deposit/i.test(b.textContent ?? ""))!,
    );

    expect(document.querySelectorAll('[data-attr="listing-v2-price-row-reset"]')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/Room A utilities on/i), { target: { value: "0" } });
    const resets = document.querySelectorAll('[data-attr="listing-v2-price-row-reset"]');
    expect(resets.length).toBeGreaterThan(0);

    fireEvent.click(resets[0] as HTMLElement);
    const roomA = (latest?.rooms ?? []).find((r) => r.id === "r1");
    expect(roomA?.utilitiesEstimate).toBe("");
  });
});
