// @vitest-environment jsdom
//
// Bathrooms and shared spaces are the rooms grid in different clothes: an
// "Every …" top row the records follow, chevrons that open a row in place,
// and per-field follow/own marking. No Details buttons, no checkboxes.
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
import { EVERYONE_ACCESS_VALUE, encodeSharedSpaceEveryone } from "@/lib/listing-shared-space-access";

afterEach(() => cleanup());

function seeded(): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    listingStoriesId: "2",
    rooms: [
      { ...base.rooms[0]!, id: "r1", name: "Room A" },
      { ...base.rooms[0]!, id: "r2", name: "Room B" },
    ],
    bathrooms: [
      { id: "b1", name: "Hall bath", toilet: true, sink: true, shower: true, bathtub: true, assignedRoomIds: ["r1", "r2"], accessKindByRoomId: {} },
      { id: "b2", name: "Upstairs", toilet: true, sink: true, shower: true, bathtub: false, assignedRoomIds: [], accessKindByRoomId: {} },
    ] as never,
    sharedSpaces: [
      { id: "s1", name: "Kitchen", spaceKind: "kitchen", photoDataUrls: [], roomAccessIds: [] },
      { id: "s2", name: "Den", spaceKind: "living_room", photoDataUrls: [], roomAccessIds: ["r1"] },
    ] as never,
  };
}

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

/**
 * The grid's floor cell is the PropLane dropdown (a button that opens a
 * portaled listbox), not a native <select>: open it by its label, read the
 * option values off the listbox, and pick with the pointer gesture the
 * listbox handles natively.
 */
const floorTrigger = (label: string) => screen.getByRole("button", { name: label });
/** The listbox this trigger owns — the menu is portaled, so read it through aria-controls. */
const openFloorListbox = (label: string): HTMLElement => {
  const trigger = floorTrigger(label);
  // A pick closes its menu on a deferred tick; do not toggle an open one shut.
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  return document.getElementById(trigger.getAttribute("aria-controls")!)!;
};
const floorOptions = (label: string): string[] => {
  const values = [...openFloorListbox(label).querySelectorAll('[role="option"]')]
    .map((o) => o.getAttribute("data-field-select-option-value") ?? "")
    .filter(Boolean);
  fireEvent.click(floorTrigger(label)); // toggle closed
  return values;
};
const pickFloor = (label: string, value: string) => {
  const option = openFloorListbox(label).querySelector(`[data-field-select-option-value="${value}"]`)!;
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
};
/** A record's rows live inside its card; open it to reach them. */
const openCard = (label: string) => fireEvent.click(screen.getByRole("button", { name: `Open ${label}` }));
/** Render the editor and walk the rail to one step, the way a manager does. */
function open(step: "bathrooms" | "spaces", onChange?: (sub: ManagerListingSubmissionV1) => void) {
  render(<Editor onChange={onChange} />);
  fireEvent.click(document.querySelector(`[data-attr="listing-v2-rail-${step}"]`)!);
}

