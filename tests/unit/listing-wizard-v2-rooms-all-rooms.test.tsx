// @vitest-environment jsdom
//
// The Rooms step's top card is "All rooms" — every room follows it, per
// field, until a hand edit detaches that one field (Reset puts it back). A
// plain value comparison alone cannot answer "is this the room's own": a
// field a manager set to whatever All rooms happens to show right now would
// misread as "still following" the moment the page reloads and the session
// state that remembered the act is gone. `room.ownRoomFields` is the
// persisted half of that answer — saved on the room, resolved nowhere else.
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
const boxes = () => [...document.querySelectorAll<HTMLInputElement>('[data-attr="listing-v2-room-same-as-all"]')];

describe("the All rooms panel", () => {
  it("is titled All rooms, not Default room", () => {
    open();
    const every = document.querySelector('[data-attr="listing-v2-defaults-card"]')!;
    expect(every.textContent).toContain("All rooms");
    expect(every.textContent).not.toContain("Default room");
  });

  it("a column tip is a tap-away ⓘ, never a sentence printed under the label", () => {
    open();
    const every = document.querySelector('[data-attr="listing-v2-defaults-card"]')!;
    const floorHelp = "Which level this room is on.";
    expect(every.textContent).not.toContain(floorHelp);
    fireEvent.click(screen.getByRole("button", { name: "What Floor means" }));
    expect(every.textContent).toContain(floorHelp);
  });

  it("secondary fields stay folded under More, not spread across the panel", () => {
    open();
    const every = document.querySelector('[data-attr="listing-v2-defaults-card"]')!;
    expect(screen.queryByRole("button", { name: "Furnishing for every room" })).toBeNull();
    fireEvent.click(every.querySelector('[data-attr="listing-v2-defaults-more"]')!);
    expect(screen.getByRole("button", { name: "Furnishing for every room" })).toBeTruthy();
  });
});

describe("a room detaches from All rooms one field at a time", () => {
  it("records the touched field on the room, and Reset clears just that record", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open(seeded(), (s) => seen.push(s));
    openCard("Room B");
    pick("Floor for Room B", "2nd floor");
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r2")!.ownRoomFields).toEqual(["floor"]);
    expect(boxes().map((b) => b.checked)).toEqual([true, false]);
    fireEvent.click(screen.getByRole("button", { name: "Reset floor for Room B to All rooms" }));
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r2")!.ownRoomFields ?? []).toEqual([]);
    expect(boxes().map((b) => b.checked)).toEqual([true, true]);
  });

  it("ticking Same as all rooms clears every field the room had detached", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open(seeded(), (s) => seen.push(s));
    openCard("Room B");
    pick("Floor for Room B", "2nd floor");
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r2")!.ownRoomFields).toEqual(["floor"]);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-make-same"]')!);
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r2")!.ownRoomFields ?? []).toEqual([]);
    expect(boxes().map((b) => b.checked)).toEqual([true, true]);
  });

  it("duplicating a detached room carries its own fields, reflected immediately with no reload", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open(seeded(), (s) => seen.push(s));
    openCard("Room B");
    pick("Floor for Room B", "2nd floor");
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Room B" }));
    const copy = seen.at(-1)!.rooms.find((r) => r.id !== "r1" && r.id !== "r2")!;
    expect(copy.name).toBe("Room B (copy)");
    expect(copy.ownRoomFields).toEqual(["floor"]);
    // The copy's card opened automatically; its own field shows a Reset without a remount.
    expect(screen.getByRole("button", { name: `Reset floor for ${copy.name} to All rooms` })).toBeTruthy();
    expect(boxes().map((b) => b.checked)).toEqual([true, false, false]);
  });
});

describe("a detached field survives a reload", () => {
  it("keeps a room's field marked as its own even when the value coincidentally matches All rooms", () => {
    const base = seeded();
    const reopened: ManagerListingSubmissionV1 = {
      ...base,
      houseDefaults: { floor: "1st floor" },
      rooms: [
        { ...base.rooms[0]!, floor: "1st floor", ownRoomFields: ["floor"] },
        { ...base.rooms[1]! },
      ],
    };
    open(reopened);
    // Plain value comparison alone would read Room A's floor as following (it
    // equals All rooms' "1st floor"); the persisted flag says otherwise.
    expect(boxes().map((b) => b.checked)).toEqual([false, true]);
    openCard("Room A");
    expect(screen.getByRole("button", { name: "Reset floor for Room A to All rooms" })).toBeTruthy();
  });

  it("a field with no persisted flag still reads as following when its value matches", () => {
    const base = seeded();
    const reopened: ManagerListingSubmissionV1 = {
      ...base,
      houseDefaults: { floor: "1st floor" },
      rooms: [{ ...base.rooms[0]!, floor: "1st floor" }, { ...base.rooms[1]! }],
    };
    open(reopened);
    expect(boxes().map((b) => b.checked)).toEqual([true, true]);
  });
});
