// @vitest-environment jsdom
//
// Room amenities shrank to the basics. A label that is no longer a preset is
// not lost: the pick keeps it as a ticked option and the stored text keeps it.
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { BATHROOM_EXTRA_AMENITY_PRESETS, ROOM_AMENITY_PRESETS } from "@/data/manager-listing-presets";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

afterEach(() => cleanup());

const REMOVED = "Soundproofed walls";

function seeded(): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    rooms: [{ ...base.rooms[0]!, id: "r1", name: "Room A", roomAmenitiesText: `Closet\n${REMOVED}` }],
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

describe("amenity presets: basics only, nothing lost", () => {
  it("offers only the basic presets", () => {
    expect(ROOM_AMENITY_PRESETS.length).toBe(10);
    expect(ROOM_AMENITY_PRESETS.map((p) => p.label)).not.toContain(REMOVED);
    expect(BATHROOM_EXTRA_AMENITY_PRESETS.length).toBe(8);
  });

  it("a label that is no longer a preset stays ticked on the room and survives a change", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    render(<Editor onChange={(s) => seen.push(s)} />);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-rooms"]')!);
    fireEvent.click(screen.getByRole("button", { name: "Open Room A" }));
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-editor"] [data-attr="listing-v2-room-more"]')!);
    const pick = screen.getByRole("button", { name: "Room amenities for Room A" });
    expect(pick.textContent).toContain(REMOVED);
    // Tick a preset: the custom line rides along.
    fireEvent.click(pick);
    const option = document.getElementById(pick.getAttribute("aria-controls")!)!.querySelector('[data-field-select-option-value="Heating"]')!;
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(seen.at(-1)!.rooms[0]!.roomAmenitiesText).toBe(`Heating\nCloset\n${REMOVED}`);
  });
});
