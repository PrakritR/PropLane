// @vitest-environment jsdom
//
// PLAN-0921-1648: a room and a bathroom are each their own card, the way a
// shared space already was (`listing-shared-spaces-no-default.test.ts`). The
// Rooms and Bathrooms steps of the v2 listing wizard draw no Default card, no
// per-field follow/reset, no "Make all the same" — "Same as Room X" /
// "Same as Bathroom X" is the one way a new record starts from another's
// description, and it is a one-time copy, never a standing link. This reads
// the source so the mechanism cannot quietly return, and drives the real UI
// to prove the picker copies a description and nothing else.
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { createDefaultListingSubmission, emptyBathroom, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

const EDITOR = join(process.cwd(), "src/components/portal/listing-wizard-v2/listing-editor.tsx");
const raw = readFileSync(EDITOR, "utf8");
// Comments explain the code to developers; the rule is about what renders.
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * RoomCardBody and StepRooms together. Bounded by function declarations, not
 * banner comments — the comment strip above would otherwise erase the banner
 * text used to find them.
 */
function roomsSource(): string {
  const start = code.indexOf("function RoomCardBody(");
  expect(start, "RoomCardBody is still there").toBeGreaterThan(-1);
  const end = code.indexOf("function BathroomCardBody(", start);
  expect(end, "BathroomCardBody is still there").toBeGreaterThan(-1);
  return code.slice(start, end);
}

/** BathroomCardBody and StepBathrooms together. */
function bathroomsSource(): string {
  const start = code.indexOf("function BathroomCardBody(");
  expect(start, "BathroomCardBody is still there").toBeGreaterThan(-1);
  const end = code.indexOf("function SharedSpaceCardBody(", start);
  expect(end, "SharedSpaceCardBody is still there").toBeGreaterThan(-1);
  return code.slice(start, end);
}

describe("the Rooms step has no Default card", () => {
  it("draws no All rooms / Default room card, tick, per-row Reset or Make-all button", () => {
    const step = roomsSource();
    for (const banned of [
      'title={`All ${noun}s`}',
      "Default room",
      "listing-v2-defaults-card",
      "listing-v2-defaults-editor",
      "listing-v2-defaults-more",
      "listing-v2-rooms-reset-all",
      "listing-v2-room-same-as-all",
      "SameAsAllToggle",
      "ResetAllInheritanceButton",
      "CellResetTag",
      "useOwnFields",
      "roomInheritsDefault",
      "applyHouseDefaultsToRooms",
    ]) {
      expect(step.includes(banned), `Rooms still uses ${banned}`).toBe(false);
    }
  });

  it("has a Same as row and starts a new room blank", () => {
    const step = roomsSource();
    expect(step.includes('label="Same as"')).toBe(true);
    expect(step.includes("sameAsOptions")).toBe(true);
    expect(step.includes("roomDescriptionMatches")).toBe(true);
    expect(step.includes("copyRoomDescriptionFrom")).toBe(true);
    // Add room builds the SAME blank the Basics bedroom count makes, so the two
    // paths cannot disagree on availability or utilities billing.
    expect(step.includes("...emptyRoom(rooms.length), id, name: \"\", occupancyCapacity: 1")).toBe(true);
  });
});

describe("the Bathrooms step has no Default card", () => {
  it("draws no Default bathroom card, tick, per-row Reset or Make-all button", () => {
    const step = bathroomsSource();
    for (const banned of [
      'title="Default bathroom"',
      "listing-v2-bath-defaults-card",
      "listing-v2-bath-defaults-editor",
      "listing-v2-bath-defaults-more",
      "listing-v2-bathrooms-reset-all",
      "listing-v2-bath-same-as-all",
      "SameAsAllToggle",
      "ResetAllInheritanceButton",
      "CellResetTag",
      "useOwnFields",
      "bathroomDefaultsForSubmission",
      "applyBathroomDefaults",
    ]) {
      expect(step.includes(banned), `Bathrooms still uses ${banned}`).toBe(false);
    }
  });

  it("has a Same as row and starts a new bathroom blank", () => {
    const step = bathroomsSource();
    expect(step.includes('label="Same as"')).toBe(true);
    expect(step.includes("sameAsOptions")).toBe(true);
    expect(step.includes("bathroomDescriptionMatches")).toBe(true);
    expect(step.includes("copyBathroomDescriptionFrom")).toBe(true);
    // A card "Add bathroom" makes is a full bath with no rooms, built from the
    // same `emptyBathroom` the count uses. Its floor is left BLANK — the card
    // shows the ground floor as a display default — so an untouched card stays
    // removable when the count comes back down.
    expect(step.includes('writeBathroomType({ ...emptyBathroom(baths.length), id, name: "" }, "full")')).toBe(true);
    expect(step.includes("location: groundFloor")).toBe(false);
  });
});

/* ─────────────────────────── live UI ─────────────────────────── */

afterEach(() => cleanup());

function seededRooms(): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    listingStoriesId: "2",
    rooms: [
      { ...base.rooms[0]!, id: "r1", name: "Room 1", floor: "2nd floor", furnishing: "furnished", availability: "occupied" },
      { ...base.rooms[0]!, id: "r2", name: "Room 2" },
    ],
    bathrooms: [
      { id: "b1", name: "Bathroom 1", toilet: true, sink: true, shower: false, bathtub: true, location: "2nd floor", amenitiesText: "Heated floor", assignedRoomIds: ["r1"], accessKindByRoomId: {} },
      { id: "b2", name: "Bathroom 2", toilet: true, sink: true, shower: true, bathtub: false, assignedRoomIds: [], accessKindByRoomId: {} },
    ] as never,
  };
}

