// @vitest-environment jsdom
//
// Rooms, bundles and the whole house draw ONE field list (captain, Oct 3: "application fee, lease fee,
// move-in fee, month-to-month surcharge, custom start surcharge etc. - have the same for bundles as well as
// individual rooms"). Partial months and the two surcharges follow what the listing allows: custom dates,
// month-to-month. These tests render the three real components over the same listing and compare them.
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import {
  BundlePricingFields,
  RoomPricingFields,
  WholeHousePricingFields,
} from "@/components/portal/property-room-pricing-workspace";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

afterEach(() => cleanup());

function listing(allowed: string[]): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return normalizeManagerListingSubmissionV1({
    ...base,
    allowedLeaseTerms: allowed,
    shortTermRentalsAllowed: true,
    rooms: [{ ...base.rooms[0]!, id: "room-a", name: "Room A", monthlyRent: 1100, utilitiesEstimate: "100" }],
    bundles: [
      { id: "b1", label: "Both", price: "2000", strikethrough: "", promo: "", roomsLine: "", includedRoomIds: ["room-a"] },
    ],
  } as ManagerListingSubmissionV1);
}

type Subject = "room" | "bundle" | "whole";

function Draw({ subject, sub, term, onChange }: { subject: Subject; sub: ManagerListingSubmissionV1; term: string; onChange?: (next: ManagerListingSubmissionV1) => void }) {
  const [draft, setDraft] = React.useState(sub);
  const commit = (next: ManagerListingSubmissionV1) => {
    const normalized = normalizeManagerListingSubmissionV1(next);
    setDraft(normalized);
    onChange?.(normalized);
  };
  const patch = (next: Partial<ManagerListingSubmissionV1>) => commit({ ...draft, ...next });
  if (subject === "room") {
    return (
      <RoomPricingFields
        draft={draft}
        room={draft.rooms[0]!}
        activeTerm={term}
        patch={patch}
        setDraft={commit}
        updateRoom={(id, next) => patch({ rooms: draft.rooms.map((r) => (r.id === id ? next : r)) })}
      />
    );
  }
  if (subject === "bundle") {
    return <BundlePricingFields draft={draft} bundle={draft.bundles[0]!} activeStepId={term} patch={patch} setDraft={commit} />;
  }
  return <WholeHousePricingFields draft={draft} activeStepId={term} patch={patch} offerToggle={false} />;
}

/** The row labels a section draws, in order: exactly what a manager reads down the left. */
function rowLabels(): string[] {
  return Array.from(document.querySelectorAll("span.truncate")).map((node) =>
    (node.textContent ?? "").replace(/Optional|\(required\)/g, "").trim(),
  );
}

function labelsFor(subject: Subject, allowed: string[], term: string): string[] {
  cleanup();
  render(<Draw subject={subject} sub={listing(allowed)} term={term} />);
  return rowLabels();
}

const SUBJECTS: Subject[] = ["room", "bundle", "whole"];
const ALL = [LONG_TERM_LEASE_TERM, "Month-to-Month", "Custom"];

describe("rooms, bundles and the whole house draw the same fields", () => {
  it("Long-term: every one lists the same rows, in the same order, with every fee a room has", () => {
    const [room, bundle, whole] = SUBJECTS.map((subject) => labelsFor(subject, ALL, LONG_TERM_LEASE_TERM));
    expect(bundle).toEqual(room);
    expect(whole).toEqual(room);
    for (const label of [
      "Rent /mo",
      "Utilities /mo",
      "Deposit",
      "Partial months",
      "Lease fee",
      "Application fee",
      "Move-in fee",
      "Custom start surcharge",
    ]) {
      expect(room, label).toContain(label);
    }
    // The Month-to-month surcharge belongs to the Month-to-month option's own tab.
    expect(room).not.toContain("Month-to-month surcharge");
  });

  it("Month-to-month: every one lists the same rows -- just the fees, no surcharge; rent follows Long-term", () => {
    const [room, bundle, whole] = SUBJECTS.map((subject) => labelsFor(subject, ALL, "Month-to-Month"));
    expect(bundle).toEqual(room);
    expect(whole).toEqual(room);
    for (const label of ["Lease fee", "Application fee", "Move-in fee"]) {
      expect(room, label).toContain(label);
    }
    for (const label of ["Rent /mo", "Month-to-month surcharge", "Custom start surcharge", "Partial months"]) {
      expect(room, label).not.toContain(label);
    }
  });

  it("Short-term: every one lists the same rows, with the same fees and no start surcharges", () => {
    const [room, bundle, whole] = SUBJECTS.map((subject) => labelsFor(subject, ALL, SHORT_TERM_LEASE_TERM));
    expect(bundle).toEqual(room);
    expect(whole).toEqual(room);
    for (const label of ["Nightly rate", "Deposit", "Lease fee", "Application fee", "Move-in fee"]) {
      expect(room, label).toContain(label);
    }
    for (const label of ["Partial months", "Month-to-month surcharge", "Custom start surcharge"]) {
      expect(room, label).not.toContain(label);
    }
  });
});

