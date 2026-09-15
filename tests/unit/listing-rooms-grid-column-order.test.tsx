// @vitest-environment jsdom
//
// The rooms grid is one CSS column template consumed by TWO separate row
// bodies — the header and each room row — and the "All rooms" panel above it
// asks the same questions in the same order. Re-order one without the others
// and every cell after the change silently lands under the wrong heading: it
// still renders, it is just wrong, and no type or lint error says so. These
// tests read the real DOM order instead.
//
// The order itself is Franco's: how many people a room sleeps is what a manager
// sets, so People leads the data columns. The grid scrolls sideways on a phone,
// which makes the first column after the name the only one guaranteed to be
// seen — and it used to be Floor.
//
// Only the important questions are columns now — People, Bathroom, Floor, and
// the rent read from Pricing. Beds and furnishing live under More ▾.
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

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

/** A heading cell's words, without the ⓘ button's own "i". */
function headingText(span: Element): string {
  return [...span.childNodes]
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? "")
    .join("")
    .trim();
}

const EXPECTED = ["Room", "People", "Bathroom", "Floor", "Rent"];

describe("rooms grid column order", () => {
  it("leads with People, not Floor, and keeps only the important questions as columns", () => {
    openRooms();
    const header = document.querySelector('[data-attr="listing-v2-room-head"]');
    expect(header, "the grid header").toBeTruthy();
    const labels = [...header!.querySelectorAll(":scope > span")].map(headingText).filter(Boolean);
    expect(labels).toEqual(EXPECTED);
    expect(labels.indexOf("People")).toBeLessThan(labels.indexOf("Floor"));
    expect(labels).not.toContain("Beds");
    expect(labels).not.toContain("Furnishing");
  });

  it("puts each room row's controls under the heading they belong to", () => {
    openRooms();
    const row = document.querySelector('[data-attr="listing-v2-room-row"]');
    expect(row, "a room row").toBeTruthy();

    // Every labelled control in the row, in DOM order — which is grid order.
    const order = [...row!.querySelectorAll("[aria-label]")]
      .map((el) => el.getAttribute("aria-label") ?? "")
      .filter((label) => /^(Name for|Residents per room|Bathroom access|Floor for)/.test(label))
      .map((label) => {
        if (/^Name for/.test(label)) return "Room";
        if (/^Residents per room/.test(label)) return "People";
        if (/^Bathroom access/.test(label)) return "Bathroom";
        return "Floor";
      });

    expect(order).toEqual(["Room", "People", "Bathroom", "Floor"]);
  });

  it("asks the same questions in the same order on the All rooms panel", () => {
    openRooms();
    const panel = document.querySelector('[data-attr="listing-v2-rooms-defaults"]');
    expect(panel, "the All rooms panel").toBeTruthy();
    expect(panel!.textContent).toContain("All rooms");
    // The panel is not a row: it has no name box and no Same-as-all box of its own.
    expect(panel!.querySelector('[data-attr="listing-v2-room-same-as-all"]')).toBeNull();

    const order = [...panel!.querySelectorAll("[aria-label]")]
      .map((el) => el.getAttribute("aria-label") ?? "")
      .filter((label) => /for every room$/.test(label))
      .map((label) => {
        if (/^Residents per room/.test(label)) return "People";
        if (/^Bathroom access/.test(label)) return "Bathroom";
        return "Floor";
      });

    expect(order).toEqual(["People", "Bathroom", "Floor"]);
  });
});

/**
 * The grid's People cell is the PropLane dropdown (a button that opens a
 * portaled listbox), not a native <select>: open it by its label, pick with the
 * pointer gesture the listbox handles natively, and read the value off the
 * trigger's text.
 */
const trigger = (label: string) => screen.getByRole("button", { name: label });
const pick = (label: string, value: string) => {
  const t = trigger(label);
  fireEvent.click(t);
  const listbox = document.getElementById(t.getAttribute("aria-controls")!)!;
  const option = listbox.querySelector(`[data-field-select-option-value="${value}"]`)!;
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
};
const shows = (label: string) => trigger(label).textContent?.replace(/\s+/g, " ").trim() ?? "";

describe("Same as all rooms", () => {
  it("starts ticked, unticks when a cell is changed, and Reset copies the panel back", () => {
    openRooms();
    // Two rooms, so "the other room keeps following" is a real check.
    fireEvent.click(document.querySelector('[data-attr="listing-v2-add-room"]')!);
    const boxes = () => [...document.querySelectorAll<HTMLInputElement>('[data-attr="listing-v2-room-same-as-all"]')];
    expect(boxes().length).toBe(2);
    expect(boxes().map((b) => b.checked)).toEqual([true, true]);

    // Changing a cell on the row is changing the room: the box unticks itself.
    pick("Residents per room for Room 1", "3");
    expect(shows("Residents per room for Room 1")).toContain("3");
    expect(boxes()[0]!.checked).toBe(false);
    expect(boxes()[1]!.checked).toBe(true);
    expect(document.querySelector('[data-attr="listing-v2-room-row"]')!.textContent).toContain("This room only");

    // Reset puts the panel's value back and re-ticks.
    fireEvent.click(document.querySelector('[data-attr="listing-v2-make-same"]')!);
    expect(boxes()[0]!.checked).toBe(true);
    expect(shows("Residents per room for Room 1")).toContain("1");
    expect(shows("Residents per room for Room 1")).not.toContain("3");
  });

  it("unticking moves nothing, and a later panel change leaves that room alone", () => {
    openRooms();
    fireEvent.click(document.querySelector('[data-attr="listing-v2-add-room"]')!);
    const boxes = () => [...document.querySelectorAll<HTMLInputElement>('[data-attr="listing-v2-room-same-as-all"]')];

    // Untick the first room: its values do not change, it is just its own now.
    fireEvent.click(boxes()[0]!);
    expect(boxes()[0]!.checked).toBe(false);
    expect(shows("Residents per room for Room 1")).toContain("1");
    expect(document.querySelector('[data-attr="listing-v2-room-row"]')!.textContent).toContain("This room only");

    // Change People on the panel: the ticked room follows, the unticked one does not.
    pick("Residents per room for every room", "2");
    expect(shows("Residents per room for Room 2")).toContain("2");
    expect(shows("Residents per room for Room 1")).toContain("1");
    expect(shows("Residents per room for Room 1")).not.toContain("2");
  });

  it("the editor has one closer, Done, and no Duplicate or Remove", () => {
    openRooms();
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-more"]')!);
    const editor = document.querySelector('[data-attr="listing-v2-room-editor"]')!;
    const buttons = [...editor.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttons).toContain("Done");
    expect(buttons).not.toContain("Duplicate");
    expect(buttons).not.toContain("Remove");
    // While it is open the row's More link is gone — Done is the only way out.
    expect(document.querySelector('[data-attr="listing-v2-room-more"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-done"]')!);
    expect(document.querySelector('[data-attr="listing-v2-room-editor"]')).toBeNull();
  });
});
