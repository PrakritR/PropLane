// @vitest-environment jsdom
//
// PLAN-0920-0631: a shared room whose Residents per room (set on the Rooms
// step) is 2 or more gets a "Different rent per resident" row on its Pricing
// card. Ticked, the room's one pricing block is replaced by one block per
// resident (Rent, Utilities, Deposit, Listed rent, Other fees); unticked, the
// room is back to one block and keeps Resident 1's figures.
import { afterEach, describe, expect, it } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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
    { ...template, id: "r1", name: "Room A", monthlyRent: 1000, utilitiesEstimate: "50", securityDeposit: "200", occupancyCapacity: 1 },
    { ...template, id: "r2", name: "Room B", monthlyRent: 1000, utilitiesEstimate: "75", securityDeposit: "250", occupancyCapacity: 2 },
  ];
  return { ...base, allowedLeaseTerms: ["Long-term", "Month-to-Month"], rooms };
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
const perResidentCheckbox = () => document.querySelector('[data-attr="listing-v2-price-per-resident"]') as HTMLInputElement;
const residentBlocks = () => document.querySelectorAll('[data-attr="listing-v2-price-resident-block"]');

describe("Pricing card — different rent per resident", () => {
  it("shows no per-resident row on a one-resident room", () => {
    render(<Harness />);
    openRoomCard("Room A");
    expect(perResidentCheckbox()).toBeNull();
  });

  it("shows the row on a two-resident room, reading its capacity from the Rooms step", () => {
    render(<Harness />);
    openRoomCard("Room B");
    expect(perResidentCheckbox()).toBeTruthy();
    expect(screen.getByText("2 residents · set on Rooms")).toBeTruthy();
    expect(residentBlocks().length).toBe(0);
  });

  it("ticking it opens one block per resident, prefilled from the room, and writes edits to residentPrices", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Harness onChange={(s) => (latest = s)} />);
    openRoomCard("Room B");
    fireEvent.click(perResidentCheckbox());

    const blocks = residentBlocks();
    expect(blocks.length).toBe(2);

    const rent1 = document.querySelector('[data-attr="listing-v2-price-resident-1-rent"]') as HTMLInputElement;
    const rent2 = document.querySelector('[data-attr="listing-v2-price-resident-2-rent"]') as HTMLInputElement;
    // Prefilled from the room's own figures (PRP: ticking on for the first time
    // prefills every resident from the room's current figures).
    expect(rent1.value).toBe("1000");
    expect(rent2.value).toBe("1000");

    fireEvent.change(rent1, { target: { value: "900" } });
    fireEvent.change(rent2, { target: { value: "800" } });

    const r2 = room(latest!, "r2");
    expect(r2.residentPricing).toBe("per_resident");
    expect(r2.residentPrices?.map((p) => p.monthlyRent)).toEqual([900, 800]);
  });

  it("a fee added inside Resident 2's block carries residentSlots: [2]", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Harness onChange={(s) => (latest = s)} />);
    openRoomCard("Room B");
    fireEvent.click(perResidentCheckbox());

    const blocks = residentBlocks();
    const resident2 = blocks[1] as HTMLElement;
    fireEvent.click(within(resident2).getByText("+ Add a fee"));

    const fees = latest!.customFees ?? [];
    const added = fees.find((f) => (f.roomIds ?? []).includes("r2"));
    expect(added).toBeTruthy();
    expect((added as unknown as { residentSlots?: number[] }).residentSlots).toEqual([2]);
  });

  it("unticking keeps Resident 1's edited figures as the room's own", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Harness onChange={(s) => (latest = s)} />);
    openRoomCard("Room B");
    const checkbox = perResidentCheckbox();
    fireEvent.click(checkbox);

    const rent1 = document.querySelector('[data-attr="listing-v2-price-resident-1-rent"]') as HTMLInputElement;
    fireEvent.change(rent1, { target: { value: "950" } });

    fireEvent.click(checkbox); // untick

    const r2 = room(latest!, "r2");
    expect(r2.residentPricing).toBeUndefined();
    expect(r2.residentPrices).toBeUndefined();
    expect(r2.monthlyRent).toBe(950);
    expect(residentBlocks().length).toBe(0);
  });

  it('the collapsed summary reads each resident\'s rent, equal utilities/deposit, and "listed from" the lowest', () => {
    render(<Harness />);
    openRoomCard("Room B");
    fireEvent.click(perResidentCheckbox());

    const rent1 = document.querySelector('[data-attr="listing-v2-price-resident-1-rent"]') as HTMLInputElement;
    const rent2 = document.querySelector('[data-attr="listing-v2-price-resident-2-rent"]') as HTMLInputElement;
    fireEvent.change(rent1, { target: { value: "900" } });
    fireEvent.change(rent2, { target: { value: "800" } });

    expect(document.body.textContent).toContain("$900 · $800 · +$75 utilities · $250 deposit · listed from $800");
  });

  it("ticking a $0 two-resident room keeps the box checked and opens both resident blocks", () => {
    function ZeroHarness() {
      const [sub, setSub] = useState<ManagerListingSubmissionV1>(() => {
        const base = seeded();
        return {
          ...base,
          rooms: base.rooms.map((item) =>
            item.id === "r2" ? { ...item, monthlyRent: 0, utilitiesEstimate: "", securityDeposit: "" } : item,
          ),
        };
      });
      const [defaults, setDefaults] = useState<ListingHouseDefaults>(() => houseDefaultsForSubmission(sub));
      return (
        <ListingPricingSections
          sub={sub}
          patch={(next) => setSub((prev) => ({ ...prev, ...next }))}
          defaults={defaults}
          setDefaults={setDefaults}
          leaseTypesField={null}
          payments={null}
          applications={null}
          leaseDocument={null}
        />
      );
    }
    render(<ZeroHarness />);
    openRoomCard("Room B");
    fireEvent.click(perResidentCheckbox());
    expect(perResidentCheckbox().checked).toBe(true);
    expect(residentBlocks().length).toBe(2);
    const resident2 = residentBlocks()[1] as HTMLElement;
    expect(within(resident2).getByText("+ Add a fee")).toBeTruthy();
    expect(document.querySelector('[data-attr="listing-v2-price-prorate-resident-2-automatic"]')).toBeTruthy();
  });

  it("Partial months lives inside each resident block, not once under the card", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Harness onChange={(s) => (latest = s)} />);
    openRoomCard("Room B");
    fireEvent.click(perResidentCheckbox());

    expect(document.querySelector('[data-attr="listing-v2-price-prorate-room-automatic"]')).toBeNull();
    const auto1 = document.querySelector('[data-attr="listing-v2-price-prorate-resident-1-automatic"]') as HTMLInputElement;
    const auto2 = document.querySelector('[data-attr="listing-v2-price-prorate-resident-2-automatic"]') as HTMLInputElement;
    expect(auto1?.checked).toBe(true);
    expect(auto2?.checked).toBe(true);

    fireEvent.click(auto2);
    const r2 = room(latest!, "r2");
    expect(r2.residentPrices?.[1]?.prorateMethod).toBe("daily_rate");
    expect(r2.residentPrices?.[0]?.prorateMethod).not.toBe("daily_rate");
    expect(document.querySelector('[data-attr="listing-v2-price-prorate-resident-2-rent"]')).toBeTruthy();
  });

  it("ticking it on the Month-to-Month tab keeps the tick and writes the term's rows, leaving Long-term alone", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Harness onChange={(s) => (latest = s)} />);

    fireEvent.click(document.querySelector('[data-attr="listing-v2-price-tab-Month-to-Month"]') as HTMLElement);

    const sameAsLongTerm = document.querySelector('[data-attr^="listing-v2-same-as-long-term-"]') as HTMLInputElement | null;
    if (sameAsLongTerm?.checked) fireEvent.click(sameAsLongTerm);

    openRoomCard("Room B");
    fireEvent.click(perResidentCheckbox());

    expect(residentBlocks().length).toBe(2);

    const r2 = room(latest!, "r2");
    expect(r2.termPricing?.["Month-to-Month"]?.residentPricing).toBe("per_resident");
    expect(r2.termPricing?.["Month-to-Month"]?.residentPrices?.length).toBe(2);
    expect(r2.residentPricing).toBeUndefined();
  });
});

