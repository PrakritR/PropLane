// @vitest-environment jsdom
/**
 * The Block dates sheet can hold a room FOR someone: pick a resident already
 * on the books, or add a new one inline without leaving the sheet. The primary
 * button sits bottom-right like every other PropLane dialog.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("@/lib/rental-application/data", () => ({
  getRoomOptionsForProperty: () => [{ value: "h1::r1", label: "Room 1" }],
  parseRoomChoiceValue: (value: string) => ({ listingRoomId: value.split("::")[1] ?? null }),
}));

import { BookingsBlockDatesModal } from "@/components/portal/bookings-block-dates-modal";

const PROPERTY = [{ id: "h1", label: "4709A 8th Ave NE" }];
const RESIDENTS = [
  { key: "email:maya@example.com", name: "Maya Zuneh", email: "maya@example.com", meta: "Room 3 · 4709A 8th Ave NE" },
];

function open(onSave = vi.fn(() => Promise.resolve())) {
  const view = render(
    <BookingsBlockDatesModal
      open
      onClose={() => {}}
      propertyOptions={PROPERTY}
      initialPropertyId="h1"
      initialDayKey="2026-09-20"
      entries={[]}
      residentOptions={RESIDENTS}
      onSave={onSave}
    />,
  );
  return { view, onSave };
}

const attr = (view: ReturnType<typeof render>, name: string) =>
  view.container.ownerDocument.querySelector(`[data-attr="${name}"]`) as HTMLElement | null;

/** The portal select is a trigger + listbox, not a native `<select>`. */
function pick(trigger: HTMLElement, value: string) {
  fireEvent.click(trigger);
  const listbox = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  const option = listbox.querySelector(`[data-field-select-option-value="${value}"]`)!;
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
}
function optionLabels(trigger: HTMLElement): string[] {
  fireEvent.click(trigger);
  const listbox = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  const labels = [...listbox.querySelectorAll('[role="option"]')].map((o) => (o.textContent ?? "").replace(/^✓/, "").trim());
  fireEvent.click(trigger);
  return labels;
}

describe("BookingsBlockDatesModal — resident", () => {
  // The dialog portals into document.body; without this the next test finds the previous sheet.
  afterEach(cleanup);

  it("puts the primary button bottom-right, not bottom-left", () => {
    const { view } = open();
    const button = attr(view, "bookings-block-dates-save")!;
    const footer = button.parentElement!;
    expect(footer.className).toContain("justify-end");
    expect(footer.className).not.toContain("justify-start");
  });

  it("saves with no one by default, and with the picked resident's name and email", async () => {
    const { view, onSave } = open();
    fireEvent.click(attr(view, "bookings-block-dates-save")!);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ residentName: "", residentEmail: "" });

    const select = attr(view, "bookings-block-resident")!;
    expect(optionLabels(select)).toEqual([
      "No one — just close the room",
      "Maya Zuneh · Room 3 · 4709A 8th Ave NE",
      "+ New resident…",
    ]);
    pick(select, "email:maya@example.com");
    fireEvent.click(attr(view, "bookings-block-dates-save")!);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]![0]).toMatchObject({ residentName: "Maya Zuneh", residentEmail: "maya@example.com" });
  });

  it("+ New resident reveals inline fields, needs a name, and saves the typed person", async () => {
    const { view, onSave } = open();
    fireEvent.click(attr(view, "bookings-block-resident-new")!);
    expect(attr(view, "bookings-block-resident-new-fields")).not.toBeNull();
    expect(attr(view, "bookings-block-resident")).toBeNull();

    // Empty name: the sheet refuses rather than saving a nameless "new" person.
    expect((attr(view, "bookings-block-dates-save") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(attr(view, "bookings-block-resident-name")!, { target: { value: "  Alex Rivera " } });
    fireEvent.change(attr(view, "bookings-block-resident-email")!, { target: { value: "Alex@Example.com" } });
    fireEvent.click(attr(view, "bookings-block-dates-save")!);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ residentName: "Alex Rivera", residentEmail: "alex@example.com" });
  });

  it("'Pick from list instead' returns to the select with no one chosen", () => {
    const { view } = open();
    fireEvent.click(attr(view, "bookings-block-resident-new")!);
    fireEvent.click(attr(view, "bookings-block-resident-pick-list")!);
    expect(attr(view, "bookings-block-resident")!.textContent).toContain("No one — just close the room");
  });
});
