// @vitest-environment jsdom
//
// Reset is per entry, not per row: a grid cell that holds its own value (ink
// with a dot) carries a ↺ that puts THAT field back on the "Every …" row and
// leaves the rest of the row alone. A cell that already follows the top row
// shows no ↺.
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

describe("per-cell ↺ on the listing grids", () => {
  it("rooms: a following cell has no ↺; an own cell does, and it resets only that field", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("rooms", (s) => seen.push(s));
    expect(screen.queryByRole("button", { name: /Reset residents for Room A/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reset floor for Room A/ })).toBeNull();

    pick("Residents per room for Room A", "3");
    const floors = optionValues("Floor for every room");
    pick("Floor for every room", floors[0]!);
    pick("Floor for Room A", floors[1] ?? floors[0]!);

    expect(screen.getByRole("button", { name: /Reset residents for Room A/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Reset residents for Room A/ }));

    const roomA = seen.at(-1)!.rooms.find((r) => r.id === "r1")!;
    // Back on the house's 1 resident, and the cell reads as following again.
    expect(roomA.occupancyCapacity ?? 1).toBe(1);
    expect(trigger("Residents per room for Room A").textContent).toContain("1");
    expect(trigger("Residents per room for Room A").className).toContain("border-dashed");
    // The floor Room A chose for itself survives the residents reset.
    if (floors.length > 1) {
      expect(roomA.floor).toBe(floors[1]);
      expect(screen.getByRole("button", { name: /Reset floor for Room A/ })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: /Reset residents for Room A/ })).toBeNull();
  });

  it("bathrooms: ↺ on Type puts that one bathroom's type back on every bathroom", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("bathrooms", (s) => seen.push(s));
    // Type is derived: full = bathtub, shower = shower only, half = neither.
    const typeOf = (id: string) => {
      const b = seen.at(-1)!.bathrooms!.find((x) => x.id === id)!;
      return b.bathtub ? "full" : b.shower ? "shower" : "half";
    };
    pick("Type of every bathroom", "full");
    pick("Type of Upstairs", "half");
    expect(typeOf("b1")).toBe("half");

    fireEvent.click(screen.getByRole("button", { name: /Reset type of Upstairs/ }));
    expect(typeOf("b1")).toBe("full");
    expect(typeOf("b2")).toBe("full");
    expect(screen.queryByRole("button", { name: /Reset type of Upstairs/ })).toBeNull();
  });

  it("shared spaces: ↺ on Floor puts that one space back on every shared space", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("spaces", (s) => seen.push(s));
    const floors = optionValues("Floor for every shared space");
    pick("Floor for every shared space", floors[0]!);
    pick("Floor for Den", floors[1] ?? floors[0]!);
    if (floors.length > 1) {
      expect(seen.at(-1)!.sharedSpaces!.find((s) => s.id === "s2")?.location).toBe(floors[1]);
      fireEvent.click(screen.getByRole("button", { name: /Reset floor for Den/ }));
      expect(seen.at(-1)!.sharedSpaces!.find((s) => s.id === "s2")?.location).toBe(floors[0]);
      expect(screen.queryByRole("button", { name: /Reset floor for Den/ })).toBeNull();
    }
  });
});
