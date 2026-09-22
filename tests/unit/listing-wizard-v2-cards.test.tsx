// @vitest-environment jsdom
//
// The listing editor's Rooms, Bathrooms, Shared spaces and Pricing steps are
// stacked cards at every width — nothing scrolls sideways on a 390px phone,
// and the website gets the same cards in its wider workspace. A card is a
// name, one summary line and a chevron; open, it unfolds its rows in place.
// Rooms and Bathrooms have no "Every …" card any more (PLAN-0921-1648): each
// record is its own, and "Same as Room X" / "Same as Bathroom X" — covered in
// tests/unit/listing-wizard-v2-rooms-all-rooms.test.tsx and
// tests/unit/listing-rooms-bathrooms-no-default.test.ts — is the one way a
// record starts from another's description. Pricing keeps its own Default
// room and "Same as default room" tick, unaffected by this file's rewrite.
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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

function open(step: "basics" | "rooms" | "bathrooms" | "spaces" | "pricing", initial = seeded(), onChange?: (sub: ManagerListingSubmissionV1) => void) {
  render(<Editor initial={initial} onChange={onChange} />);
  fireEvent.click(document.querySelector(`[data-attr="listing-v2-rail-${step}"]`)!);
}

const trigger = (label: string) => screen.getByRole("button", { name: label });
/** A pick closes its menu on a deferred tick, so a second pick on the same trigger must not toggle it shut. */
const pick = (label: string, value: string) => {
  const t = trigger(label);
  if (t.getAttribute("aria-expanded") !== "true") fireEvent.click(t);
  const option = document.getElementById(t.getAttribute("aria-controls")!)!.querySelector(`[data-field-select-option-value="${value}"]`)!;
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
};
const openCard = (label: string) => fireEvent.click(screen.getByRole("button", { name: `Open ${label}` }));
/** The labels of the rows a card shows, top to bottom. */
const rowLabels = (root: Element) =>
  [...root.querySelectorAll("[aria-label]")]
    .map((el) => el.getAttribute("aria-label") ?? "")
    .filter((l) => / for Room A$/.test(l) && !/^(Fewer|More) /.test(l))
    .map((l) => l.replace(/ for Room A$/, ""));

