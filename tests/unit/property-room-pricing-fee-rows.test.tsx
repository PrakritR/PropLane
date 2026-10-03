// @vitest-environment jsdom
//
// The room pricing popup (property Pricing tab -> Edit pricing): Month-to-month surcharge, Custom start
// surcharge and Partial months follow the lease types the room is OFFERED on, and Application fee / Lease fee
// sit on the step they belong to (captain, Oct 3).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PropertyRoomPricingWorkspace } from "@/components/portal/property-room-pricing-workspace";
import {
  createDefaultListingSubmission,
  emptyRoom,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});

afterEach(() => cleanup());

function listing(
  roomOver: Partial<ManagerRoomSubmission> = {},
  subOver: Partial<ManagerListingSubmissionV1> = {},
): ManagerListingSubmissionV1 {
  return normalizeManagerListingSubmissionV1({
    ...createDefaultListingSubmission(),
    allowedLeaseTerms: ["Long-term", "Month-to-Month", "Custom"],
    shortTermRentalsAllowed: true,
    rooms: [{ ...emptyRoom(0), id: "room-7", name: "Room 7", monthlyRent: 800, ...roomOver }],
    ...subOver,
  });
}

function open(sub: ManagerListingSubmissionV1) {
  return render(
    <PropertyRoomPricingWorkspace
      open
      onClose={() => {}}
      subject={{ kind: "room", roomId: "room-7" }}
      sub={sub}
      saveTarget={{ mode: "pending", saveId: "t" }}
      managerUserId="mgr"
      propertyLabel="Test house"
      onSaved={() => {}}
      showToast={vi.fn()}
    />,
  );
}

const rowLabel = (name: string) => screen.queryAllByText(name);

describe("room pricing popup rows follow what the room offers", () => {
  it("shows both surcharges and Partial months when Month-to-month and Custom are offered", () => {
    open(listing());
    expect(rowLabel("Month-to-month surcharge").length).toBeGreaterThan(0);
    expect(rowLabel("Custom start surcharge").length).toBeGreaterThan(0);
    expect(rowLabel("Partial months").length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Fees$/)).toBeNull();
  });

  it("hides Custom start surcharge and Partial months when the room is not offered on Custom", () => {
    open(listing({ offeredLeaseTerms: ["Long-term", "Month-to-Month"] }));
    expect(rowLabel("Month-to-month surcharge").length).toBeGreaterThan(0);
    expect(rowLabel("Custom start surcharge")).toHaveLength(0);
    expect(rowLabel("Partial months")).toHaveLength(0);
  });

  it("hides the month-to-month surcharge when the room is not offered on Month-to-month", () => {
    open(listing({ offeredLeaseTerms: ["Long-term", "Custom"] }));
    expect(rowLabel("Month-to-month surcharge")).toHaveLength(0);
    expect(rowLabel("Custom start surcharge").length).toBeGreaterThan(0);
    expect(rowLabel("Partial months").length).toBeGreaterThan(0);
  });

  it("keeps Partial months out of a shared room's Long-term step unless Custom is offered", () => {
    open(listing({ occupancyCapacity: 2, offeredLeaseTerms: ["Long-term"] }));
    expect(rowLabel("Partial months")).toHaveLength(0);
  });
});

describe("Application fee and Lease fee per step", () => {
  it("the Long-term step and the Short term step each bind their own boxes", () => {
    const sub = listing({
      occupancyPrices: [{ count: 1, applicationFee: "50", leaseFee: "100", shortTermApplicationFee: "20", shortTermLeaseFee: "40" }],
    });
    open(sub);
    const lt = screen.getByLabelText("Private room long-term lease fee") as HTMLInputElement;
    expect(lt.value).toBe("100");
    expect((screen.getByLabelText("Private room long-term application fee") as HTMLInputElement).value).toBe("50");

    fireEvent.click(screen.getAllByRole("button", { name: /Short term/ })[0]!);
    expect((screen.getByLabelText("Private room short term lease fee") as HTMLInputElement).value).toBe("40");
    expect((screen.getByLabelText("Private room short term application fee") as HTMLInputElement).value).toBe("20");
    expect(screen.queryByLabelText("Private room long-term lease fee")).toBeNull();
  });
});
