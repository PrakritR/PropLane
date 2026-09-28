// @vitest-environment jsdom
//
// N082: a Shared-by-N arrangement set to "Different prices" gets its own
// Other fees (+ Add a fee) and Partial months (Automatic), exactly like the
// room's Private row already had — scoped so a fee/rate added on one
// arrangement never shows on, or is billed under, another.
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ListingPricingSections } from "@/components/portal/listing-wizard-v2/listing-pricing-step";
import {
  createDefaultListingSubmission,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { houseDefaultsForSubmission, type ListingHouseDefaults } from "@/lib/listing-house-defaults";

afterEach(() => cleanup());

function seeded(): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  const template = base.rooms[0]!;
  const rooms: ManagerRoomSubmission[] = [
    {
      ...template,
      id: "r1",
      name: "Room A",
      monthlyRent: 1000,
      utilitiesEstimate: "80",
      securityDeposit: "500",
      occupancyCapacity: 3,
    },
  ];
  // Long-term only: the tab defaults there, and it is the one lease type
  // Partial months applies to (`proratesOnTab`).
  return { ...base, allowedLeaseTerms: ["Long-term"], rooms };
}

function Harness({ onChange }: { onChange?: (sub: ManagerListingSubmissionV1) => void } = {}) {
  const [sub, setSub] = useState<ManagerListingSubmissionV1>(seeded);
  const [defaults, setDefaults] = useState<ListingHouseDefaults>(() => houseDefaultsForSubmission(seeded()));
  const patch = (next: Partial<ManagerListingSubmissionV1>) => {
    setSub((prev) => {
      const merged = { ...prev, ...next };
      onChange?.(merged);
      return merged;
    });
  };
  return (
    <ListingPricingSections
      sub={sub}
      patch={patch}
      defaults={defaults}
      setDefaults={setDefaults}
      leaseTypesField={null}
      payments={null}
      applications={null}
      leaseDocument={null}
    />
  );
}

const openRoomCard = (name: string) => fireEvent.click(screen.getByRole("button", { name: `Open ${name} prices` }));
const room = (sub: ManagerListingSubmissionV1, id: string) => sub.rooms!.find((r) => r.id === id)!;

describe("Shared-room arrangements get their own Other fees and Partial months (N082)", () => {
  it("Shared by 2 (Different prices) offers its own + Add a fee, scoped to that arrangement alone", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Harness onChange={(s) => (latest = s)} />);
    openRoomCard("Room A");

    // DOM order: ArrangementPriceEditor renders Shared by 2's block, then
    // Shared by 3's, before the room card falls through to the existing
    // room-level (Private) Other fees block below it.
    const addButtons = document.querySelectorAll('[data-attr="listing-v2-room-fee-add"]');
    expect(addButtons.length).toBe(3);
    fireEvent.click(addButtons[0]!);

    // The submission ships with the standard preset catalogue already in
    // `customFees` (deposit, move-in fee, parking, …), unpriced — the newly
    // typed row is the one and only `presetId: "custom"` row.
    const added = (latest!.customFees ?? []).filter((f) => f.presetId === "custom");
    expect(added.length).toBe(1);
    expect(added[0]!.roomIds).toEqual(["r1"]);
    expect(added[0]!.arrangementCounts).toEqual([2]);
  });

  it("a fee added on Shared by 2 never lists on the Private (room-level) card", () => {
    render(<Harness />);
    openRoomCard("Room A");
    fireEvent.click(document.querySelectorAll('[data-attr="listing-v2-room-fee-add"]')[0]!);

    // Exactly one fee row exists anywhere on the card — it belongs to Shared
    // by 2's block only, not duplicated onto Private's.
    expect(document.querySelectorAll('[data-attr="listing-v2-fee-row"]').length).toBe(1);
  });

  it("a fee added on Shared by 3 never lists on Shared by 2's block", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Harness onChange={(s) => (latest = s)} />);
    openRoomCard("Room A");
    // Index 1 is Shared by 3's own + Add a fee (see DOM-order comment above).
    fireEvent.click(document.querySelectorAll('[data-attr="listing-v2-room-fee-add"]')[1]!);

    const added = (latest!.customFees ?? []).filter((f) => f.presetId === "custom");
    expect(added.length).toBe(1);
    expect(added[0]!.arrangementCounts).toEqual([3]);
    expect(document.querySelectorAll('[data-attr="listing-v2-fee-row"]').length).toBe(1);
  });

  it("Partial months on Shared by 2 writes that arrangement's own occupancyPrices row, not the room's", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Harness onChange={(s) => (latest = s)} />);
    openRoomCard("Room A");

    const automaticBoxes = document.querySelectorAll('[data-attr$="-automatic"]');
    // Shared by 2's box is the first arrangement-scoped one (see DOM-order
    // comment above; the room-level/Private automatic box comes last).
    fireEvent.click(automaticBoxes[0]!);

    const r1 = room(latest!, "r1");
    const row2 = r1.occupancyPrices?.find((row) => row.count === 2);
    expect(row2?.prorateMethod).toBe("daily_rate");
    // The room's own top-level prorate field, and count 1/3, are untouched.
    expect(r1.prorateMethod).toBeUndefined();
    expect(r1.occupancyPrices?.find((row) => row.count === 3)?.prorateMethod).toBeUndefined();
  });
});