describe("rooms as cards", () => {
  it("has no sideways table: no Every-room card, each room is its own closed card", () => {
    open("rooms");
    expect(document.querySelector("main .overflow-x-auto")).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-room-row"]')).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-defaults-card"]')).toBeNull();
    // Closed room cards: a name, a summary, a chevron — no controls yet.
    const cards = document.querySelectorAll('[data-attr="listing-v2-room-card"]');
    expect(cards.length).toBe(2);
    expect(cards[0]!.textContent).toContain("1 resident");
    expect(document.querySelector('[data-attr="listing-v2-room-editor"]')).toBeNull();
    openCard("Room A");
    expect(document.querySelectorAll('[data-attr="listing-v2-room-editor"]').length).toBe(1);
    const editor = document.querySelector('[data-attr="listing-v2-room-editor"]')!;
    // "Same as" is the first row; only the important questions are otherwise on the card, everything else waits behind one More.
    expect(rowLabels(editor)).toEqual(["Same as", "Residents per room", "Floor"]);
    fireEvent.click(editor.querySelector('[data-attr="listing-v2-room-more"]')!);
    expect(rowLabels(editor)).toEqual(["Same as", "Residents per room", "Floor", "Furnishing", "Room amenities"]);
    // One closer: Done. No Duplicate, no Remove inside the card — ✕ sits in the header.
    expect(editor.querySelector('[data-attr="listing-v2-room-done"]')).not.toBeNull();
    expect([...editor.querySelectorAll("button")].map((b) => b.textContent?.trim())).not.toContain("Duplicate");
    // A named room is not a blank slot, so it has no ✕; a freshly added blank one does, in its header.
    expect(document.querySelector('[data-attr="listing-v2-room-card-remove"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-attr="listing-v2-add-room"]')!);
    expect(document.querySelector('[data-attr="listing-v2-room-card-remove"]')).not.toBeNull();
    // Only one card open at a time.
    openCard("Room B");
    expect(document.querySelectorAll('[data-attr="listing-v2-room-editor"]').length).toBe(1);
  });

  it("Furnished unfolds Beds and Included under the Furnishing row; Unfurnished hides them, and only this room is touched", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("rooms", seeded(), (s) => seen.push(s));
    openCard("Room A");
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-editor"] [data-attr="listing-v2-room-more"]')!);
    expect(screen.queryByRole("button", { name: "Included in Room A" })).toBeNull();
    pick("Furnishing for Room A", "furnished");
    expect(screen.getByRole("button", { name: "Included in Room A" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bed 1 type for Room A" })).toBeTruthy();
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r1")!.furnishing.trim().length).toBeGreaterThan(0);
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r2")!.furnishing).toBe("");
    pick("Furnishing for Room A", "unfurnished");
    expect(screen.queryByRole("button", { name: "Included in Room A" })).toBeNull();
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r1")!.furnishing).toBe("");
  });

  it("a room's Bathroom row is 'Add a bathroom first' with no bathrooms, and an access-kind pick once there is one", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("rooms", seeded(), (s) => seen.push(s));
    openCard("Room A");
    expect(document.querySelector('[data-attr="listing-v2-add-bathroom-first"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Bathroom access for Room A" })).toBeNull();
    fireEvent.click(document.querySelector('[data-attr="listing-v2-add-bathroom-first"]')!);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-add-bath"]')!);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-rooms"]')!);
    openCard("Room A");
    pick("Bathroom access for Room A", "hall");
    const bath = seen.at(-1)!.bathrooms![0]!;
    expect(bath.assignedRoomIds).toContain("r1");
    expect(bath.accessKindByRoomId?.r1).toBe("hall");
  });

  it("the whole place drops the per-room rows and asks residents once on Basics", () => {
    open("basics", seeded({ listingPlaceCategoryId: "entire_home", rentalModelStamp: "entire_home" }));
    expect(document.querySelector('[data-attr="listing-v2-residents"]')).not.toBeNull();
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-rooms"]')!);
    expect(screen.getByText("2 bedrooms")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Residents per room/ })).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-add-bathroom-first"]')).toBeNull();
    openCard("Room A");
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-editor"] [data-attr="listing-v2-room-more"]')!);
    expect(document.querySelector('[data-attr="listing-v2-room-set-in-pricing"]')).toBeNull();
  });

  it("a room's Rent row only points at Pricing", () => {
    open("rooms");
    openCard("Room A");
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-editor"] [data-attr="listing-v2-room-more"]')!);
    expect(document.querySelector('[data-attr="listing-v2-room-editor"]')!.textContent).not.toMatch(/\$\d/);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-set-in-pricing"]')!);
    expect(screen.getByText("Pricing", { selector: "h2" })).toBeTruthy();
  });
});

describe("a room is its own — editing one never reaches another (PLAN-0921-1648)", () => {
  it("a room's own floor and checklist stay put when a different room's fields change", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("rooms", seeded(), (s) => seen.push(s));
    openCard("Room B");
    pick("Floor for Room B", "2nd floor");
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r2")!.floor).toBe("2nd floor");
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r1")!.floor).toBe("");
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-editor"] [data-attr="listing-v2-room-more"]')!);
    fireEvent.click(within(document.querySelector('[data-attr="listing-v2-room-editor"]') as HTMLElement).getByLabelText("Move-in checklist required"));
    const rooms = seen.at(-1)!.rooms;
    expect(rooms.find((r) => r.id === "r2")!.moveInInspectionRequired).toBe(true);
    expect(rooms.find((r) => r.id === "r1")!.moveInInspectionRequired).toBeFalsy();
    expect(rooms.find((r) => r.id === "r2")!.floor).toBe("2nd floor");
    // Rooms have no Default card of their own, so nothing is saved to houseDefaults from here.
    expect(seen.at(-1)!.houseDefaults?.moveInInspectionRequired).toBeUndefined();
    // No per-field Reset tags left — every value is the room's own, full stop.
    expect(document.querySelectorAll('[data-attr="listing-v2-cell-reset"]').length).toBe(0);
  });

  it("the size box shows what is typed and commits on blur; an emptied box clears to unset, not to another room's value", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("rooms", seeded(), (s) => seen.push(s));
    openCard("Room A");
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-editor"] [data-attr="listing-v2-room-more"]')!);
    const sizeA = screen.getByLabelText("Size of Room A") as HTMLInputElement;
    expect(sizeA.placeholder).toBe("—");
    fireEvent.focus(sizeA);
    fireEvent.change(sizeA, { target: { value: "185" } });
    expect(sizeA.value).toBe("185");
    fireEvent.blur(sizeA);
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r1")!.sizeSqft).toBe(185);
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r2")!.sizeSqft ?? 0).toBe(0);
    fireEvent.focus(sizeA);
    fireEvent.change(sizeA, { target: { value: "" } });
    fireEvent.blur(sizeA);
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r1")!.sizeSqft).toBeUndefined();
  });

  it("a room's own photos stay its own — changing them never reaches another room", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    const base = seeded();
    open(
      "rooms",
      {
        ...base,
        rooms: [
          { ...base.rooms[0]!, photoDataUrls: ["h1", "h2"] },
          { ...base.rooms[1]!, photoDataUrls: ["own"] },
        ],
      },
      (s) => seen.push(s),
    );
    openCard("Room A");
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-editor"] [data-attr="listing-v2-room-more"]')!);
    const editor = within(document.querySelector('[data-attr="listing-v2-room-editor"]') as HTMLElement);
    fireEvent.click(editor.getByRole("button", { name: "Remove room photo 1" }));
    const rooms = seen.at(-1)!.rooms;
    expect(rooms.find((r) => r.id === "r1")!.photoDataUrls).toEqual(["h2"]);
    expect(rooms.find((r) => r.id === "r2")!.photoDataUrls).toEqual(["own"]);
  });
});

