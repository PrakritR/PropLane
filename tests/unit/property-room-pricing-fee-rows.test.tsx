// @vitest-environment jsdom
//
// The room pricing popup (property Pricing tab -> Edit pricing): Month-to-month surcharge, Custom start
// surcharge and Partial months follow the lease types the room is OFFERED on, and Application fee / Lease fee
// sit on the step they belong to (captain, Oct 3).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

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

describe("Application fee and Lease fee per section", () => {
  it("the Long-term section and the Short-term section each bind their own boxes, on one screen", () => {
    const sub = listing({
      occupancyPrices: [{ count: 1, applicationFee: "50", leaseFee: "100", shortTermApplicationFee: "20", shortTermLeaseFee: "40" }],
    });
    open(sub);
    const lt = screen.getByLabelText("Private room long-term lease fee") as HTMLInputElement;
    expect(lt.value).toBe("100");
    expect((screen.getByLabelText("Private room long-term application fee") as HTMLInputElement).value).toBe("50");

    // No tab or step to click: the Short-term section is already on the page.
    expect((screen.getByLabelText("Private room short term lease fee") as HTMLInputElement).value).toBe("40");
    expect((screen.getByLabelText("Private room short term application fee") as HTMLInputElement).value).toBe("20");
  });
});

describe("the pricing popup is one screen", () => {
  it("lists Long-term and Short-term as sections, never as steps; custom dates and month-to-month have no section", () => {
    open(listing());
    const section = (id: string) => document.querySelector(`[data-attr="property-pricing-section-${id}"]`);
    expect(section("long")).not.toBeNull();
    expect(section("short")).not.toBeNull();
    expect(within(section("long") as HTMLElement).getByRole("heading", { name: "Long-term" })).toBeTruthy();
    expect(within(section("short") as HTMLElement).getByRole("heading", { name: "Short-term" })).toBeTruthy();
    // One wizard step, so the rail has no Long-term -> Short-term walk.
    expect(document.querySelector('[data-attr="listing-v2-rail-Long-term"]')).toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-rail-Short-Term Stay"]')).toBeNull();
    expect(screen.queryAllByRole("button", { name: /^Custom/ })).toHaveLength(0);
  });

  it("has a single Save and no Step n of n counter", () => {
    open(listing());
    expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Continue/ })).toBeNull();
    // The footer counter (the phone step picker is the wizard primitives' own control).
    expect(
      screen.queryAllByText(/Step \d+ of \d+/).filter((node) => !node.closest('[data-attr="workspace-step-picker"]')),
    ).toHaveLength(0);
  });

  it("leaves the Short-term section out when short stays are not offered", () => {
    open(listing({}, { shortTermRentalsAllowed: false, allowedLeaseTerms: ["Long-term"] }));
    expect(document.querySelector('[data-attr="property-pricing-section-short"]')).toBeNull();
    expect(document.querySelector('[data-attr="property-pricing-section-long"]')).not.toBeNull();
  });
});

describe("stay-type sections", () => {
  it("keeps the month-to-month and custom-start surcharges on the Long-term section", () => {
    open(listing());
    expect(rowLabel("Month-to-month surcharge").length).toBeGreaterThan(0);
    expect(rowLabel("Custom start surcharge").length).toBeGreaterThan(0);
  });
});
