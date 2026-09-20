// @vitest-environment jsdom
//
// The edit-listing Pricing screen, driven the way a manager drives it. These are
// the captain's own complaints of 2026-09-13, each one turned into a thing the
// screen must actually do:
//   - payment setup comes FIRST, not below three sections that cannot matter yet
//   - the application fee and waiver code are asked once, not in two places
//   - a room's utilities can be set to $0 and stay $0
//   - a room that has its own numbers offers a way back to the house numbers
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import {
  createDefaultListingSubmission,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

afterEach(() => cleanup());

function seeded(): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    applicationFee: "50",
    applicationFeeWaiverCode: "JHASDA",
    allowedLeaseTerms: ["Long-term", "Month-to-Month", "Custom"],
    rooms: [
      { id: "r1", name: "Room A", monthlyRent: 1100, utilitiesEstimate: "150" },
      { id: "r2", name: "Room B", monthlyRent: 1100, utilitiesEstimate: "150" },
    ],
  } as ManagerListingSubmissionV1;
}

function Editor({ onChange }: { onChange?: (sub: ManagerListingSubmissionV1) => void } = {}) {
  const [sub, setSub] = useState(seeded);
  return (
    <ListingEditorV2
      title="Edit listing"
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

/** Open the Pricing section of the editor. */
/** A room's prices live inside its card; open it to reach the cells. */
const openPriceCard = (name: string) => fireEvent.click(screen.getByRole("button", { name: `Open ${name} prices` }));

function openPricing() {
  render(<Editor />);
  const nav = screen.getByRole("navigation", { name: "Listing sections" });
  const pricing = Array.from(nav.querySelectorAll("button")).find((b) =>
    /rent|pricing|deposit/i.test(b.textContent ?? ""),
  );
  expect(pricing, "Pricing nav entry").toBeTruthy();
  fireEvent.click(pricing!);
}

describe("Pricing puts payment setup first", () => {
  it("leads with How you get paid, then the rooms' lease types, then Applications right under them", () => {
    openPricing();
    const headings = Array.from(document.querySelectorAll("h3")).map((h) => h.textContent ?? "");
    const paid = headings.findIndex((h) => h.includes("How you get paid"));
    const apps = headings.findIndex((h) => h.includes("Applications"));
    const rooms = headings.findIndex((h) => h.includes("Each room"));

    expect(paid).toBeGreaterThanOrEqual(0);
    expect(paid).toBeLessThan(rooms);
    // The application fee is asked AFTER the lease types it may differ by (the captain, 2026-09-15).
    expect(rooms).toBeLessThan(apps);
    const leaseTypes = document.querySelector('[data-attr="listing-v2-lease-types-card"]')!;
    const applications = document.querySelector('[data-attr="listing-v2-applications-card"]')!;
    expect(leaseTypes.compareDocumentPosition(applications) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // There is no separate fees section any more: fees live on the cards.
    expect(headings.some((h) => h.includes("Other fees"))).toBe(false);
    expect(headings.some((h) => h.includes("At signing"))).toBe(false);
    expect(document.querySelector('[data-attr="listing-v2-due-at-signing"]')).toBeNull();
    expect(document.body.textContent).toContain("Due at signing");
    const roomPickers = screen.getAllByLabelText("Room to quote");
    expect(roomPickers.length).toBeGreaterThan(0);
    expect(roomPickers.every((el) => el.textContent?.includes("Every room"))).toBe(true);
  });

  it("asks for the application fee and waiver code exactly once, with no Manage codes link", () => {
    openPricing();
    // Both used to appear here AND on Advanced — and the Advanced copies wrote
    // the raw input, so letters typed there were stored as the fee.
    const labels = Array.from(document.querySelectorAll("[aria-label]")).map((l) => l.getAttribute("aria-label") ?? "");
    const count = (re: RegExp) => labels.filter((t) => re.test(t)).length;

    expect(count(/^Application fee$/)).toBe(1);
    expect(count(/^Waiver code/)).toBe(1);
    // The retired second copy carried this exact label.
    expect(count(/^Application fee waive code/)).toBe(0);
    expect(screen.queryByText(/Manage codes/)).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-manage-waiver-codes"]')).toBeNull();
  });

  it("prices the application fee per lease type behind one checkbox; blank rows follow the one amount", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Editor onChange={(s) => (latest = s)} />);
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    fireEvent.click(Array.from(nav.querySelectorAll("button")).find((b) => /pricing/i.test(b.textContent ?? ""))!);

    expect(screen.queryByLabelText("Month to month application fee")).toBeNull();
    fireEvent.click(document.querySelector('[data-attr="listing-v2-application-fee-split"]')!);
    // One row per lease type the listing offers, each following the one amount.
    const mtm = screen.getByLabelText("Month to month application fee") as HTMLInputElement;
    expect(screen.getByLabelText("Long-term application fee")).toBeTruthy();
    expect(screen.getByLabelText("Custom application fee")).toBeTruthy();
    expect(mtm.value).toBe("");
    expect(mtm.placeholder).toBe("50");

    fireEvent.change(mtm, { target: { value: "25" } });
    expect(latest?.applicationFeeByLeaseType).toEqual({ "Month-to-Month": "25" });
    expect(latest?.applicationFee).toBe("50");

    // Untick: every per-type amount goes and one fee applies again.
    fireEvent.click(document.querySelector('[data-attr="listing-v2-application-fee-split"]')!);
    expect(latest?.applicationFeeByLeaseType).toBeUndefined();
    expect(screen.queryByLabelText("Month to month application fee")).toBeNull();
  });

  it("the application-fee switch off blanks the fee and hides its rows", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Editor onChange={(s) => (latest = s)} />);
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    fireEvent.click(Array.from(nav.querySelectorAll("button")).find((b) => /pricing/i.test(b.textContent ?? ""))!);
    const toggle = document.querySelector('[data-attr="listing-v2-application-fee-on"]') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(latest?.applicationFee).toBe("");
    expect(latest?.applicationFeeWaiverCode).toBe("");
    expect(latest?.applicationFeeByLeaseType).toBeUndefined();
    expect(document.querySelector('[data-attr="listing-v2-application-fee-rows"]')).toBeNull();
  });
});

