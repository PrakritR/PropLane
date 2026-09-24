// @vitest-environment jsdom
//
// PLAN-0924-0718: shared rooms (occupancyCapacity ≥ 2) show capacity +
 // "Rent /mo per resident" with ColumnHelp. Price is never split — no
// "Different rent per resident" checkbox / unequal slot blocks.
import { afterEach, describe, expect, it } from "vitest";
import React, { useState } from "react";
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
    { ...template, id: "r1", name: "Room A", monthlyRent: 1000, utilitiesEstimate: "50", securityDeposit: "200", occupancyCapacity: 1 },
    {
      ...template,
      id: "r2",
      name: "Room B",
      monthlyRent: 1000,
      utilitiesEstimate: "75",
      securityDeposit: "250",
      occupancyCapacity: 2,
      residentPricing: "per_resident",
      residentPrices: [{ monthlyRent: 900 }, { monthlyRent: 800 }],
    },
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

describe("Pricing card — shared room same price per resident", () => {
  it("shows no residents / per-resident chrome on a one-resident room", () => {
    render(<Harness />);
    openRoomCard("Room A");
    expect(document.querySelector('[data-attr="listing-v2-price-residents"]')).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-price-per-resident"]')).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-rent-per-resident-help"]')).toBeNull();
  });

  it("shows residents count and Rent /mo per resident with (i) on a shared room", () => {
    render(<Harness />);
    openRoomCard("Room B");
    expect(document.querySelector('[data-attr="listing-v2-price-residents"]')?.textContent).toMatch(/2/);
    expect(screen.getByText(/Rent \/mo per resident/)).toBeTruthy();
    expect(document.querySelector('[data-attr="listing-v2-rent-per-resident-help"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="listing-v2-price-per-resident"]')).toBeNull();
    expect(document.querySelectorAll('[data-attr="listing-v2-price-resident-block"]').length).toBe(0);
  });

  it("opening a shared room with legacy unequal slots clears them", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Harness onChange={(s) => (latest = s)} />);
    openRoomCard("Room B");
    expect(room(latest!, "r2").residentPricing).toBeUndefined();
    expect(room(latest!, "r2").residentPrices).toBeUndefined();
    expect(room(latest!, "r2").monthlyRent).toBe(900);
  });

  it("collapsed summary names residents and same rent", () => {
    render(<Harness />);
    expect(screen.getByText(/2 residents · \$1,000 each/)).toBeTruthy();
  });
});
