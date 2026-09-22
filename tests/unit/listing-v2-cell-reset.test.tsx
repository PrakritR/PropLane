// @vitest-environment jsdom
//
// PLAN-0921-1648: Rooms and Bathrooms lost their per-field Reset along with
// their "Every …" card, joining Shared spaces (PLAN-0920-0631) — every record
// on all three steps is its own, full stop, and no field carries a Reset tag
// back to anything. "Same as Room X" / "Same as Bathroom X" is the one way a
// record starts from another's description now; it is covered in
// listing-same-as-copy.test.ts and listing-rooms-bathrooms-no-default.test.ts.
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

const base = createDefaultListingSubmission();
const seeded: ManagerListingSubmissionV1 = {
  ...base,
  listingStoriesId: "2",
  rooms: [
    { ...base.rooms[0]!, id: "r1", name: "Room A" },
    { ...base.rooms[0]!, id: "r2", name: "Room B" },
  ],
  bathrooms: [
    { id: "b1", name: "Upstairs", assignedRoomIds: ["r1"] },
    { id: "b2", name: "Downstairs", assignedRoomIds: ["r2"] },
  ],
  sharedSpaces: [
    { id: "s1", name: "Kitchen", spaceKind: "kitchen", roomAccessIds: ["r1", "r2"] },
    { id: "s2", name: "Den", spaceKind: "living", roomAccessIds: ["r1", "r2"] },
  ],
};

function Editor({ onChange }: { onChange?: (sub: ManagerListingSubmissionV1) => void }) {
  const [sub, setSub] = useState(seeded);
  return (
    <ListingEditorV2
      title="Edit listing"
      submission={sub}
      isEdit
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

function open(step: "rooms" | "bathrooms" | "spaces", onChange?: (sub: ManagerListingSubmissionV1) => void) {
  render(<Editor onChange={onChange} />);
  fireEvent.click(document.querySelector(`[data-attr="listing-v2-rail-${step}"]`)!);
}

const trigger = (label: string) => screen.getByRole("button", { name: label });
/** A record's rows live inside its card; open it to reach them. */
const openCard = (label: string) => fireEvent.click(screen.getByRole("button", { name: `Open ${label}` }));
const pick = (label: string, value: string) => {
  const t = trigger(label);
  fireEvent.click(t);
  const option = document.getElementById(t.getAttribute("aria-controls")!)!.querySelector(`[data-field-select-option-value="${value}"]`)!;
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
};
const optionValues = (label: string) => {
  const t = trigger(label);
  fireEvent.click(t);
  const values = [...document.getElementById(t.getAttribute("aria-controls")!)!.querySelectorAll('[role="option"]')]
    .map((o) => o.getAttribute("data-field-select-option-value") ?? "")
    .filter(Boolean);
  fireEvent.click(t);
  return values;
};

describe("no per-field Reset on the listing cards (PLAN-0921-1648)", () => {
  it("rooms: a room's floor is its own — no Every card to follow and no Reset", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("rooms", (s) => seen.push(s));
    expect(screen.queryByRole("button", { name: "Floor for every room" })).toBeNull();
    openCard("Room A");
    const floors = optionValues("Floor for Room A");
    expect(floors.length).toBeGreaterThan(1);
    expect(screen.queryByRole("button", { name: /Reset floor for Room A/ })).toBeNull();
    pick("Floor for Room A", floors[1]!);
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r1")?.floor).toBe(floors[1]);
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r2")?.floor ?? "").toBe("");
    expect(screen.queryByRole("button", { name: /Reset floor for Room A/ })).toBeNull();
  });

  it("bathrooms: a bathroom's type is its own — no Every card to follow and no Reset", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("bathrooms", (s) => seen.push(s));
    expect(screen.queryByRole("button", { name: "Type of every bathroom" })).toBeNull();
    openCard("Upstairs");
    pick("Type of Upstairs", "full");
    expect(seen.at(-1)!.bathrooms!.find((b) => b.id === "b1")?.bathtub).toBe(true);
    expect(seen.at(-1)!.bathrooms!.find((b) => b.id === "b2")?.bathtub ?? false).toBe(false);
    expect(screen.queryByRole("button", { name: /Reset type of Upstairs/ })).toBeNull();
  });

  it("shared spaces: a space's floor is its own — no Every card to follow and no Reset", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("spaces", (s) => seen.push(s));
    expect(screen.queryByRole("button", { name: "Floor for every shared space" })).toBeNull();
    openCard("Kitchen");
    const floors = optionValues("Floor for Kitchen");
    expect(floors.length).toBeGreaterThan(1);
    pick("Floor for Kitchen", floors[1]!);
    expect(seen.at(-1)!.sharedSpaces!.find((s) => s.id === "s1")?.location).toBe(floors[1]);
    expect(seen.at(-1)!.sharedSpaces!.find((s) => s.id === "s2")?.location ?? "").toBe("");
    expect(screen.queryByRole("button", { name: /Reset floor for Kitchen/ })).toBeNull();
  });
});
