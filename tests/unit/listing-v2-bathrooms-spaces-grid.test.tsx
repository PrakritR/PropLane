// @vitest-environment jsdom
//
// Bathrooms and shared spaces are the rooms grid in different clothes: an
// "All …" panel the records follow, a "Same as all …" box under each name,
// More ▾ that opens a row in place, and per-field follow/own marking. No
// Details buttons.
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
  fireEvent.click(trigger);
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
/** Render the editor and walk the rail to one step, the way a manager does. */
function open(step: "bathrooms" | "spaces", onChange?: (sub: ManagerListingSubmissionV1) => void) {
  render(<Editor onChange={onChange} />);
  fireEvent.click(document.querySelector(`[data-attr="listing-v2-rail-${step}"]`)!);
}

describe("bathrooms on the rooms grid", () => {
  it("has no Details buttons; the Same-as-all box sits under the name and More opens the row in place", () => {
    open("bathrooms");
    expect(document.querySelectorAll('[data-attr="listing-v2-bath-row"]').length).toBe(2);
    expect(document.querySelector('[data-attr="listing-v2-bath-details"]')).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-bath-row"] [data-attr="listing-v2-bath-same-as-all"]')).not.toBeNull();
    fireEvent.click(document.querySelector('[data-attr="listing-v2-bath-open"]')!);
    expect(document.querySelector('[data-attr="listing-v2-bath-editor"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-bath-done"]')).not.toBeNull();
    expect(screen.queryByText("Remove bathroom")).toBeNull();
  });

  it("the Every bathroom row moves followers and leaves a bathroom's own value alone", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("bathrooms", (s) => seen.push(s));
    const options = floorOptions("Floor for every bathroom");
    expect(options.length).toBeGreaterThan(1);
    // Upstairs takes its own floor first.
    pickFloor("Floor for Upstairs", options[1]!);
    // Then the house says every bathroom is on options[0].
    pickFloor("Floor for every bathroom", options[0]!);
    const baths = seen.at(-1)!.bathrooms!;
    expect(baths.find((b) => b.id === "b1")?.location).toBe(options[0]);
    expect(baths.find((b) => b.id === "b2")?.location).toBe(options[1]);
    // Reset puts Upstairs back on the house.
    fireEvent.click(document.querySelectorAll('[data-attr="listing-v2-bath-open"]')[1]!);
    const editor = document.querySelector('[data-attr="listing-v2-bath-editor"]')!;
    expect(editor.textContent).toContain("This bathroom");
    fireEvent.click([...editor.querySelectorAll("button")].find((b) => /Reset/.test(b.textContent ?? ""))!);
    expect(seen.at(-1)!.bathrooms!.find((b) => b.id === "b2")?.location).toBe(options[0]);
  });
});

describe("shared spaces on the rooms grid", () => {
  it("opens in place, and 'who may use it' reads Everyone unless narrowed", () => {
    open("spaces");
    expect(document.querySelectorAll('[data-attr="listing-v2-space-row"]').length).toBe(2);
    expect(document.querySelector('[data-attr="listing-v2-space-details"]')).toBeNull();
    expect(screen.getByLabelText("Who may use Kitchen").textContent).toContain("Everyone");
    expect(screen.getByLabelText("Who may use Den").textContent).toContain("1 room");
    fireEvent.click(document.querySelector('[data-attr="listing-v2-space-open"]')!);
    expect(document.querySelector('[data-attr="listing-v2-space-editor"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-space-done"]')).not.toBeNull();
    expect(screen.queryByText("Remove shared space")).toBeNull();
  });

  it("the Every shared space floor moves every space still following it", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("spaces", (s) => seen.push(s));
    const options = floorOptions("Floor for every shared space");
    pickFloor("Floor for every shared space", options[0]!);
    expect(seen.at(-1)!.sharedSpaces!.map((s) => s.location)).toEqual([options[0], options[0]]);
  });
});
