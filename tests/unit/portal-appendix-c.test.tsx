// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import {
  parsePropertyDetailTab,
  parseResidentDetailTab,
  parseCalendarViewTab,
  parseTeamLinkTab,
  parseApplicationBucket,
  parseLeasePipelineTab,
  parsePaymentDirection,
  parsePaymentBucket,
  parseServiceRequestBucket,
  parseWorkOrderBucket,
  PROPERTY_DETAIL_TABS,
  PROPERTY_DETAIL_TAB_LABELS,
  PROPERTY_DETAIL_SCOPE_LABELS,
  propertyDetailHref,
  propertyDetailTopNavId,
  residentDetailHref,
  managerResidentItemDetailHref,
  managerResidentTourDetailHref,
  managerResidentTourListHref,
  residentPaymentDetailHref,
  calendarViewHref,
  bookingsHref,
  teamLinkHref,
  teamMemberDetailHref,
  applicationDetailHref,
  applicationListHref,
  backgroundCheckListHref,
  backgroundCheckDetailHref,
  parseBackgroundCheckListTab,
  leaseDetailHref,
  leaseListHref,
  paymentDetailHref,
  paymentListHref,
  serviceRequestDetailHref,
  serviceRequestListHref,
  workOrderDetailHref,
  workOrderListHref,
  promotionDetailHref,
  promotionListHref,
} from "@/lib/portal-detail-routes";

// Same race as manager-portal-primitives.test.tsx: DestinationNav via next/link
// keeps scheduling work after act(), and a leftover tree loses to jsdom teardown
// with "ReferenceError: window is not defined".
afterEach(cleanup);

describe("portal-detail-routes", () => {
  it("parses property detail tabs with preview fallback", () => {
    expect(parsePropertyDetailTab("lease")).toBe("lease");
    expect(parsePropertyDetailTab("promotion")).toBe("promotion");
    expect(parsePropertyDetailTab("calendar")).toBe("tours");
    expect(parsePropertyDetailTab("tour-calendar")).toBe("tours");
    expect(parsePropertyDetailTab("booking-calendars")).toBe("tours");
    expect(parsePropertyDetailTab("bogus")).toBe("preview");
    expect(parsePropertyDetailTab(undefined)).toBe("preview");
  });

  it("includes requests and promotion in PROPERTY_DETAIL_TABS", () => {
    expect(PROPERTY_DETAIL_TABS).toContain("promotion");
    expect(PROPERTY_DETAIL_TABS).toContain("requests");
    expect(PROPERTY_DETAIL_TABS).toContain("move-in");
    expect(PROPERTY_DETAIL_TABS).toContain("tours");
    expect(PROPERTY_DETAIL_TABS).not.toContain("calendar");
    expect(PROPERTY_DETAIL_TAB_LABELS.tours).toBe("Tours");
  });

  it("maps preview section tabs to their own top nav ids", () => {
    expect(propertyDetailTopNavId("preview")).toBe("preview");
    expect(propertyDetailTopNavId("house-details")).toBe("house-details");
    expect(propertyDetailTopNavId("move-in")).toBe("move-in");
    expect(PROPERTY_DETAIL_SCOPE_LABELS.preview).toBe("Listing");
  });

  it("parses resident detail tabs with application fallback", () => {
    expect(parseResidentDetailTab("payments")).toBe("payments");
    expect(parseResidentDetailTab("background-check")).toBe("background-check");
    expect(parseResidentDetailTab("application")).toBe("application");
    expect(parseResidentDetailTab("applicant")).toBe("application");
    expect(parseResidentDetailTab("")).toBe("application");
  });

  it("builds background check list hrefs", () => {
    expect(parseBackgroundCheckListTab("passed")).toBe("passed");
    expect(parseBackgroundCheckListTab("bogus")).toBe("pending_review");
    expect(backgroundCheckListHref("/portal", "flagged")).toBe("/portal/background-checks/flagged");
    expect(backgroundCheckDetailHref("/portal", "pending_review", "app-1")).toBe(
      "/portal/background-checks/pending_review/app-1",
    );
  });

  it("builds promotion detail hrefs", () => {
    expect(promotionListHref("/portal")).toBe("/portal/promotion");
    expect(promotionDetailHref("/portal", "row-1::flyer::entry-1")).toBe(
      "/portal/promotion/row-1%3A%3Aflyer%3A%3Aentry-1",
    );
  });

  it("builds encoded detail hrefs", () => {
    expect(propertyDetailHref("/portal", "listed", "mgr-foo bar", "preview")).toBe(
      "/portal/properties/listed/mgr-foo%20bar/preview",
    );
    expect(residentDetailHref("/portal", "current", "res-1", "lease")).toBe(
      "/portal/residents/current/res-1/lease",
    );
    expect(
      managerResidentItemDetailHref("/portal", "current", "res-1", "payments", "hc-1"),
    ).toBe("/portal/residents/current/res-1/payments/hc-1");
    expect(residentPaymentDetailHref("/portal", "current", "res-1", "hc-1")).toBe(
      "/portal/residents/current/res-1/payments/hc-1",
    );
    expect(managerResidentTourListHref("/portal", "current", "res-1", "upcoming")).toBe(
      "/portal/residents/current/res-1/tours/upcoming",
    );
    expect(managerResidentTourDetailHref("/portal", "current", "res-1", "pending", "tour-1")).toBe(
      "/portal/residents/current/res-1/tours/pending/tour-1",
    );
    expect(calendarViewHref("/portal", "availability")).toBe("/portal/calendar");
    expect(calendarViewHref("/portal", "bookings")).toBe("/portal/bookings/upcoming");
    expect(bookingsHref("/portal")).toBe("/portal/bookings/upcoming");
    expect(teamLinkHref("/portal", "linked")).toBe("/portal/teams/managers");
    expect(teamMemberDetailHref("/portal", "invite-abc")).toBe("/portal/teams/managers/invite-abc");
  });

  it("parses calendar and team routed tabs", () => {
    expect(parseCalendarViewTab("availability")).toBe("availability");
    expect(parseCalendarViewTab("bookings")).toBe("bookings");
    expect(parseCalendarViewTab("services")).toBe("availability");
    expect(parseCalendarViewTab("tours")).toBe("availability");
    expect(parseCalendarViewTab("all")).toBe("availability");
    expect(parseCalendarViewTab("")).toBe("availability");
    expect(parseCalendarViewTab("nonsense")).toBe("availability");
    expect(parseTeamLinkTab("linked")).toBe("linked");
    expect(parseTeamLinkTab(undefined)).toBe("pending");
  });

  it("parses and builds Appendix D5 manager detail routes", () => {
    expect(parseApplicationBucket("approved")).toBe("approved");
    expect(parseApplicationBucket("bogus")).toBe("pending");
    expect(parseLeasePipelineTab("signed")).toBe("signed");
    expect(parseLeasePipelineTab(undefined)).toBe("manager");
    expect(parsePaymentDirection("outgoing")).toBe("outgoing");
    expect(parsePaymentBucket("paid")).toBe("paid");
    expect(parseServiceRequestBucket("denied")).toBe("denied");
    expect(parseWorkOrderBucket("scheduled")).toBe("scheduled");

    expect(applicationListHref("/portal", "pending")).toBe("/portal/applications/pending");
    expect(applicationDetailHref("/portal", "pending", "AXIS-123")).toBe(
      "/portal/applications/pending/AXIS-123",
    );
    expect(leaseListHref("/portal", "manager")).toBe("/portal/leases/manager");
    expect(leaseDetailHref("/portal", "signed", "lease-1")).toBe("/portal/leases/signed/lease-1");
    expect(paymentListHref("/portal", "incoming", "overdue")).toBe("/portal/payments/incoming/overdue");
    expect(paymentDetailHref("/portal", "incoming", "pending", "chg-1")).toBe(
      "/portal/payments/incoming/pending/chg-1",
    );
    expect(serviceRequestListHref("/portal", "approved")).toBe("/portal/services/requests/approved");
    expect(serviceRequestDetailHref("/portal", "pending", "sr-1")).toBe(
      "/portal/services/requests/pending/sr-1",
    );
    expect(workOrderListHref("/portal", "open")).toBe("/portal/services/work-orders/open");
    expect(workOrderDetailHref("/portal", "completed", "wo-1")).toBe(
      "/portal/services/work-orders/completed/wo-1",
    );
    expect(applicationDetailHref("/portal", "pending", "mgr foo")).toBe(
      "/portal/applications/pending/mgr%20foo",
    );
    expect(applicationDetailHref("/portal", "pending", "AXIS-123", "background-check")).toBe(
      "/portal/applications/pending/AXIS-123/background-check",
    );
  });
});