// This file is plain .ts (no JSX): every element is built with
// React.createElement so esbuild's ts loader (no jsx parsing) can transform it.
function Editor({ initial, onChange }: { initial: ManagerListingSubmissionV1; onChange?: (sub: ManagerListingSubmissionV1) => void }) {
  const [sub, setSub] = useState(initial);
  return React.createElement(ListingEditorV2, {
    title: "New listing",
    submission: sub,
    onChange: (next: ManagerListingSubmissionV1) => {
      setSub(next);
      onChange?.(next);
    },
    onClose: () => {},
    onSaveExit: () => {},
    onPublish: () => {},
  });
}

function open(step: "rooms" | "bathrooms", initial: ManagerListingSubmissionV1, onChange?: (sub: ManagerListingSubmissionV1) => void) {
  render(React.createElement(Editor, { initial, onChange }));
  fireEvent.click(document.querySelector(`[data-attr="listing-v2-rail-${step}"]`)!);
}
const openCard = (label: string) => fireEvent.click(screen.getByRole("button", { name: `Open ${label}` }));
const pick = (label: string, value: string) => {
  const t = screen.getByRole("button", { name: label });
  if (t.getAttribute("aria-expanded") !== "true") fireEvent.click(t);
  const option = document.getElementById(t.getAttribute("aria-controls")!)!.querySelector(`[data-field-select-option-value="${value}"]`)!;
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
};

describe("Same as Room X — live", () => {
  it("picking Same as Room 1 on Room 2 fills its floor and furnishing, and leaves name and availability alone", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("rooms", seededRooms(), (s) => seen.push(s));
    openCard("Room 2");
    pick("Same as for Room 2", "r1");
    const room2 = seen.at(-1)!.rooms.find((r) => r.id === "r2")!;
    expect(room2.floor).toBe("2nd floor");
    expect(room2.furnishing).toBe("furnished");
    expect(room2.name).toBe("Room 2");
    expect(room2.availability).not.toBe("occupied");
  });

  it("Room 1 never offers itself in its own Same as list", () => {
    open("rooms", seededRooms());
    openCard("Room 1");
    const sameAs = screen.getByRole("button", { name: "Same as for Room 1" });
    fireEvent.click(sameAs);
    const list = document.getElementById(sameAs.getAttribute("aria-controls")!)!;
    expect(list.querySelector('[data-field-select-option-value="r1"]')).toBeNull();
    expect(list.querySelector('[data-field-select-option-value="r2"]')).not.toBeNull();
  });
});

