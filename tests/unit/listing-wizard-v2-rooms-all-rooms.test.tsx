// @vitest-environment jsdom
//
// PLAN-0921-1648: the Rooms step's "All rooms" card and its per-field
// follow/reset mechanism are gone. Every room is its own card. "Same as
// Room X" — the first row an open card unfolds — copies another room's
// description onto this one once, right now (`copyRoomDescriptionFrom`); its
// value is derived every render from whichever other room this room's
// description still matches (`roomDescriptionMatches`), never stored. A hand
// edit or a "Same as" copy still records the touched fields on
// `room.ownRoomFields`, kept only because it is a persisted field other code
// may still read.
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

function seeded(overrides: Partial<ManagerListingSubmissionV1> = {}): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    listingStoriesId: "2",
    rooms: [
      { ...base.rooms[0]!, id: "r1", name: "Room A" },
      { ...base.rooms[0]!, id: "r2", name: "Room B" },
    ],
    ...overrides,
  } as ManagerListingSubmissionV1;
}

function Editor({ initial, onChange }: { initial: ManagerListingSubmissionV1; onChange?: (sub: ManagerListingSubmissionV1) => void }) {
  const [sub, setSub] = useState(initial);
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

function open(initial = seeded(), onChange?: (sub: ManagerListingSubmissionV1) => void) {
  render(<Editor initial={initial} onChange={onChange} />);
  fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-rooms"]')!);
}

const openCard = (label: string) => fireEvent.click(screen.getByRole("button", { name: `Open ${label}` }));
/** A pick closes its menu on a deferred tick, so a second pick on the same trigger must not toggle it shut. */
const pick = (label: string, value: string) => {
  const t = screen.getByRole("button", { name: label });
  if (t.getAttribute("aria-expanded") !== "true") fireEvent.click(t);
  const option = document.getElementById(t.getAttribute("aria-controls")!)!.querySelector(`[data-field-select-option-value="${value}"]`)!;
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
};

describe("the Rooms step has no All rooms panel", () => {
  it("draws no All rooms / Default room card", () => {
    open();
    expect(document.querySelector('[data-attr="listing-v2-defaults-card"]')).toBeNull();
    expect(screen.queryByText("All rooms")).toBeNull();
    expect(screen.queryByText("Default room")).toBeNull();
  });

  it("a column tip on an open card is a tap-away ⓘ, never a sentence printed under the label", () => {
    open();
    openCard("Room A");
    const editor = document.querySelector('[data-attr="listing-v2-room-editor"]')!;
    const floorHelp = "Which level this room is on.";
    expect(editor.textContent).not.toContain(floorHelp);
    fireEvent.click(screen.getByRole("button", { name: "What Floor means" }));
    expect(editor.textContent).toContain(floorHelp);
  });
});

describe('"Same as" copies one room onto another, once', () => {
  it("offers every other room, reads — once nothing matches", () => {
    const base = seeded();
    open({ ...base, rooms: [{ ...base.rooms[0]!, id: "r1", name: "Room A", floor: "2nd floor" }, { ...base.rooms[1]!, id: "r2", name: "Room B" }] });
    openCard("Room A");
    const sameAs = screen.getByRole("button", { name: "Same as for Room A" });
    expect(sameAs.textContent).toContain("—");
    fireEvent.click(sameAs);
    const list = document.getElementById(sameAs.getAttribute("aria-controls")!)!;
    expect(list.querySelector('[data-field-select-option-value="r2"]')).not.toBeNull();
    // Room A never offers itself.
    expect(list.querySelector('[data-field-select-option-value="r1"]')).toBeNull();
  });

  it("two untouched rooms read — , never each other: nothing was ever copied", () => {
    open();
    openCard("Room A");
    expect(screen.getByRole("button", { name: "Same as for Room A" }).textContent).toContain("—");
    expect(screen.getByRole("button", { name: "Same as for Room A" }).textContent).not.toContain("Room B");
  });

  it("two rooms that describe the same thing read as matching each other", () => {
    const base = seeded();
    open({
      ...base,
      rooms: [
        { ...base.rooms[0]!, id: "r1", name: "Room A", floor: "2nd floor" },
        { ...base.rooms[1]!, id: "r2", name: "Room B", floor: "2nd floor" },
      ],
    } as ManagerListingSubmissionV1);
    openCard("Room A");
    expect(screen.getByRole("button", { name: "Same as for Room A" }).textContent).toContain("Room B");
  });

  it("picking a room copies its floor and furnishing onto this room, and records the touched fields", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open(seeded(), (s) => seen.push(s));
    openCard("Room B");
    pick("Floor for Room B", "2nd floor");
    openCard("Room A");
    pick("Same as for Room A", "r2");
    const roomA = seen.at(-1)!.rooms.find((r) => r.id === "r1")!;
    expect(roomA.floor).toBe("2nd floor");
    // Name and id are never touched by the copy.
    expect(roomA.name).toBe("Room A");
    expect(roomA.id).toBe("r1");
    expect(roomA.ownRoomFields).toContain("floor");
  });

  it("never copies availability, price or per-resident pricing", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    const base = seeded();
    open(
      {
        ...base,
        rooms: [
          { ...base.rooms[0]!, id: "r1", name: "Room A" },
          {
            ...base.rooms[1]!,
            id: "r2",
            name: "Room B",
            floor: "2nd floor",
            monthlyRent: 1500,
            availability: "occupied",
            moveInAvailableDate: "2027-01-01",
            manualUnavailableRanges: [{ id: "block1", start: "2027-01-01", end: null }],
            residentPricing: "per_resident",
            residentPrices: [{ monthlyRent: 900 }, { monthlyRent: 950 }],
          },
        ],
      } as ManagerListingSubmissionV1,
      (s) => seen.push(s),
    );
    openCard("Room A");
    pick("Same as for Room A", "r2");
    const roomA = seen.at(-1)!.rooms.find((r) => r.id === "r1")!;
    expect(roomA.floor).toBe("2nd floor");
    expect(roomA.monthlyRent).toBe(0);
    expect(roomA.availability).not.toBe("occupied");
    expect(roomA.moveInAvailableDate ?? "").not.toBe("2027-01-01");
    expect(roomA.manualUnavailableRanges ?? []).toEqual([]);
    expect(roomA.residentPricing).toBeUndefined();
    expect(roomA.residentPrices).toBeUndefined();
  });

  it("reads back the room this room's description now matches, and — again once it is edited", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    const base = seeded();
    open(
      {
        ...base,
        rooms: [
          { ...base.rooms[0]!, id: "r1", name: "Room A" },
          { ...base.rooms[1]!, id: "r2", name: "Room B", floor: "2nd floor" },
        ],
      } as ManagerListingSubmissionV1,
      (s) => seen.push(s),
    );
    openCard("Room A");
    pick("Same as for Room A", "r2");
    // Room A now matches Room B by value; reopening should read it back.
    fireEvent.click(screen.getByRole("button", { name: "Close Room A" }));
    openCard("Room A");
    expect(screen.getByRole("button", { name: "Same as for Room A" }).textContent).toContain("Room B");
    pick("Floor for Room A", "1st floor");
    expect(screen.getByRole("button", { name: "Same as for Room A" }).textContent).toContain("—");
  });
});
