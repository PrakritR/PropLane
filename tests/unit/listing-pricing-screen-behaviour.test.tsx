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

  it("draws no Default room card, and no Move-in fee row on a room card", () => {
    openPricing();
    expect(document.querySelector('[data-attr="listing-v2-price-defaults-card"]')).toBeNull();
    expect(screen.queryByText("Default room")).toBeNull();
    openPriceCard("Room A");
    expect(screen.queryByLabelText("Move-in fee")).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-price-move-in-fee"]')).toBeNull();
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

describe("a room's numbers stay on that room", () => {
  it("typing Room A does not rewrite Room B, and long-term has no Reset back to a Default room", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Editor onChange={(s) => (latest = s)} />);
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    fireEvent.click(
      Array.from(nav.querySelectorAll("button")).find((b) => /rent|pricing|deposit/i.test(b.textContent ?? ""))!,
    );

    openPriceCard("Room A");
    expect(screen.queryByRole("button", { name: /Reset utilities for Room A/i })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Room A utilities on/i), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText(/Room A deposit on/i), { target: { value: "900" } });

    const roomA = (latest?.rooms ?? []).find((r) => r.id === "r1");
    const roomB = (latest?.rooms ?? []).find((r) => r.id === "r2");
    expect(roomA?.utilitiesEstimate).toBe("0");
    expect(roomA?.securityDeposit).toBe("900");
    expect(roomB?.utilitiesEstimate).toBe("150");
    expect(screen.queryByRole("button", { name: /Reset utilities for Room A/i })).toBeNull();
  });
});

describe("other fees live on the pricing cards", () => {
  function pricing(onChange: (s: ManagerListingSubmissionV1) => void) {
    render(<Editor onChange={onChange} />);
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    fireEvent.click(Array.from(nav.querySelectorAll("button")).find((b) => /pricing/i.test(b.textContent ?? ""))!);
  }

  it("a fee added on a room is that room's, on the lease types only", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    pricing((s) => (latest = s));
    expect(document.querySelector('[data-attr="listing-v2-price-defaults-more"]')).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-price-more"]')).toBeNull();

    openPriceCard("Room A");
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-fee-add"]')!);
    const fee = (latest?.customFees ?? []).find((f) => (f as { presetId?: string }).presetId === "custom");
    expect(fee).toBeTruthy();
    expect(fee?.roomIds).toEqual(["r1"]);
    expect(fee?.leaseTypes).toBeUndefined();

    fireEvent.change(screen.getByLabelText("Fee name"), { target: { value: "Cleaning" } });
    fireEvent.change(screen.getByLabelText("Cleaning amount for Room A"), { target: { value: "120" } });
    expect((screen.getByLabelText("Cleaning amount for Room A") as HTMLInputElement).value).toBe("120");
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-fee-add"]')!);
    const own = (latest?.customFees ?? []).filter((f) => (f as { presetId?: string }).presetId === "custom");
    expect(own).toHaveLength(2);
    expect(own.every((row) => row.roomIds?.[0] === "r1")).toBe(true);
  });

  it("typing a standard fee's name adopts the preset instead of a duplicate custom row", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    pricing((s) => (latest = s));
    openPriceCard("Room A");
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-fee-add"]')!);
    fireEvent.change(screen.getByLabelText("Fee name"), { target: { value: "Parking" } });
    const fees = latest?.customFees ?? [];
    expect(fees.some((f) => (f as { presetId?: string }).presetId === "custom")).toBe(false);
    expect(fees.some((f) => (f as { presetId?: string }).presetId === "parking_monthly")).toBe(true);
    fireEvent.change(screen.getByLabelText("Parking amount for Room A"), { target: { value: "50" } });
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

    openPriceCard("Room A");
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-fee-add"]')!);
    fireEvent.change(screen.getByLabelText("Fee name"), { target: { value: "Gym" } });
    fireEvent.change(screen.getByLabelText("Gym amount for Room A"), { target: { value: "40" } });
    const gym = (latest?.customFees ?? []).find((f) => f.label === "Gym");
    expect(gym?.leaseTypes).toEqual(["Long-term", "Month-to-Month", "Custom"]);
    expect(gym?.roomIds).toEqual(["r1"]);

    fireEvent.click(document.querySelector('[data-attr="listing-v2-price-tab-Short-Term Stay"]')!);
    expect(screen.queryByLabelText("Gym amount for Room A")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Room A stay prices" }));
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-fee-add"]')!);
    fireEvent.change(screen.getByLabelText("Fee name"), { target: { value: "Cleaning" } });
    fireEvent.change(screen.getByLabelText("Cleaning amount for Room A"), { target: { value: "120" } });
    const cleaning = (latest?.customFees ?? []).find((f) => f.label === "Cleaning");
    expect(cleaning?.leaseTypes).toEqual(["Short-Term Stay"]);
    expect(cleaning?.frequency).toBe("one-time");

    fireEvent.click(document.querySelector('[data-attr="listing-v2-price-tab-Long-term"]')!);
    openPriceCard("Room A");
    expect(screen.queryByLabelText("Cleaning amount for Room A")).toBeNull();
    expect(screen.getByLabelText("Gym amount for Room A")).toBeTruthy();
  });
});