describe("bathrooms as cards", () => {
  it("one card per bathroom with a Same-as-all box under its name; a chevron opens it in place, ✕ in the header removes", () => {
    open("bathrooms");
    expect(document.querySelectorAll('[data-attr="listing-v2-bath-card"]').length).toBe(2);
    expect(document.querySelector('[data-attr="listing-v2-bath-card"] [data-attr="listing-v2-bath-same-as-all"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-bath-editor"]')).toBeNull();
    openCard("Upstairs");
    expect(document.querySelector('[data-attr="listing-v2-bath-editor"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-bath-done"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-bath-card-remove"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-bath-remove"]')).toBeNull();
  });

  it("the Every bathroom card moves followers and leaves a bathroom's own value alone", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("bathrooms", (s) => seen.push(s));
    const options = floorOptions("Floor for every bathroom");
    expect(options.length).toBeGreaterThan(1);
    // Upstairs takes its own floor first.
    openCard("Upstairs");
    pickFloor("Floor for Upstairs", options[1]!);
    // Then the house says every bathroom is on options[0].
    pickFloor("Floor for every bathroom", options[0]!);
    const baths = seen.at(-1)!.bathrooms!;
    expect(baths.find((b) => b.id === "b1")?.location).toBe(options[0]);
    expect(baths.find((b) => b.id === "b2")?.location).toBe(options[1]);
    // Reset puts Upstairs back on the house.
    fireEvent.click(screen.getByRole("button", { name: /Reset floor for Upstairs/ }));
    expect(seen.at(-1)!.bathrooms!.find((b) => b.id === "b2")?.location).toBe(options[0]);
  });

  it("who uses it is a room dropdown on the bathroom card, and a room's own Bathroom row is only the access kind", async () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("bathrooms", (s) => seen.push(s));
    openCard("Upstairs");
    const who = screen.getByRole("button", { name: "Who uses Upstairs" });
    expect(who.textContent).toContain("No rooms yet");
    fireEvent.click(who);
    const roomA = screen.getByRole("option", { name: "Room A" });
    fireEvent.pointerDown(roomA, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(roomA, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(seen.at(-1)!.bathrooms!.find((b) => b.id === "b2")?.assignedRoomIds).toEqual(["r1"]);
    fireEvent.pointerDown(roomA, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(roomA, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(seen.at(-1)!.bathrooms!.find((b) => b.id === "b2")?.assignedRoomIds).toEqual([]);
    // Rooms step: the room card offers only the access kind.
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-rooms"]')!);
    openCard("Room A");
    expect(floorOptions("Bathroom access for Room A")).toEqual(["ensuite", "shared", "hall"]);
  });
});

describe("shared spaces as cards", () => {
  it("opens in place, and 'who may use it' reads Everyone unless narrowed", () => {
    open("spaces");
    expect(document.querySelectorAll('[data-attr="listing-v2-space-card"]').length).toBe(2);
    const summaries = [...document.querySelectorAll('[data-attr="listing-v2-space-card"]')].map((c) => c.textContent ?? "");
    expect(summaries[0]).toContain("Everyone");
    expect(summaries[1]).toContain("1 room");
    openCard("Kitchen");
    expect(document.querySelector('[data-attr="listing-v2-space-editor"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-space-done"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-space-card-remove"]')).not.toBeNull();
    const who = screen.getByRole("button", { name: "Who may use Kitchen" });
    expect(who.textContent).toContain("Everyone");
    fireEvent.click(who);
    const options = [...document.getElementById(who.getAttribute("aria-controls")!)!.querySelectorAll("[role='option']")];
    expect(options[0]?.getAttribute("data-field-select-option-value")).toBe(EVERYONE_ACCESS_VALUE);
    expect(options[0]?.textContent).toContain("Everyone");
    expect(options.map((option) => option.textContent ?? "")).toEqual(expect.arrayContaining([
      expect.stringContaining("Everyone"),
      expect.stringContaining("Room A"),
      expect.stringContaining("Room B"),
    ]));
  });

  it("Everyone in the menu writes empty access; unticking a room narrows", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("spaces", (s) => seen.push(s));
    openCard("Kitchen");
    const who = screen.getByRole("button", { name: "Who may use Kitchen" });
    fireEvent.click(who);
    const roomA = screen.getByRole("option", { name: "Room A" });
    fireEvent.pointerDown(roomA, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(roomA, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(seen.at(-1)!.sharedSpaces!.find((space) => space.id === "s1")?.roomAccessIds).toEqual(["r2"]);
    const everyone = screen.getByRole("option", { name: "Everyone" });
    fireEvent.pointerDown(everyone, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(everyone, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(seen.at(-1)!.sharedSpaces!.find((space) => space.id === "s1")?.roomAccessIds).toEqual([]);
  });

  it("has no Every shared space card, tick or Make-all button; a new space starts on the ground floor with Everyone and nothing else", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("spaces", (s) => seen.push(s));
    expect(screen.queryByRole("button", { name: "Floor for every shared space" })).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-space-defaults-card"]')).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-spaces-reset-all"]')).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-space-card"] [data-attr="listing-v2-space-same-as-all"]')).toBeNull();
    expect(screen.queryByText("Make all the same")).toBeNull();
    // A space's floor is picked on its own card and moves only that space.
    openCard("Kitchen");
    const options = floorOptions("Floor for Kitchen");
    expect(options.length).toBeGreaterThan(1);
    pickFloor("Floor for Kitchen", options[1]!);
    expect(seen.at(-1)!.sharedSpaces!.find((s) => s.id === "s1")?.location).toBe(options[1]);
    expect(seen.at(-1)!.sharedSpaces!.find((s) => s.id === "s2")?.location ?? "").toBe("");
    // Add: ground floor, Everyone, everything else blank; the legacy block is never written.
    fireEvent.click(screen.getByRole("button", { name: "Add shared space" }));
    const spaces = seen.at(-1)!.sharedSpaces!;
    expect(spaces.length).toBe(3);
    const added = spaces[2]!;
    expect(added.location).toBe(options[0]);
    expect(added.roomAccessIds).toEqual(encodeSharedSpaceEveryone());
    expect(added.name).toBe("");
    expect(added.detail).toBe("");
    expect(added.amenitiesText).toBe("");
    expect(added.photoDataUrls).toEqual([]);
    expect(added.videoDataUrl).toBeNull();
    expect(added.spaceKind).toBeUndefined();
    expect(seen.at(-1)!.sharedSpaceDefaults).toBeUndefined();
  });
});