describe("a room can be priced at $0", () => {
  it("keeps a typed 0 in the utilities cell instead of snapping back to the house number", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Editor onChange={(s) => (latest = s)} />);
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    const pricing = Array.from(nav.querySelectorAll("button")).find((b) =>
      /rent|pricing|deposit/i.test(b.textContent ?? ""),
    );
    fireEvent.click(pricing!);
    openPriceCard("Room A");

    const cell = screen.getByLabelText(/Room A utilities on/i) as HTMLInputElement;
    fireEvent.change(cell, { target: { value: "0" } });

    const roomA = (latest?.rooms ?? []).find((r) => r.id === "r1");
    expect(roomA?.utilitiesEstimate).toBe("0");

    // And it survives back onto the screen as a real 0, not an empty box showing
    // the house placeholder — which is exactly what used to happen.
    const after = screen.getByLabelText(/Room A utilities on/i) as HTMLInputElement;
    expect(after.value).toBe("0");
  });
});

describe("collected at signing", () => {
  /**
   * The captain's 2026-09-13 report: "this selection for box does not work".
   * On a listing still holding a retired length, the control read and wrote
   * `Long-term` while the matrix only had a `12-Month` row, so every tick was
   * written and dropped again and the box stayed on "Nothing due at signing".
   */
  function LegacyTermEditor({ onChange }: { onChange?: (sub: ManagerListingSubmissionV1) => void }) {
    const [sub, setSub] = useState<ManagerListingSubmissionV1>(() => ({
      ...seeded(),
      allowedLeaseTerms: ["12-Month"],
    }) as ManagerListingSubmissionV1);
    return (
      <ListingEditorV2
        title="Edit listing"
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

  it("keeps a payment ticked on a listing that stored a retired length", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<LegacyTermEditor onChange={(s) => (latest = s)} />);
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    fireEvent.click(
      Array.from(nav.querySelectorAll("button")).find((b) => /rent|pricing|deposit/i.test(b.textContent || ""))!,
    );

    // Desktop and mobile both mount the receipt; the duplicate bottom card is gone.
    const ticks = screen.getAllByRole("checkbox", { name: /Collect First month'?s rent at signing/i });
    expect(ticks.length).toBe(2);
    const tick = ticks[0] as HTMLInputElement;
    // Untick, then tick again: both writes must land on the term the row reads.
    if (tick.checked) fireEvent.click(tick);
    fireEvent.click(screen.getAllByRole("checkbox", { name: /Collect First month'?s rent at signing/i })[0]!);

    // The tick must survive the write and the component's re-read of it.
    const matrix = latest?.paymentAtSigningByLeaseType ?? {};
    const everyKey = Object.values(matrix).flat();
    expect(everyKey).toContain("first_month_rent");
    expect((screen.getAllByRole("checkbox", { name: /Collect First month'?s rent at signing/i })[0] as HTMLInputElement).checked).toBe(true);
  });
});

describe("a room with its own numbers can go back to the house numbers", () => {
  it("offers ↺ on the one cell that differs, and clears only that field when pressed", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Editor onChange={(s) => (latest = s)} />);
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    fireEvent.click(
      Array.from(nav.querySelectorAll("button")).find((b) => /rent|pricing|deposit/i.test(b.textContent ?? ""))!,
    );

    openPriceCard("Room A");
    expect(screen.queryByRole("button", { name: /Reset utilities for Room A/i })).toBeNull();

    fireEvent.change(screen.getByLabelText(/Room A utilities on/i), { target: { value: "0" } });
    // A cell only "differs" once the house has a number to differ from.
    fireEvent.change(screen.getByLabelText("Deposit for every room"), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText(/Room A deposit on/i), { target: { value: "900" } });
    const reset = screen.getByRole("button", { name: /Reset utilities for Room A/i });

    fireEvent.click(reset);
    const roomA = (latest?.rooms ?? []).find((r) => r.id === "r1");
    // The room takes its own copy of the house number (both rooms said 150),
    // not a blank: Review and the lease read the record, not the card.
    expect(roomA?.utilitiesEstimate).toBe("150");
    // The deposit the manager typed in the cell next door is untouched.
    expect(roomA?.securityDeposit).toBe("900");
    expect(screen.queryByRole("button", { name: /Reset utilities for Room A/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Reset deposit for Room A/i })).toBeTruthy();
  });
});

describe("other fees live on the pricing cards", () => {
  function pricing(onChange: (s: ManagerListingSubmissionV1) => void) {
    render(<Editor onChange={onChange} />);
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    fireEvent.click(Array.from(nav.querySelectorAll("button")).find((b) => /pricing/i.test(b.textContent ?? ""))!);
  }

  it("a fee added on the Default room is every room's, on the lease types only, and edited in one place", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    pricing((s) => (latest = s));
    // Listed everything: no More ▾ on the pricing cards.
    expect(document.querySelector('[data-attr="listing-v2-price-defaults-more"]')).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-price-more"]')).toBeNull();

    fireEvent.click(document.querySelector('[data-attr="listing-v2-default-fee-add"]')!);
    const fee = (latest?.customFees ?? []).find((f) => (f as { presetId?: string }).presetId === "custom");
    expect(fee).toBeTruthy();
    // Every room, stored as no narrowing; every lease type offered here is a lease type, so no narrowing there either.
    expect(fee?.roomIds).toBeUndefined();
    expect(fee?.leaseTypes).toBeUndefined();

    fireEvent.change(screen.getByLabelText("Fee name"), { target: { value: "Cleaning" } });
    fireEvent.change(screen.getByLabelText("Cleaning amount"), { target: { value: "120" } });
    // The room card lists it as an inherited row: the Default amount as the placeholder, nothing of its own.
    openPriceCard("Room A");
    const inherited = screen.getByLabelText("Cleaning amount for Room A") as HTMLInputElement;
    expect(inherited.value).toBe("");
    expect(inherited.placeholder).toBe("120");
    expect(inherited.className).toContain("border-dashed");
    expect(screen.getByRole("button", { name: "Remove Cleaning for Room A" })).toBeTruthy();
    // And the room adds its own fee, scoped to itself.
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-fee-add"]')!);
    const own = (latest?.customFees ?? []).filter((f) => (f as { presetId?: string }).presetId === "custom");
    expect(own).toHaveLength(2);
    expect(own[1]?.roomIds).toEqual(["r1"]);
  });

  it("typing a standard fee's name adopts the preset instead of a duplicate custom row", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    pricing((s) => (latest = s));
    fireEvent.click(document.querySelector('[data-attr="listing-v2-default-fee-add"]')!);
    fireEvent.change(screen.getByLabelText("Fee name"), { target: { value: "Parking" } });
    const fees = latest?.customFees ?? [];
    expect(fees.some((f) => (f as { presetId?: string }).presetId === "custom")).toBe(false);
    expect(fees.some((f) => (f as { presetId?: string }).presetId === "parking_monthly")).toBe(true);
    fireEvent.change(screen.getByLabelText("Parking amount"), { target: { value: "50" } });
    expect(latest?.parkingMonthly).toBe("50");
  });

  it("Done is the product's blue, not a black pill", () => {
    pricing(() => {});
    openPriceCard("Room A");
    const done = document.querySelector('[data-attr="listing-v2-price-done"]')!;
    expect(done.className).toContain("bg-primary");
    expect(done.className).not.toContain("bg-foreground");
  });
});

describe("fees follow the tab they are added on", () => {
  function StayEditor({ onChange }: { onChange: (sub: ManagerListingSubmissionV1) => void }) {
    const [sub, setSub] = useState<ManagerListingSubmissionV1>(() => ({ ...seeded(), shortTermRentalsAllowed: true }) as ManagerListingSubmissionV1);
    return <ListingEditorV2 title="Edit listing" submission={sub} onChange={(next) => { setSub(next); onChange(next); }} onClose={() => {}} onSaveExit={() => {}} onPublish={() => {}} />;
  }

  it("a lease-tab fee bills on the three lease types; a stay-tab fee on the stay type — neither shows on the other tab", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<StayEditor onChange={(s) => (latest = s)} />);
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    fireEvent.click(Array.from(nav.querySelectorAll("button")).find((b) => /pricing/i.test(b.textContent ?? ""))!);

    fireEvent.click(document.querySelector('[data-attr="listing-v2-default-fee-add"]')!);
    fireEvent.change(screen.getByLabelText("Fee name"), { target: { value: "Gym" } });
    fireEvent.change(screen.getByLabelText("Gym amount"), { target: { value: "40" } });
    const gym = (latest?.customFees ?? []).find((f) => f.label === "Gym");
    expect(gym?.leaseTypes).toEqual(["Long-term", "Month-to-Month", "Custom"]);
    expect(gym?.roomIds).toBeUndefined();

    fireEvent.click(document.querySelector('[data-attr="listing-v2-price-tab-Short-Term Stay"]')!);
    // The stay Default room shows no lease fee and adds its own, scoped to the stay type.
    expect(screen.queryByLabelText("Gym amount")).toBeNull();
    fireEvent.click(document.querySelector('[data-attr="listing-v2-default-fee-add"]')!);
    fireEvent.change(screen.getByLabelText("Fee name"), { target: { value: "Cleaning" } });
    fireEvent.change(screen.getByLabelText("Cleaning amount"), { target: { value: "120" } });
    const cleaning = (latest?.customFees ?? []).find((f) => f.label === "Cleaning");
    expect(cleaning?.leaseTypes).toEqual(["Short-Term Stay"]);
    expect(cleaning?.frequency).toBe("one-time");

    fireEvent.click(document.querySelector('[data-attr="listing-v2-price-tab-Long-term"]')!);
    expect(screen.queryByLabelText("Cleaning amount")).toBeNull();
    expect(screen.getByLabelText("Gym amount")).toBeTruthy();
  });
});

describe("a lease type can have its own Default room", () => {
  const MTM = "Month-to-Month";
  const goToMonthToMonth = () => {
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    fireEvent.click(Array.from(nav.querySelectorAll("button")).find((b) => /pricing/i.test(b.textContent ?? ""))!);
    fireEvent.click(document.querySelector(`[data-attr="listing-v2-price-tab-${MTM}"]`)!);
  };
  const sameAsLongTerm = () => document.querySelector(`[data-attr="listing-v2-same-as-long-term-${MTM}"]`) as HTMLInputElement;

  it("typing a Month-to-Month default rent puts it on every room and on the listing", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Editor onChange={(s) => (latest = s)} />);
    goToMonthToMonth();
    expect(sameAsLongTerm().checked).toBe(true);
    fireEvent.click(sameAsLongTerm());

    // The card is a real input now, empty, showing long-term's number as the placeholder.
    const rent = screen.getByLabelText(`Rent for every room on ${MTM}`) as HTMLInputElement;
    expect(rent.value).toBe("");
    expect(rent.placeholder).toBe("1100");
    fireEvent.change(rent, { target: { value: "1050" } });

    expect(latest!.houseTermPricing?.[MTM]?.monthlyRent).toBe(1050);
    expect(latest!.rooms.map((r) => r.termPricing?.[MTM]?.monthlyRent)).toEqual([1050, 1050]);
    // Long-term rent is not what was edited.
    expect(latest!.rooms.map((r) => r.monthlyRent)).toEqual([1100, 1100]);
  });

  it("a room with its own Month-to-Month number keeps it when the default moves", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Editor onChange={(s) => (latest = s)} />);
    goToMonthToMonth();
    fireEvent.click(sameAsLongTerm());
    fireEvent.change(screen.getByLabelText(`Rent for every room on ${MTM}`), { target: { value: "1050" } });
    openPriceCard("Room B");
    fireEvent.change(screen.getByLabelText(`Room B rent on ${MTM}`), { target: { value: "1250" } });
    fireEvent.change(screen.getByLabelText(`Rent for every room on ${MTM}`), { target: { value: "1000" } });

    const byId = (id: string) => latest!.rooms.find((r) => r.id === id)!;
    expect(byId("r1").termPricing?.[MTM]?.monthlyRent).toBe(1000);
    expect(byId("r2").termPricing?.[MTM]?.monthlyRent).toBe(1250);
  });

  it("ticking Same as long-term again wipes the term's Default room and every room's own price on it", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Editor onChange={(s) => (latest = s)} />);
    goToMonthToMonth();
    fireEvent.click(sameAsLongTerm());
    fireEvent.change(screen.getByLabelText(`Rent for every room on ${MTM}`), { target: { value: "1050" } });
    expect(sameAsLongTerm().checked).toBe(false);
    fireEvent.click(sameAsLongTerm());

    expect(latest!.houseTermPricing).toBeUndefined();
    expect(latest!.rooms.map((r) => r.termPricing)).toEqual([undefined, undefined]);
    expect(sameAsLongTerm().checked).toBe(true);
  });

  it("shows the stored default again on reopen", () => {
    function Stored() {
      const [sub, setSub] = useState<ManagerListingSubmissionV1>(() => ({
        ...seeded(),
        houseTermPricing: { [MTM]: { monthlyRent: 1050, securityDeposit: "750" } },
        rooms: seeded().rooms.map((r) => ({ ...r, termPricing: { [MTM]: { monthlyRent: 1050, securityDeposit: "750" } } })),
      }));
      return <ListingEditorV2 title="Edit listing" submission={sub} onChange={setSub} onClose={() => {}} onSaveExit={() => {}} onPublish={() => {}} />;
    }
    render(<Stored />);
    goToMonthToMonth();
    expect(sameAsLongTerm().checked).toBe(false);
    expect((screen.getByLabelText(`Rent for every room on ${MTM}`) as HTMLInputElement).value).toBe("1050");
    expect((screen.getByLabelText(`Deposit for every room on ${MTM}`) as HTMLInputElement).value).toBe("750");
    expect((screen.getByLabelText(`Utilities for every room on ${MTM}`) as HTMLInputElement).value).toBe("");
  });
});

