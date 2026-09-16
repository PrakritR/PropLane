// @vitest-environment jsdom
//
// The listing editor's Rooms, Bathrooms, Shared spaces and Pricing steps are
// stacked cards at every width — nothing scrolls sideways on a 390px phone,
// and the website gets the same cards in its wider workspace. A card is a
// name, one summary line and a chevron; open, it unfolds its rows in place.
// "Every room" holds the defaults with its rows always visible.
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
    .filter((l) => / for (every room|Room A)$/.test(l) && !/^(Fewer|More) /.test(l))
    .map((l) => l.replace(/ for (every room|Room A)$/, ""));

describe("rooms as cards", () => {
  it("has no sideways table: the Default room card shows only the important rows, each room is a closed card", () => {
    open("rooms");
    expect(document.querySelector("main .overflow-x-auto")).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-room-row"]')).toBeNull();
    const every = document.querySelector('[data-attr="listing-v2-defaults-card"]')!;
    expect(every.textContent).toContain("Default room");
    // Only the important questions are on the card; everything else waits behind one More.
    expect(rowLabels(every)).toEqual(["Residents per room", "Floor"]);
    fireEvent.click(every.querySelector('[data-attr="listing-v2-defaults-more"]')!);
    expect(rowLabels(every)).toEqual(["Residents per room", "Floor", "Furnishing", "Room amenities"]);
    // Closed room cards: a name, a summary, a chevron — no controls yet.
    const cards = document.querySelectorAll('[data-attr="listing-v2-room-card"]');
    expect(cards.length).toBe(2);
    expect(cards[0]!.textContent).toContain("1 resident");
    expect(document.querySelector('[data-attr="listing-v2-room-editor"]')).toBeNull();
    openCard("Room A");
    expect(document.querySelectorAll('[data-attr="listing-v2-room-editor"]').length).toBe(1);
    const editor = document.querySelector('[data-attr="listing-v2-room-editor"]')!;
    expect(rowLabels(editor)).toEqual(["Residents per room", "Floor"]);
    fireEvent.click(editor.querySelector('[data-attr="listing-v2-room-more"]')!);
    expect(rowLabels(editor)).toEqual(["Residents per room", "Floor", "Furnishing", "Room amenities"]);
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

  it("Furnished unfolds Beds and Included under the Furnishing row; Unfurnished hides them", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("rooms", seeded(), (s) => seen.push(s));
    fireEvent.click(document.querySelector('[data-attr="listing-v2-defaults-more"]')!);
    expect(screen.queryByRole("button", { name: "Included in every room" })).toBeNull();
    pick("Furnishing for every room", "furnished");
    expect(screen.getByRole("button", { name: "Included in every room" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bed 1 type for every room" })).toBeTruthy();
    // Every room that still follows the house is furnished too.
    expect(seen.at(-1)!.rooms.every((r) => r.furnishing.trim().length > 0)).toBe(true);
    pick("Furnishing for every room", "unfurnished");
    expect(screen.queryByRole("button", { name: "Included in every room" })).toBeNull();
    expect(seen.at(-1)!.rooms.every((r) => r.furnishing === "")).toBe(true);
  });

  it("a room's Bathroom row is 'Add a bathroom first' with no bathrooms, and an access-kind pick once there is one", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("rooms", seeded(), (s) => seen.push(s));
    expect(document.querySelector('[data-attr="listing-v2-add-bathroom-first"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Bathroom access for every room" })).toBeNull();
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

describe("a room follows the Default room field by field", () => {
  it("a room on its own floor still takes the Default room's checklist — only the floor is its own", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("rooms", seeded(), (s) => seen.push(s));
    openCard("Room B");
    pick("Floor for Room B", "2nd floor");
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r2")!.floor).toBe("2nd floor");
    const every = document.querySelector('[data-attr="listing-v2-defaults-card"]')!;
    fireEvent.click(every.querySelector('[data-attr="listing-v2-defaults-more"]')!);
    fireEvent.click(within(every as HTMLElement).getByLabelText("Move-in checklist required"));
    const rooms = seen.at(-1)!.rooms;
    expect(rooms.find((r) => r.id === "r1")!.moveInInspectionRequired).toBe(true);
    expect(rooms.find((r) => r.id === "r2")!.moveInInspectionRequired).toBe(true);
    expect(rooms.find((r) => r.id === "r2")!.floor).toBe("2nd floor");
    // The Default room is saved with the listing.
    expect(seen.at(-1)!.houseDefaults?.moveInInspectionRequired).toBe(true);
    // Only the floor carries a Reset on Room B; Reset puts it back and the box ticks again.
    const editor = document.querySelector('[data-attr="listing-v2-room-editor"]')!;
    expect([...editor.querySelectorAll('[data-attr="listing-v2-cell-reset"]')].map((b) => b.getAttribute("aria-label"))).toEqual(["Reset floor for Room B to the Default room"]);
    const boxes = () => [...document.querySelectorAll<HTMLInputElement>('[data-attr="listing-v2-room-same-as-all"]')];
    expect(boxes().map((b) => b.checked)).toEqual([true, false]);
    fireEvent.click(screen.getByRole("button", { name: "Reset floor for Room B to the Default room" }));
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r2")!.floor).toBe("");
    expect(boxes().map((b) => b.checked)).toEqual([true, true]);
  });

  it("the size box shows what is typed, commits on blur, and an emptied box goes back to the Default room", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("rooms", seeded(), (s) => seen.push(s));
    fireEvent.click(document.querySelector('[data-attr="listing-v2-defaults-more"]')!);
    const sizeEvery = screen.getByLabelText("Size of every room") as HTMLInputElement;
    expect(sizeEvery.placeholder).toBe("—");
    fireEvent.focus(sizeEvery);
    fireEvent.change(sizeEvery, { target: { value: "220" } });
    fireEvent.blur(sizeEvery);
    expect(seen.at(-1)!.rooms.every((r) => r.sizeSqft === 220)).toBe(true);
    openCard("Room A");
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-editor"] [data-attr="listing-v2-room-more"]')!);
    const sizeA = screen.getByLabelText("Size of Room A") as HTMLInputElement;
    expect(sizeA.value).toBe("220");
    fireEvent.focus(sizeA);
    fireEvent.change(sizeA, { target: { value: "185" } });
    expect(sizeA.value).toBe("185");
    fireEvent.blur(sizeA);
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r1")!.sizeSqft).toBe(185);
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r2")!.sizeSqft).toBe(220);
    expect(screen.getByRole("button", { name: "Reset size for Room A to the Default room" })).toBeTruthy();
    fireEvent.focus(sizeA);
    fireEvent.change(sizeA, { target: { value: "" } });
    fireEvent.blur(sizeA);
    expect(seen.at(-1)!.rooms.find((r) => r.id === "r1")!.sizeSqft).toBe(220);
    expect(screen.queryByRole("button", { name: "Reset size for Room A to the Default room" })).toBeNull();
  });

  it("Default room photos reach every following room, never a room with its own, and Reset copies them back", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    const base = seeded();
    open(
      "rooms",
      {
        ...base,
        houseDefaults: { photoDataUrls: ["h1", "h2"] },
        rooms: [
          { ...base.rooms[0]!, photoDataUrls: ["h1", "h2"] },
          { ...base.rooms[1]!, photoDataUrls: ["own"] },
        ],
      },
      (s) => seen.push(s),
    );
    const every = document.querySelector('[data-attr="listing-v2-defaults-card"]') as HTMLElement;
    fireEvent.click(every.querySelector('[data-attr="listing-v2-defaults-more"]')!);
    expect(within(every).getAllByRole("button", { name: /^Remove every room photo/ }).length).toBe(2);
    openCard("Room B");
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-editor"] [data-attr="listing-v2-room-more"]')!);
    expect(screen.getByRole("button", { name: "Reset photos for Room B to the Default room" })).toBeTruthy();
    fireEvent.click(within(every).getByRole("button", { name: "Remove every room photo 1" }));
    let rooms = seen.at(-1)!.rooms;
    expect(rooms.find((r) => r.id === "r1")!.photoDataUrls).toEqual(["h2"]);
    expect(rooms.find((r) => r.id === "r2")!.photoDataUrls).toEqual(["own"]);
    expect(seen.at(-1)!.houseDefaults?.photoDataUrls).toEqual(["h2"]);
    fireEvent.click(screen.getByRole("button", { name: "Reset photos for Room B to the Default room" }));
    rooms = seen.at(-1)!.rooms;
    expect(rooms.find((r) => r.id === "r2")!.photoDataUrls).toEqual(["h2"]);
  });
});

describe("Same as default room", () => {
  it("starts ticked, unticks when a value changes, and Reset copies the Default room back", () => {
    open("rooms");
    const boxes = () => [...document.querySelectorAll<HTMLInputElement>('[data-attr="listing-v2-room-same-as-all"]')];
    expect(boxes().map((b) => b.checked)).toEqual([true, true]);
    openCard("Room A");
    fireEvent.click(screen.getByRole("button", { name: "More Residents per room for Room A" }));
    expect(boxes()[0]!.checked).toBe(false);
    expect(boxes()[1]!.checked).toBe(true);
    expect(document.querySelector('[data-attr="listing-v2-room-card"]')!.textContent).toContain("This room only");
    fireEvent.click(document.querySelector('[data-attr="listing-v2-make-same"]')!);
    expect(boxes()[0]!.checked).toBe(true);
    expect(screen.getByRole("group", { name: "Residents per room for Room A" }).textContent).toContain("1");
  });

  it("unticking moves nothing, and a later change on the Default room leaves that room alone", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("rooms", seeded(), (s) => seen.push(s));
    const boxes = () => [...document.querySelectorAll<HTMLInputElement>('[data-attr="listing-v2-room-same-as-all"]')];
    fireEvent.click(boxes()[0]!);
    expect(boxes()[0]!.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "More Residents per room for every room" }));
    const rooms = seen.at(-1)!.rooms;
    expect(rooms.find((r) => r.id === "r2")?.occupancyCapacity).toBe(2);
    expect(rooms.find((r) => r.id === "r1")?.occupancyCapacity ?? 1).toBe(1);
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