describe("basics counts", () => {
  it("bathrooms and floors are steppers; bathrooms count in halves", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("basics", seeded({ listingTotalBathroomsId: "1", listingStoriesId: "1" }), (s) => seen.push(s));
    fireEvent.click(screen.getByRole("button", { name: "More bathrooms" }));
    expect(seen.at(-1)!.listingTotalBathroomsId).toBe("1.5");
    fireEvent.click(screen.getByRole("button", { name: "More floors" }));
    expect(seen.at(-1)!.listingStoriesId).toBe("2");
    expect(document.querySelector("select")).toBeNull();
  });
});

describe("pricing as cards", () => {
  it("bundles: pick rooms, one rent, one deposit; the saving against separate rents is stated", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open(
      "pricing",
      seeded({
        allowedLeaseTerms: ["Long-term"],
        rooms: [
          { ...createDefaultListingSubmission().rooms[0]!, id: "r1", name: "Room A", monthlyRent: 1100 },
          { ...createDefaultListingSubmission().rooms[0]!, id: "r2", name: "Room B", monthlyRent: 1100 },
        ],
      }),
      (s) => seen.push(s),
    );
    fireEvent.click(document.querySelector('[data-attr="listing-v2-add-bundle"]')!);
    expect(seen.at(-1)!.bundles.length).toBe(1);
    const card = document.querySelector('[data-attr="listing-v2-bundle-card"]')!;
    expect(card.textContent).toContain("Pick rooms");
    // Rooms in the bundle is a multi-pick.
    const rooms = screen.getByRole("button", { name: /Rooms in Bundle 1/ });
    fireEvent.click(rooms);
    const list = document.getElementById(rooms.getAttribute("aria-controls")!)!;
    for (const value of ["Room A", "Room B"]) {
      const option = list.querySelector(`[data-field-select-option-value="${value}"]`)!;
      fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
    }
    fireEvent.change(screen.getByLabelText("Bundle 1 rent"), { target: { value: "2000" } });
    const bundle = seen.at(-1)!.bundles[0]!;
    expect(bundle.includedRoomIds).toEqual(["r1", "r2"]);
    expect(bundle.price).toBe("2000");
    expect(document.querySelector('[data-attr="listing-v2-bundle-card"]')!.textContent).toContain("saves $200");
  });

  it("short-term asks for rent per night and per week only", () => {
    open("pricing", seeded({ allowedLeaseTerms: ["Long-term"], shortTermRentalsAllowed: true }));
    fireEvent.click(document.querySelector('[data-attr="listing-v2-price-tab-Short-Term Stay"]')!);
    expect(screen.getByLabelText("Rent per night for every room")).toBeTruthy();
    expect(screen.getByLabelText("Rent per week for every room")).toBeTruthy();
    expect(screen.queryByLabelText(/Deposit for a stay/)).toBeNull();
    expect(screen.queryByLabelText(/Utilities for every room/)).toBeNull();
  });

  it("the whole place prices once, with no room cards and no bundles", () => {
    open("pricing", seeded({ listingPlaceCategoryId: "entire_home", rentalModelStamp: "entire_home", allowedLeaseTerms: ["Long-term"] }));
    expect(document.querySelector('[data-attr="listing-v2-whole-place-card"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-price-card"]')).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-add-bundle"]')).toBeNull();
  });
});