describe("partial months", () => {
  /** Rooms with no utilities yet, so the Utilities /day row has a reason to stay away. */
  function DryEditor({ onChange }: { onChange?: (sub: ManagerListingSubmissionV1) => void }) {
    const [sub, setSub] = useState<ManagerListingSubmissionV1>(() => ({
      ...seeded(),
      rooms: [
        { id: "r1", name: "Room A", monthlyRent: 1100 },
        { id: "r2", name: "Room B", monthlyRent: 1100 },
      ],
    }) as ManagerListingSubmissionV1);
    return <ListingEditorV2 title="Edit listing" submission={sub} onChange={(next) => { setSub(next); onChange?.(next); }} onClose={() => {}} onSaveExit={() => {}} onPublish={() => {}} />;
  }
  const goPricing = () => {
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    fireEvent.click(Array.from(nav.querySelectorAll("button")).find((b) => /pricing/i.test(b.textContent ?? ""))!);
  };
  const defaultTick = () => document.querySelector('[data-attr="listing-v2-price-prorate-default-automatic"]') as HTMLInputElement | null;
  const roomTick = () => document.querySelector('[data-attr="listing-v2-price-prorate-room-automatic"]') as HTMLInputElement | null;
  const addParking = () => {
    fireEvent.click(document.querySelector('[data-attr="listing-v2-default-fee-add"]')!);
    fireEvent.change(screen.getByLabelText("Fee name"), { target: { value: "Parking" } });
    fireEvent.change(screen.getByLabelText("Parking amount"), { target: { value: "60" } });
  };

  it("asks on the lease types that can start mid-month, never on Month-to-Month", () => {
    render(<DryEditor />);
    goPricing();
    expect(defaultTick()).not.toBeNull();
    expect(defaultTick()!.checked).toBe(true);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-price-tab-Month-to-Month"]')!);
    expect(defaultTick()).toBeNull();
    fireEvent.click(document.querySelector('[data-attr="listing-v2-price-tab-Custom"]')!);
    expect(defaultTick()).not.toBeNull();
  });

  it("unticking Automatic on the Default card asks rent and each monthly fee per day; utilities only once there are any", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<DryEditor onChange={(s) => (latest = s)} />);
    goPricing();
    addParking();
    expect(screen.queryByLabelText("Rent per day for every room")).toBeNull();

    fireEvent.click(defaultTick()!);
    expect(latest!.houseDefaults?.prorateMethod).toBe("daily_rate");
    expect(latest!.rooms.map((r) => r.prorateMethod)).toEqual(["daily_rate", "daily_rate"]);
    const rentDay = screen.getByLabelText("Rent per day for every room") as HTMLInputElement;
    // The calendar split, rounded up, is the suggestion — never the answer.
    expect(rentDay.placeholder).toBe("37");
    expect(screen.getByLabelText("Parking per day for every room")).toBeTruthy();
    expect((screen.getByLabelText("Parking per day for every room") as HTMLInputElement).placeholder).toBe("2");
    // No utilities, nothing to split per day.
    expect(screen.queryByLabelText("Utilities per day for every room")).toBeNull();

    fireEvent.change(rentDay, { target: { value: "40" } });
    expect(latest!.houseDefaults?.dailyRentRate).toBe(40);
    expect(latest!.rooms.map((r) => r.dailyRentRate)).toEqual([40, 40]);

    fireEvent.change(screen.getByLabelText("Utilities for every room"), { target: { value: "150" } });
    expect((screen.getByLabelText("Utilities per day for every room") as HTMLInputElement).placeholder).toBe("5");

    // Ticking Automatic back keeps the numbers; only the rows fold away.
    fireEvent.click(defaultTick()!);
    expect(latest!.houseDefaults?.prorateMethod).toBe("auto");
    expect(latest!.houseDefaults?.dailyRentRate).toBe(40);
    expect(screen.queryByLabelText("Rent per day for every room")).toBeNull();
  });

  it("a room follows the Default card until it answers for itself, and Same as default room puts it back", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<DryEditor onChange={(s) => (latest = s)} />);
    goPricing();
    fireEvent.click(defaultTick()!);
    openPriceCard("Room A");
    expect(roomTick()!.checked).toBe(false);
    expect(screen.queryByRole("button", { name: /Reset partial months for Room A/ })).toBeNull();
    const card = document.querySelector('[data-attr="listing-v2-price-card"]')!;
    expect(card.textContent).toContain("partial months per day");

    fireEvent.click(roomTick()!);
    const roomA = () => latest!.rooms.find((r) => r.id === "r1")!;
    expect(roomA().prorateMethod).toBe("auto");
    expect(latest!.rooms.find((r) => r.id === "r2")!.prorateMethod).toBe("daily_rate");
    expect(screen.getByRole("button", { name: /Reset partial months for Room A/ })).toBeTruthy();
    expect(document.querySelector('[data-attr="listing-v2-price-card"]')!.textContent).toContain("partial months automatic");
    const same = () => document.querySelectorAll<HTMLInputElement>('[data-attr="listing-v2-price-same-as-all"]')[0]!;
    expect(same().checked).toBe(false);

    fireEvent.click(same());
    expect(roomA().prorateMethod).toBe("daily_rate");
    expect(same().checked).toBe(true);
    expect(screen.queryByRole("button", { name: /Reset partial months for Room A/ })).toBeNull();
  });

  it("the whole place asks the same way, and only while utilities are above $0", () => {
    function Whole({ onChange }: { onChange: (sub: ManagerListingSubmissionV1) => void }) {
      const [sub, setSub] = useState<ManagerListingSubmissionV1>(() => ({
        ...seeded(),
        listingPlaceCategoryId: "entire_home",
        rentalModelStamp: "entire_home",
        allowedLeaseTerms: ["Long-term"],
        rooms: [{ id: "r1", name: "Room A", monthlyRent: 3000 }],
        entireHomeMonthlyRent: 3000,
        entireHomeUtilitiesEstimate: "",
      }) as ManagerListingSubmissionV1);
      return <ListingEditorV2 title="Edit listing" submission={sub} onChange={(next) => { setSub(next); onChange(next); }} onClose={() => {}} onSaveExit={() => {}} onPublish={() => {}} />;
    }
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Whole onChange={(s) => (latest = s)} />);
    goPricing();
    expect(screen.queryByLabelText("Prorate a partial month")).toBeNull();
    const tick = document.querySelector('[data-attr="listing-v2-price-prorate-whole-automatic"]') as HTMLInputElement;
    expect(tick.checked).toBe(true);
    fireEvent.click(tick);
    expect(latest!.entireHomeProrateMethod).toBe("daily_rate");
    expect((screen.getByLabelText("Rent per day for the whole place") as HTMLInputElement).placeholder).toBe("100");
    expect(screen.queryByLabelText("Utilities per day for the whole place")).toBeNull();
    fireEvent.change(screen.getByLabelText("Utilities for the whole place"), { target: { value: "180" } });
    fireEvent.change(screen.getByLabelText("Utilities per day for the whole place"), { target: { value: "6" } });
    expect(latest!.entireHomeDailyUtilitiesRate).toBe(6);
  });
});