function staySeeded(): ManagerListingSubmissionV1 {
  const base = seeded();
  return { ...base, allowedLeaseTerms: [...(base.allowedLeaseTerms ?? []), "Short-Term Stay"], shortTermRentalsAllowed: true };
}

function StayHarness({ onChange }: { onChange?: (sub: ManagerListingSubmissionV1) => void } = {}) {
  const [sub, setSub] = useState<ManagerListingSubmissionV1>(staySeeded);
  const [defaults, setDefaults] = useState<ListingHouseDefaults>(() => houseDefaultsForSubmission(staySeeded()));
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

describe("Pricing card — short stay rent per resident", () => {
  it("offers a Same / Different dropdown on a two-resident room and writes stay rows", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<StayHarness onChange={(s) => (latest = s)} />);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-price-tab-Short-Term Stay"]') as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Open Room B stay prices" }));

    expect(document.querySelector('[data-attr="listing-v2-stay-per-resident"]')).toBeTruthy();
    expect(document.querySelectorAll('[data-attr="listing-v2-stay-resident-block"]').length).toBe(0);

    const trigger = screen.getByRole("button", { name: "Rent per resident for Room B" });
    if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
    const option = document.getElementById(trigger.getAttribute("aria-controls")!)!.querySelector('[data-field-select-option-value="per_resident"]')!;
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });

    expect(document.querySelectorAll('[data-attr="listing-v2-stay-resident-block"]').length).toBe(2);
    const night2 = document.querySelector('[data-attr="listing-v2-stay-resident-2-night"]') as HTMLInputElement;
    fireEvent.change(night2, { target: { value: "70" } });
    expect(room(latest!, "r2").stayResidentPricing).toBe("per_resident");
    expect(room(latest!, "r2").stayResidentPrices?.[1]?.shortTermRent).toBe("70");
  });
});