describe("a house-wide fee on a room card", () => {
  const twoRooms = () =>
    seeded({
      allowedLeaseTerms: ["Long-term"],
      rooms: [
        { ...createDefaultListingSubmission().rooms[0]!, id: "r8", name: "Room 8", monthlyRent: 1100 },
        { ...createDefaultListingSubmission().rooms[0]!, id: "r9", name: "Room 9", monthlyRent: 1100 },
      ],
    });
  /** A $60 monthly Parking fee added on the Default card, the way a manager adds one. */
  const addParking = () => {
    fireEvent.click(document.querySelector('[data-attr="listing-v2-default-fee-add"]')!);
    fireEvent.change(screen.getByLabelText("Fee name"), { target: { value: "Parking" } });
    fireEvent.change(screen.getByLabelText("Parking amount"), { target: { value: "60" } });
  };
  const parking = (sub: ManagerListingSubmissionV1) => sub.customFees.find((f) => (f as { presetId?: string }).presetId === "parking_monthly");
  // A custom row named exactly "Parking" is read back as the parking preset, so the room's copy carries the room's name.
  const roomOnly = (sub: ManagerListingSubmissionV1) => sub.customFees.filter((f) => (f as { presetId?: string }).presetId === "custom" && f.label === "Parking – Room 9");

  it("shows as an inherited row, and ✕ takes only that room out of it", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("pricing", twoRooms(), (s) => seen.push(s));
    addParking();
    expect(parking(seen.at(-1)!)?.roomIds).toBeUndefined();
    openCard("Room 9 prices");
    const row = screen.getByLabelText("Parking amount for Room 9") as HTMLInputElement;
    expect(row.value).toBe("");
    expect(row.placeholder).toBe("60");
    expect(row.className).toContain("border-dashed");
    expect(document.querySelector('[data-attr="listing-v2-fee-row"][data-inherited="true"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove Parking for Room 9" }));
    // Room 8 still pays it; Room 9 no longer does, and the Default card's fee is not gone.
    expect(parking(seen.at(-1)!)?.roomIds).toEqual(["r8"]);
    expect(parking(seen.at(-1)!)?.amount).toBe("60");
    expect(screen.queryByLabelText("Parking amount for Room 9")).toBeNull();
  });

  it("typing an amount splits a room-only copy off the shared fee; Reset folds it back in", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("pricing", twoRooms(), (s) => seen.push(s));
    addParking();
    openCard("Room 9 prices");
    fireEvent.change(screen.getByLabelText("Parking amount for Room 9"), { target: { value: "75" } });
    let own = roomOnly(seen.at(-1)!);
    expect(own).toHaveLength(1);
    expect(own[0]!.amount).toBe("75");
    expect(own[0]!.roomIds).toEqual(["r9"]);
    expect(own[0]!.frequency).toBe("monthly");
    expect(parking(seen.at(-1)!)?.roomIds).toEqual(["r8"]);
    expect(parking(seen.at(-1)!)?.amount).toBe("60");
    // The row is Room 9's own now: the amount stays under the caret and Reset is offered.
    const ownBox = screen.getByLabelText("Parking – Room 9 amount for Room 9") as HTMLInputElement;
    expect(ownBox.value).toBe("75");
    // Clicking Reset blurs the box first, the way a pointer does.
    fireEvent.blur(ownBox);
    fireEvent.click(screen.getByRole("button", { name: "Reset Parking – Room 9 for Room 9 to every room" }));
    own = roomOnly(seen.at(-1)!);
    expect(own).toHaveLength(0);
    expect(parking(seen.at(-1)!)?.roomIds).toBeUndefined();
    expect((screen.getByLabelText("Parking amount for Room 9") as HTMLInputElement).value).toBe("");
  });
});
