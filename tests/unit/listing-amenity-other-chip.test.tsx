// @vitest-environment jsdom
//
// Amenity lists shrank to the basics, and "Other" became a chip that reveals a
// box. Two things must stay true: a label that is no longer a preset is not
// lost — it shows up in the Other box — and the chip hides the box until it is
// ticked, so a room with nothing custom shows nothing extra.
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { ROOM_AMENITY_PRESETS } from "@/data/manager-listing-presets";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

afterEach(() => cleanup());

const REMOVED = "Soundproofed walls";

function seeded(): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    rooms: [
      { ...base.rooms[0]!, id: "r1", name: "Room A", roomAmenitiesText: `Closet\n${REMOVED}` },
      { ...base.rooms[0]!, id: "r2", name: "Room B", roomAmenitiesText: "Closet" },
    ],
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

function openRoom(index: number, onChange?: (sub: ManagerListingSubmissionV1) => void) {
  render(<Editor onChange={onChange} />);
  fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-rooms"]')!);
  fireEvent.click(document.querySelectorAll('[data-attr="listing-v2-room-more"]')[index]!);
  return document.querySelector('[data-attr="listing-v2-room-editor"]')!;
}

describe("room amenities: basics + Other", () => {
  it("offers only the basic presets", () => {
    expect(ROOM_AMENITY_PRESETS.length).toBe(10);
    expect(ROOM_AMENITY_PRESETS.map((p) => p.label)).not.toContain(REMOVED);
  });

  it("a label that is no longer a preset shows in the Other box and survives a save", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    const editor = openRoom(0, (s) => seen.push(s));
    const other = editor.querySelector<HTMLTextAreaElement>('[data-attr="amenity-other"]');
    expect(other, "the Other box").toBeTruthy();
    expect(other!.value).toBe(REMOVED);
    const chip = screen.getByLabelText("Other") as HTMLInputElement;
    expect(chip.checked).toBe(true);

    // Ticking a preset keeps the custom line.
    fireEvent.click(screen.getByLabelText("Heating"));
    expect(seen.at(-1)!.rooms[0]!.roomAmenitiesText).toBe(`Heating\nCloset\n${REMOVED}`);
  });

  it("hides the box until Other is ticked, and clears it when Other is unticked", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    const editor = openRoom(1, (s) => seen.push(s));
    expect(editor.querySelector('[data-attr="amenity-other"]')).toBeNull();
    fireEvent.click(screen.getByLabelText("Other"));
    const box = document.querySelector<HTMLTextAreaElement>('[data-attr="amenity-other"]');
    expect(box, "the Other box after ticking").toBeTruthy();
    fireEvent.change(box!, { target: { value: "Reading nook" } });
    expect(seen.at(-1)!.rooms[1]!.roomAmenitiesText).toBe("Closet\nReading nook");
    fireEvent.click(screen.getByLabelText("Other"));
    expect(document.querySelector('[data-attr="amenity-other"]')).toBeNull();
    expect(seen.at(-1)!.rooms[1]!.roomAmenitiesText).toBe("Closet");
  });
});