describe("a lease type can have its own room prices", () => {
  const MTM = "Month-to-Month";
  const goToMonthToMonth = () => {
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    fireEvent.click(Array.from(nav.querySelectorAll("button")).find((b) => /pricing/i.test(b.textContent ?? ""))!);
    fireEvent.click(document.querySelector(`[data-attr="listing-v2-price-tab-${MTM}"]`)!);
  };
  const sameAsLongTerm = () => document.querySelector(`[data-attr="listing-v2-same-as-long-term-${MTM}"]`) as HTMLInputElement;

  it("Month-to-Month follows long-term until a room writes its own number", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Editor onChange={(s) => (latest = s)} />);
    goToMonthToMonth();
    expect(sameAsLongTerm().checked).toBe(true);
    expect(document.querySelector('[data-attr="listing-v2-price-defaults-card"]')).toBeNull();
    openPriceCard("Room A");
    const rent = screen.getByLabelText(`Room A rent on ${MTM}`) as HTMLInputElement;
    expect(rent.value).toBe("");
    expect(rent.placeholder).toBe("1100");
    fireEvent.change(rent, { target: { value: "1050" } });
    expect(sameAsLongTerm().checked).toBe(false);
    expect(latest!.rooms.find((r) => r.id === "r1")!.termPricing?.[MTM]?.monthlyRent).toBe(1050);
    expect(latest!.rooms.find((r) => r.id === "r2")!.termPricing?.[MTM]).toBeUndefined();
    expect(latest!.rooms.map((r) => r.monthlyRent)).toEqual([1100, 1100]);
  });

  it("a room with its own Month-to-Month number keeps it when another room changes", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Editor onChange={(s) => (latest = s)} />);
    goToMonthToMonth();
    openPriceCard("Room A");
    fireEvent.change(screen.getByLabelText(`Room A rent on ${MTM}`), { target: { value: "1050" } });
    fireEvent.click(screen.getByRole("button", { name: "Close Room A prices" }));
    openPriceCard("Room B");
    fireEvent.change(screen.getByLabelText(`Room B rent on ${MTM}`), { target: { value: "1250" } });

    const byId = (id: string) => latest!.rooms.find((r) => r.id === id)!;
    expect(byId("r1").termPricing?.[MTM]?.monthlyRent).toBe(1050);
    expect(byId("r2").termPricing?.[MTM]?.monthlyRent).toBe(1250);
  });

  it("ticking Same as long-term again wipes every room's own price on that term", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<Editor onChange={(s) => (latest = s)} />);
    goToMonthToMonth();
    openPriceCard("Room A");
    fireEvent.change(screen.getByLabelText(`Room A rent on ${MTM}`), { target: { value: "1050" } });
    expect(sameAsLongTerm().checked).toBe(false);
    fireEvent.click(sameAsLongTerm());

    expect(latest!.houseTermPricing).toBeUndefined();
    expect(latest!.rooms.map((r) => r.termPricing)).toEqual([undefined, undefined]);
    expect(sameAsLongTerm().checked).toBe(true);
  });

  it("shows a stored room override again on reopen", () => {
    function Stored() {
      const [sub, setSub] = useState<ManagerListingSubmissionV1>(() => ({
        ...seeded(),
        rooms: seeded().rooms.map((r) => ({ ...r, termPricing: { [MTM]: { monthlyRent: 1050, securityDeposit: "750" } } })),
      }));
      return <ListingEditorV2 title="Edit listing" submission={sub} onChange={setSub} onClose={() => {}} onSaveExit={() => {}} onPublish={() => {}} />;
    }
    render(<Stored />);
    goToMonthToMonth();
    expect(sameAsLongTerm().checked).toBe(false);
    openPriceCard("Room A");
    expect((screen.getByLabelText(`Room A rent on ${MTM}`) as HTMLInputElement).value).toBe("1050");
    expect((screen.getByLabelText(`Room A deposit on ${MTM}`) as HTMLInputElement).value).toBe("750");
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
  const roomTick = () => document.querySelector('[data-attr="listing-v2-price-prorate-room-automatic"]') as HTMLInputElement | null;
  const addParkingOnRoom = () => {
    fireEvent.click(document.querySelector('[data-attr="listing-v2-room-fee-add"]')!);
    fireEvent.change(screen.getByLabelText("Fee name"), { target: { value: "Parking" } });
    fireEvent.change(screen.getByLabelText("Parking amount for Room A"), { target: { value: "60" } });
  };
  const pickSameAs = (who: string, sourceId: string) => {
    const trigger = screen.getByRole("button", { name: `Same as for ${who}` });
    if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
    const option = document.getElementById(trigger.getAttribute("aria-controls")!)!.querySelector(`[data-field-select-option-value="${sourceId}"]`)!;
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
  };

  it("asks on the lease types that can start mid-month, never on Month-to-Month", () => {
    render(<DryEditor />);
    goPricing();
    openPriceCard("Room A");
    expect(roomTick()).not.toBeNull();
    expect(roomTick()!.checked).toBe(true);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-price-tab-Month-to-Month"]')!);
    expect(roomTick()).toBeNull();
    fireEvent.click(document.querySelector('[data-attr="listing-v2-price-tab-Custom"]')!);
    expect(roomTick()).not.toBeNull();
  });

  it("unticking Automatic on a room asks rent and each monthly fee per day; utilities only once there are any", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<DryEditor onChange={(s) => (latest = s)} />);
    goPricing();
    openPriceCard("Room A");
    addParkingOnRoom();
    expect(screen.queryByLabelText("Rent per day for Room A")).toBeNull();

    fireEvent.click(roomTick()!);
    expect(latest!.rooms.find((r) => r.id === "r1")!.prorateMethod).toBe("daily_rate");
    expect(latest!.rooms.find((r) => r.id === "r2")!.prorateMethod).toBeFalsy();
    const rentDay = screen.getByLabelText("Rent per day for Room A") as HTMLInputElement;
    expect(rentDay.placeholder).toBe("37");
    expect(screen.getByLabelText("Parking per day for Room A")).toBeTruthy();
    expect((screen.getByLabelText("Parking per day for Room A") as HTMLInputElement).placeholder).toBe("2");
    expect(screen.queryByLabelText("Utilities per day for Room A")).toBeNull();

    fireEvent.change(rentDay, { target: { value: "40" } });
    expect(latest!.rooms.find((r) => r.id === "r1")!.dailyRentRate).toBe(40);
    expect(latest!.rooms.find((r) => r.id === "r2")!.dailyRentRate).toBeFalsy();

    fireEvent.change(screen.getByLabelText(/Room A utilities on/i), { target: { value: "150" } });
    expect((screen.getByLabelText("Utilities per day for Room A") as HTMLInputElement).placeholder).toBe("5");

    fireEvent.click(roomTick()!);
    expect(latest!.rooms.find((r) => r.id === "r1")!.prorateMethod).toBe("auto");
    expect(latest!.rooms.find((r) => r.id === "r1")!.dailyRentRate).toBe(40);
    expect(screen.queryByLabelText("Rent per day for Room A")).toBeNull();
  });

  it("Same as Room X copies partial-month settings onto the other room", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    render(<DryEditor onChange={(s) => (latest = s)} />);
    goPricing();
    openPriceCard("Room A");
    fireEvent.click(roomTick()!);
    fireEvent.change(screen.getByLabelText("Rent per day for Room A"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Close Room A prices" }));
    openPriceCard("Room B");
    pickSameAs("Room B", "r1");
    expect(latest!.rooms.find((r) => r.id === "r2")!.prorateMethod).toBe("daily_rate");
    expect(latest!.rooms.find((r) => r.id === "r2")!.dailyRentRate).toBe(40);
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
