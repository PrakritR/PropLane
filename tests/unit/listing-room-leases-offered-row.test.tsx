// @vitest-environment jsdom
//
// Rooms, Bathrooms and Shared spaces: no chevron on the card header (the ⋯ menu's
// Edit, the facts line and Done open and close it), and each room card carries a
// "Leases offered" row limited to the listing's own lease types.
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
  allowedLeaseTerms: ["Long-term", "Month-to-Month", "Custom"],
  shortTermRentalsAllowed: true,
  rooms: [
    { ...base.rooms[0]!, id: "r1", name: "Room A" },
    { ...base.rooms[0]!, id: "r2", name: "Room B", offeredLeaseTerms: ["Long-term", "Short-Term Stay"] },
  ],
  bathrooms: [{ id: "b1", name: "Upstairs", assignedRoomIds: ["r1"] }],
  sharedSpaces: [{ id: "s1", name: "Kitchen", spaceKind: "kitchen", roomAccessIds: ["r1", "r2"] }],
};

function Editor({ sub0 = seeded, onChange }: { sub0?: ManagerListingSubmissionV1; onChange?: (s: ManagerListingSubmissionV1) => void }) {
  const [sub, setSub] = useState(sub0);
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

function open(step: "rooms" | "bathrooms" | "spaces", onChange?: (s: ManagerListingSubmissionV1) => void, sub0?: ManagerListingSubmissionV1) {
  render(<Editor sub0={sub0} onChange={onChange} />);
  fireEvent.click(document.querySelector(`[data-attr="listing-v2-rail-${step}"]`)!);
}

describe("card header has no chevron toggle", () => {
  it.each([
    ["rooms", "Room A", "listing-v2-room-card"],
    ["bathrooms", "Upstairs", "listing-v2-bathroom-card"],
    ["spaces", "Kitchen", "listing-v2-space-card"],
  ] as const)("%s: the facts line opens, Done closes, and no svg chevron button remains", (step, label, cardAttr) => {
    open(step);
    const card = document.querySelector(`[data-attr="${cardAttr}"]`) ?? document.querySelector('[data-attr^="listing-v2-"][data-attr$="-card"]');
    expect(card).not.toBeNull();
    // The only card-open control is the facts line (text), never an icon button.
    const openers = document.querySelectorAll('[data-attr="listing-v2-card-open"]');
    expect(openers.length).toBeGreaterThan(0);
    for (const el of openers) expect(el.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("button", { name: `Open ${label}` })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `Open ${label}` }));
    expect(screen.getByRole("button", { name: `Close ${label}` }).getAttribute("aria-expanded")).toBe("true");
    const done = document.querySelector('[data-attr$="-done"]') as HTMLElement | null;
    expect(done).not.toBeNull();
    fireEvent.click(done!);
    expect(screen.getByRole("button", { name: `Open ${label}` }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("room card: Leases offered", () => {
  it("lists only the listing's lease types and writes a restriction", () => {
    const seen: ManagerListingSubmissionV1[] = [];
    open("rooms", (s) => seen.push(s));
    fireEvent.click(screen.getByRole("button", { name: "Open Room A" }));
    const trigger = screen.getByRole("button", { name: "Leases offered for Room A" });
    fireEvent.click(trigger);
    const menu = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    const labels = [...menu.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim());
    expect(labels).toEqual(["Long-term", "Short term", "Custom", "Month-to-month"]);
    // Short term is on (shortTermRentalsAllowed); Airbnb is not offered here.
    expect(labels).not.toContain("Airbnb");
    // Untick Custom: the room now restricts.
    const custom = menu.querySelector('[data-field-select-option-value="Custom"]')!;
    fireEvent.pointerDown(custom, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(custom, { pointerId: 1, clientX: 10, clientY: 10 });
    const room = seen.at(-1)!.rooms.find((r) => r.id === "r1")!;
    expect(room.offeredLeaseTerms).toEqual(["Long-term", "Month-to-Month", "Short-Term Stay"]);
    // The collapsed card now says so, as a plain fact.
    expect(document.body.textContent).toContain("Long-term, Short term, Month-to-month");
  });

  it("a room that does not restrict shows no lease-type fact on its card", () => {
    open("rooms");
    const cards = [...document.querySelectorAll('[data-attr="listing-v2-room-card"]')];
    expect(cards[0]!.textContent).not.toMatch(/Long-term/);
    expect(cards[1]!.textContent).toContain("Long-term, Short term");
  });

  it("always offers the four lease types; Custom has an (i) and turns on Prorated rent (captain, Oct 3)", () => {
    open("rooms", undefined, { ...seeded, allowedLeaseTerms: ["Long-term"], shortTermRentalsAllowed: false });
    fireEvent.click(screen.getByRole("button", { name: "Open Room A" }));
    expect(screen.getByRole("button", { name: "Leases offered for Room A" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Prorated rent for Room A" })).toBeNull();
  });
});