describe("a new room's floor — live", () => {
  it("shows the listing's ground floor on the card without writing one", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("rooms", seededRooms(), (s) => seen.push(s));
    fireEvent.click(screen.getByRole("button", { name: "Add room" }));

    const added = seen.at(-1)!.rooms.at(-1)!;
    expect(added.floor).toBe("");

    const trigger = screen.getByRole("button", { name: "Floor for Room 3" });
    fireEvent.click(trigger);
    const options = [...document.getElementById(trigger.getAttribute("aria-controls")!)!.querySelectorAll("[data-field-select-option-value]")];
    const groundFloor = options[0]!.getAttribute("data-field-select-option-value")!;
    expect(trigger.textContent).toContain(groundFloor);
    expect(seen.at(-1)!.rooms.at(-1)!.floor).toBe("");
  });
});

describe("Same as Bathroom X — live", () => {
  it("picking Same as Bathroom 1 on Bathroom 2 fills its floor, type and finishes, and leaves Who uses it untouched", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("bathrooms", seededRooms(), (s) => seen.push(s));
    openCard("Bathroom 2");
    pick("Same as for Bathroom 2", "b1");
    const bathroom2 = seen.at(-1)!.bathrooms!.find((b) => b.id === "b2")!;
    expect(bathroom2.location).toBe("2nd floor");
    // Bathroom 1 is a full bath (tub + shower); the copy carries that fixture set.
    expect(bathroom2.bathtub).toBe(true);
    expect(bathroom2.shower).toBe(true);
    expect(bathroom2.amenitiesText).toBe("Heated floor");
    // Who uses it — assignedRoomIds — is untouched by the copy.
    expect(bathroom2.assignedRoomIds ?? []).toEqual([]);
    expect(bathroom2.name).toBe("Bathroom 2");
  });
});

describe("the bathroom count on Basics (PLAN-0921-1648)", () => {
  /**
   * A draft whose Basics count ran ahead of its cards — three bathrooms on the
   * count, one card on disk — which is the state that makes the count grow more
   * than one card at a time.
   */
  function staleBathCount(): ManagerListingSubmissionV1 {
    const base = createDefaultListingSubmission();
    return {
      ...base,
      listingStoriesId: "2",
      listingTotalBathroomsId: "3",
      bathrooms: [{ ...emptyBathroom(0), id: "b1", name: "Bathroom 1" }],
    };
  }

  it("makes cards with NO floor written, so lowering the count removes them again", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    render(React.createElement(Editor, { initial: staleBathCount(), onChange: (s: ManagerListingSubmissionV1) => seen.push(s) }));

    // 3 → 3.5 grows the cards the count is short of: two whole baths and a half.
    fireEvent.click(screen.getByRole("button", { name: "More bathrooms" }));
    const grown = seen.at(-1)!.bathrooms!;
    expect(grown.length).toBe(4);
    // Each card the count made is a full bath, and its floor is BLANK — the
    // card shows the ground floor as a display default and writes nothing. A
    // stamped floor made `isBathroomSlotRemovable` read the card as filled in
    // and wedged the count so it could never come back down.
    expect(grown[1]!.bathtub).toBe(true);
    expect(grown[1]!.shower).toBe(true);
    expect(grown.slice(1).map((b) => (b.location ?? "").trim())).toEqual(["", "", ""]);

    // 3.5 → 3 → 2.5 → 2: the untouched cards come off the end again.
    const fewer = () => fireEvent.click(screen.getByRole("button", { name: "Fewer bathrooms" }));
    fewer();
    fewer();
    fewer();
    expect(seen.at(-1)!.listingTotalBathroomsId).toBe("2");
    expect(seen.at(-1)!.bathrooms!.length).toBe(2);
  });
});