describe("Partial months and the surcharges follow what the listing allows", () => {
  for (const subject of SUBJECTS) {
    it(`${subject}: Partial months and Custom start surcharge show only with custom dates; Month-to-month has no surcharge`, () => {
      const plain = labelsFor(subject, [LONG_TERM_LEASE_TERM], LONG_TERM_LEASE_TERM);
      expect(plain).not.toContain("Partial months");
      expect(plain).not.toContain("Custom start surcharge");
      expect(plain).not.toContain("Month-to-month surcharge");
      // the always-on fees are still there
      for (const label of ["Lease fee", "Application fee", "Move-in fee"]) expect(plain, label).toContain(label);

      // Month-to-month: its surcharge sits on its own tab, not on the Long-term one.
      const monthToMonthLong = labelsFor(subject, [LONG_TERM_LEASE_TERM, "Month-to-Month"], LONG_TERM_LEASE_TERM);
      expect(monthToMonthLong).not.toContain("Month-to-month surcharge");
      expect(monthToMonthLong).not.toContain("Partial months");
      expect(monthToMonthLong).not.toContain("Custom start surcharge");
      const monthToMonth = labelsFor(subject, [LONG_TERM_LEASE_TERM, "Month-to-Month"], "Month-to-Month");
      expect(monthToMonth).not.toContain("Month-to-month surcharge");
      expect(monthToMonth).not.toContain("Custom start surcharge");
      // Not allowed: no surcharge even on that tab.
      expect(labelsFor(subject, [LONG_TERM_LEASE_TERM], "Month-to-Month")).not.toContain("Month-to-month surcharge");

      const custom = labelsFor(subject, [LONG_TERM_LEASE_TERM, "Custom"], LONG_TERM_LEASE_TERM);
      expect(custom).toContain("Partial months");
      expect(custom).toContain("Custom start surcharge");
      expect(custom).not.toContain("Month-to-month surcharge");
    });
  }
});

describe("a bundle's fees land in the structures that already exist", () => {
  function typeInto(label: string, value: string) {
    const input = document.querySelector(`input[aria-label='${label}']`) as HTMLInputElement;
    expect(input, label).not.toBeNull();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value } });
  }

  it("Long-term: Lease fee and Application fee go to termPricing, Move-in fee to moveInFee, the custom start surcharge to the bundle", () => {
    let latest = listing(ALL);
    render(<Draw subject="bundle" sub={latest} term={LONG_TERM_LEASE_TERM} onChange={(next) => (latest = next)} />);
    typeInto("Private room long-term lease fee", "300");
    typeInto("Private room long-term application fee", "45");
    typeInto("Private room move-in fee", "150");
    typeInto("Private room custom start surcharge", "60");
    const bundle = latest.bundles[0]!;
    expect(bundle.termPricing?.[LONG_TERM_LEASE_TERM]).toMatchObject({ leaseFee: "300", applicationFee: "45" });
    expect(bundle.moveInFee).toBe("150");
    expect(bundle).not.toHaveProperty("monthToMonthSurcharge");
    expect(bundle.customStartSurcharge).toBe("60");
    // The bundle's rent is untouched by any of it.
    expect(bundle.price).toBe("2000");
  });

  it("Short-term: its own Lease fee, Application fee and Move-in fee, kept apart from the long-term ones", () => {
    let latest = listing(ALL);
    render(<Draw subject="bundle" sub={latest} term={SHORT_TERM_LEASE_TERM} onChange={(next) => (latest = next)} />);
    typeInto("Private room short term lease fee", "80");
    typeInto("Private room short term application fee", "20");
    typeInto("Private room move-in fee", "40");
    const bundle = latest.bundles[0]!;
    expect(bundle.termPricing?.[SHORT_TERM_LEASE_TERM]).toMatchObject({ leaseFee: "80", applicationFee: "20" });
    expect(bundle.shortTermMoveInFee).toBe("40");
    expect(bundle.moveInFee).toBeUndefined();
    expect(bundle.termPricing?.[LONG_TERM_LEASE_TERM]).toBeUndefined();
  });

  it("clearing a fee takes it back out of the bundle", () => {
    let latest = listing(ALL);
    render(<Draw subject="bundle" sub={latest} term={LONG_TERM_LEASE_TERM} onChange={(next) => (latest = next)} />);
    typeInto("Private room long-term lease fee", "300");
    expect(latest.bundles[0]!.termPricing?.[LONG_TERM_LEASE_TERM]?.leaseFee).toBe("300");
    typeInto("Private room long-term lease fee", "");
    expect(latest.bundles[0]!.termPricing).toBeUndefined();
  });
});
