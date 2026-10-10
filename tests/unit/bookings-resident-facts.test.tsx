// @vitest-environment jsdom
/**
 * A manually added resident shows up on Bookings as a hold that carries the
 * resident's own facts: contact, rent, deposit, lease term. The row says what
 * they pay (not the room listing's rate), has no pills, and its ⋯ opens the
 * resident.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { applicationHoldEntries, leaseBookingEntries } from "@/lib/channel-calendar/property-bookings";
import { bookingRateLabel } from "@/lib/channel-calendar/booking-presentation";
import { bookingCharges, bookingOverdueTotal } from "@/lib/channel-calendar/booking-record";
import { bookingResidentHref } from "@/lib/channel-calendar/bookings-ui";
import { holdRowFromApplication } from "@/lib/occupancy/snapshot.server";
import type { HouseholdCharge } from "@/lib/household-charges";

const navigate = vi.fn();
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  // The room listing says $900 for Room 2; the resident pays their own $1,100.
  return {
    ...actual,
    getPropertyById: () => ({
      listingSubmission: { rooms: [{ id: "r2", name: "Room 2", monthlyRent: 900, rentBasis: "monthly" }] },
    }),
  };
});

import { ManagerBookingsListView } from "@/components/portal/manager-bookings-list-view";

const PROPERTY = { id: "p1", label: "5259 Brooklyn Ave" };

// What the occupancy snapshot reads off a production row (row_data).
const dbRow = {
  id: "AXIS-MAN1",
  property_id: "p1",
  assigned_property_id: "p1",
  row_data: {
    bucket: "approved",
    name: "Manual Mo",
    email: "Mo@Example.test",
    manuallyAdded: true,
    signedMonthlyRent: 1100,
    assignedRoomChoice: "p1::r2",
    manualResidentDetails: {
      moveInDate: "2026-09-24",
      moveOutDate: "2026-12-31",
      phone: "+12065550100",
      securityDeposit: 500,
      leaseTerm: "3 months",
    },
  },
};

function holdEntry() {
  return applicationHoldEntries([holdRowFromApplication(dbRow)], {
    properties: [PROPERTY],
    roomLabelForId: (_p, r) => (r === "r2" ? "Room 2" : "Room"),
    isLeased: () => false,
    openEndedHorizonKey: "2028-10-09",
  })[0]!;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  navigate.mockClear();
});

describe("hold entries carry the resident's facts", () => {
  it("copies contact, rent, deposit, lease term and the application id", () => {
    expect(holdEntry()).toMatchObject({
      source: "hold",
      applicationId: "AXIS-MAN1",
      residentName: "Manual Mo",
      residentEmail: "mo@example.test",
      residentPhone: "+12065550100",
      monthlyRent: 1100,
      securityDeposit: 500,
      leaseTerm: "3 months",
      roomLabel: "Room 2",
    });
  });

  it("the rate label is the resident's own rent, falling back to the room listing only without one", () => {
    expect(bookingRateLabel(holdEntry())).toBe("$1,100/mo");
    expect(bookingRateLabel({ ...holdEntry(), monthlyRent: undefined })).not.toContain("1,100");
  });

  it("a lease linked to an application carries the same facts", () => {
    const entries = leaseBookingEntries(
      [
        {
          id: "lease-1",
          axisId: "AXIS-MAN1",
          propertyId: "p1",
          roomChoice: "p1::r2",
          residentName: "Manual Mo",
          residentEmail: "mo@example.test",
          status: "Fully Signed",
          fullySignedAt: "2026-09-01T00:00:00Z",
          externallySignedLease: true,
          application: { leaseStart: "2026-09-24", leaseEnd: "2026-12-31" },
        },
      ],
      {
        propertyId: "p1",
        propertyLabel: PROPERTY.label,
        roomLabelForId: () => "Room 2",
        openEndedHorizonKey: "2028-10-09",
        applicationForLease: () => holdRowFromApplication(dbRow),
      },
    );
    expect(entries[0]).toMatchObject({ source: "proplane", leaseId: "lease-1", applicationId: "AXIS-MAN1", monthlyRent: 1100 });
  });
});

describe("Bookings list row for a resident", () => {
  function renderRow() {
    return render(
      <ManagerBookingsListView
        entries={[holdEntry()]}
        bucket="inhouse"
        selectedKeys={new Set()}
        onToggleSelected={() => {}}
      />,
    );
  }

  it("is name · place · dates and status facts · rent figure, with no Badge or pill", () => {
    const view = renderRow();
    const row = view.container.querySelector(".portal-property-row")!;
    expect(row.textContent).toContain("Manual Mo");
    expect(row.textContent).toContain("5259 Brooklyn Ave");
    expect(row.textContent).toContain("Room 2");
    const facts = row.querySelector("[data-attr='record-row-facts']")!.textContent;
    expect(facts).toContain("Sep 24 – Dec 31, 2026");
    expect(facts).toContain("In-house");
    expect(row.textContent).toContain("$1,100/mo");
    expect(view.container.querySelector("[class*='badge']")).toBeNull();
  });

  it("⋯ offers Open resident, which goes to the resident record", () => {
    renderRow();
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Manual Mo" }), { key: "ArrowDown" });
    const menu = document.body.querySelector('[data-attr="record-actions-menu"]')!;
    expect(menu.textContent).toContain("Open resident");
    fireEvent.click(menu.querySelector('[data-record-action-id="open-resident"]')!);
    expect(navigate).toHaveBeenCalledWith(bookingResidentHref(holdEntry(), "/portal", "2026-10-09"));
    expect(navigate.mock.calls[0]![0]).toContain("/residents/current/AXIS-MAN1/overview");
  });

  it("a booking with no application behind it has no Open resident", () => {
    expect(bookingResidentHref({ ...holdEntry(), applicationId: undefined }, "/portal", "2026-10-09")).toBeNull();
  });
});

describe("Payments tab charges", () => {
  const charge = (over: Partial<HouseholdCharge>) =>
    ({
      id: "c1",
      residentEmail: "mo@example.test",
      residentName: "Manual Mo",
      propertyId: "p1",
      status: "pending",
      amountLabel: "$1,100.00",
      balanceLabel: "$1,100.00",
      dueDateLabel: "9/1/2026",
      ...over,
    }) as unknown as HouseholdCharge;

  it("matches by application id OR resident email at this house, and totals what is overdue", () => {
    const byApplication = charge({ id: "a", applicationId: "AXIS-MAN1", residentEmail: "" });
    const byEmail = charge({ id: "b", residentEmail: "MO@example.test" });
    const otherHouse = charge({ id: "c", propertyId: "p2" });
    const stranger = charge({ id: "d", residentEmail: "x@example.test" });
    const matched = bookingCharges(holdEntry(), [byApplication, byEmail, otherHouse, stranger]);
    expect(matched.map((item) => item.id)).toEqual(["a", "b"]);
    expect(bookingOverdueTotal(matched, new Date("2026-10-09T12:00:00"))).toBe(2200);
    expect(bookingOverdueTotal(matched, new Date("2026-08-01T12:00:00"))).toBe(0);
  });

  it("a booking with neither id nor email has no charges", () => {
    expect(bookingCharges({ propertyId: "p1" }, [charge({})])).toEqual([]);
  });
});