describe("PortalListControlStack", () => {
  it("renders destinations, filter, and search slots (Appendix F band order)", () => {
    render(
      <PortalListControlStack
        filterRow={<span data-testid="filter">Filter</span>}
        destinations={[
          { id: "a", label: "Active", href: "/portal/x/a" },
          { id: "b", label: "Archived", href: "/portal/x/b" },
        ]}
        activeDestinationId="a"
        search={{
          value: "",
          onChange: () => {},
          placeholder: "Search items",
        }}
      />,
    );
    expect(screen.getByTestId("filter").textContent).toBe("Filter");
    expect(screen.getByRole("link", { name: /Active/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByPlaceholderText("Search items")).toBeTruthy();
  });

  it("composes destinations, action row, search, and filters in command mode", () => {
    const { container } = render(
      <PortalListControlStack
        variant="command"
        filterRow={<button type="button">Filter</button>}
        actions={
          <>
            <button type="button">Settings</button>
            <button type="button">Add</button>
          </>
        }
        destinations={[
          { id: "pending", label: "Pending", href: "/portal/tours/pending", count: 2 },
          { id: "past", label: "Past", href: "/portal/tours/past", count: 0 },
        ]}
        activeDestinationId="pending"
        search={{ value: "", onChange: () => {}, placeholder: "Search tours" }}
      />,
    );
    expect(container.querySelector('[data-variant="command"]')).toBeTruthy();
    expect(screen.getByRole("link", { name: /Pending/ })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search tours" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filter" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    expect(container.querySelector('[data-attr="portal-list-command-actions"]')).toBeTruthy();
    expect(container.querySelector("[data-portal-list-destination-nav]")?.parentElement?.className).toMatch(
      /border-b/,
    );
  });
});

describe("PortalSectionActionRow", () => {
  it("renders primary actions and separated destructive group", () => {
    const { container } = render(
      <PortalSectionActionRow destructive={<button type="button">Delete</button>}>
        <button type="button">Edit</button>
      </PortalSectionActionRow>,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(container.querySelector("[data-slot=portal-section-action-row-destructive]")).toBeTruthy();
  });
});
