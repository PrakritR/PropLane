// @vitest-environment jsdom
//
// The rooms grid is one CSS column template consumed by THREE separate row
// bodies — the header, "Every room", and each room row. Re-order the template
// without re-ordering all three and every cell after the change silently lands
// under the wrong heading: it still renders, it is just wrong, and no type or
// lint error says so. These tests read the real DOM order instead.
//
// The order itself is Franco's: how many people a room sleeps is what a manager
// sets, so People leads the data columns. The grid scrolls sideways on a phone,
// which makes the first column after the name the only one guaranteed to be
// seen — and it used to be Floor.
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

afterEach(() => cleanup());

function Editor() {
  const [sub, setSub] = useState(() => createDefaultListingSubmission());
  return (
    <ListingEditorV2
      title="New listing"
      submission={sub}
      onChange={setSub}
      onClose={() => {}}
      onSaveExit={() => {}}
      onPublish={() => {}}
    />
  );
}

/** Open the Rooms step. */
function openRooms() {
  render(<Editor />);
  const step = screen.getAllByRole("button").find((b) => /^Rooms/.test(b.textContent ?? ""));
  expect(step, "Rooms step button").toBeTruthy();
  fireEvent.click(step!);
}

const EXPECTED = ["Room", "People", "Bathroom", "Beds", "Floor", "Furnishing", "Rent"];

describe("rooms grid column order", () => {
  it("leads with People, not Floor", () => {
    openRooms();
    const header = document.querySelector('[data-attr="listing-v2-room-row"]')?.parentElement?.parentElement
      ?.querySelector("div");
    const labels = [...(header?.querySelectorAll("span") ?? [])]
      .map((s) => s.textContent?.trim())
      .filter((t): t is string => Boolean(t));
    expect(labels).toEqual(EXPECTED);
    // The point of the change: People comes before Floor, and before Beds.
    expect(labels.indexOf("People")).toBeLessThan(labels.indexOf("Floor"));
    expect(labels.indexOf("People")).toBeLessThan(labels.indexOf("Beds"));
  });

  it("puts each room row's controls under the heading they belong to", () => {
    openRooms();
    const row = document.querySelector('[data-attr="listing-v2-room-row"]');
    expect(row, "a room row").toBeTruthy();

    // Every labelled control in the row, in DOM order — which is grid order.
    const order = [...row!.querySelectorAll("[aria-label]")]
      .map((el) => el.getAttribute("aria-label") ?? "")
      .filter((label) => /Name for|Residents per room|Bathroom access|Beds for|Floor for|Furnishing for/.test(label))
      .map((label) => {
        if (/^Name for/.test(label)) return "Room";
        if (/^Residents per room/.test(label)) return "People";
        if (/^Bathroom access/.test(label)) return "Bathroom";
        if (/^Beds for/.test(label)) return "Beds";
        if (/^Floor for/.test(label)) return "Floor";
        return "Furnishing";
      });

    expect(order).toEqual(["Room", "People", "Bathroom", "Beds", "Floor", "Furnishing"]);
  });

  it("orders the Every room defaults row the same way", () => {
    openRooms();
    const defaultsRow = screen.getByText("Every room").closest("div")?.parentElement;
    expect(defaultsRow, "the Every room row").toBeTruthy();

    const order = [...defaultsRow!.querySelectorAll("[aria-label]")]
      .map((el) => el.getAttribute("aria-label") ?? "")
      .filter((label) => /for every room/.test(label))
      .map((label) => {
        if (/^Residents per room/.test(label)) return "People";
        if (/^Bathroom access/.test(label)) return "Bathroom";
        if (/^Beds/.test(label)) return "Beds";
        if (/^Floor/.test(label)) return "Floor";
        return "Furnishing";
      });

    expect(order).toEqual(["People", "Bathroom", "Beds", "Floor", "Furnishing"]);
  });
});
