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

const floorSelect = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;
/** Render the editor and walk the rail to one step, the way a manager does. */
function open(step: "bathrooms" | "spaces", onChange?: (sub: ManagerListingSubmissionV1) => void) {
  render(<Editor onChange={onChange} />);
  fireEvent.click(document.querySelector(`[data-attr="listing-v2-rail-${step}"]`)!);
}

describe("bathrooms on the rooms grid", () => {
  it("has no Details buttons and no row checkboxes — a chevron opens the row in place", () => {
    open("bathrooms");
    expect(document.querySelectorAll('[data-attr="listing-v2-bath-row"]').length).toBe(2);
    expect(document.querySelector('[data-attr="listing-v2-bath-details"]')).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-bath-row"] input[type="checkbox"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-attr="listing-v2-bath-open"]')!);
    expect(document.querySelector('[data-attr="listing-v2-bath-editor"]')).not.toBeNull();
    expect(screen.getByText("Remove bathroom")).toBeTruthy();
  });

  it("the Every bathroom row moves followers and leaves a bathroom's own value alone", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("bathrooms", (s) => seen.push(s));
    const options = [...floorSelect("Floor for every bathroom").options].map((o) => o.value).filter(Boolean);
    expect(options.length).toBeGreaterThan(1);
    // Upstairs takes its own floor first.
    fireEvent.change(floorSelect("Floor for Upstairs"), { target: { value: options[1] } });
    // Then the house says every bathroom is on options[0].
    fireEvent.change(floorSelect("Floor for every bathroom"), { target: { value: options[0] } });
    const baths = seen.at(-1)!.bathrooms!;
    expect(baths.find((b) => b.id === "b1")?.location).toBe(options[0]);
    expect(baths.find((b) => b.id === "b2")?.location).toBe(options[1]);
    // Reset puts Upstairs back on the house.
    fireEvent.click(document.querySelectorAll('[data-attr="listing-v2-bath-open"]')[1]!);
    const editor = document.querySelector('[data-attr="listing-v2-bath-editor"]')!;
    expect(editor.textContent).toContain("This bathroom");
    fireEvent.click([...editor.querySelectorAll("button")].find((b) => b.textContent === "Reset")!);
    expect(seen.at(-1)!.bathrooms!.find((b) => b.id === "b2")?.location).toBe(options[0]);
  });
});

describe("shared spaces on the rooms grid", () => {
  it("opens in place, and 'who may use it' reads Everyone unless narrowed", () => {
    open("spaces");
    expect(document.querySelectorAll('[data-attr="listing-v2-space-row"]').length).toBe(2);
    expect(document.querySelector('[data-attr="listing-v2-space-details"]')).toBeNull();
    expect(screen.getByLabelText("Who may use Kitchen").textContent).toBe("Everyone");
    expect(screen.getByLabelText("Who may use Den").textContent).toBe("1 room");
    fireEvent.click(document.querySelector('[data-attr="listing-v2-space-open"]')!);
    expect(document.querySelector('[data-attr="listing-v2-space-editor"]')).not.toBeNull();
    expect(screen.getByText("Remove shared space")).toBeTruthy();
  });

  it("the Every shared space floor moves every space still following it", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("spaces", (s) => seen.push(s));
    const options = [...floorSelect("Floor for every shared space").options].map((o) => o.value).filter(Boolean);
    fireEvent.change(floorSelect("Floor for every shared space"), { target: { value: options[0] } });
    expect(seen.at(-1)!.sharedSpaces!.map((s) => s.location)).toEqual([options[0], options[0]]);
  });
});
