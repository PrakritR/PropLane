import { describe, expect, it } from "vitest";
import {
  applicationListHref,
  managerBookingListHref,
  LEGACY_MANAGER_BOOKING_BUCKET_REDIRECTS,
  parseManagerBookingBucket,
  legacyManagerPortalSectionPath,
  managerDocumentsApplicationDetailHref,
  managerDocumentsApplicationsListHref,
  propertyListHref,
  propertyTourDetailHref,
  propertyTourListHref,
  residentDocumentsApplicationDetailHref,
  residentDocumentsApplicationListHref,
  vendorCalendarHref,
} from "@/lib/portal-detail-routes";

describe("portal-detail-routes href helpers", () => {
  const base = "/portal";

  it("sends the retired Stays and Occupancy URLs to Calendar; the other tabs are unchanged", () => {
    expect(parseManagerBookingBucket("stays")).toBe("calendar");
    expect(parseManagerBookingBucket("occupancy")).toBe("calendar");
    expect(LEGACY_MANAGER_BOOKING_BUCKET_REDIRECTS).toEqual({ stays: "calendar", occupancy: "calendar" });
    for (const view of ["upcoming", "inhouse", "past"] as const) {
      expect(parseManagerBookingBucket(view)).toBe(view);
      expect(managerBookingListHref(base, view)).toBe(`/portal/bookings/${view}`);
    }
  });

  it("builds property stage list URLs from the portal root", () => {
    expect(propertyListHref(base, "drafts")).toBe("/portal/properties/drafts");
    expect(propertyListHref(base, "listed")).toBe("/portal/properties/listed");
  });

  it("builds application bucket list URLs from the portal root", () => {
    expect(applicationListHref(base, "approved")).toBe("/portal/applications/approved");
    expect(applicationListHref(base, "pending")).toBe("/portal/applications/pending");
  });

  it("redirects mistaken top-level segments to routed section paths", () => {
    expect(legacyManagerPortalSectionPath("drafts")).toBe("properties/drafts");
    expect(legacyManagerPortalSectionPath("approved")).toBe("applications/approved");
    expect(legacyManagerPortalSectionPath("manager")).toBe("leases/manager");
    expect(legacyManagerPortalSectionPath("dashboard")).toBeNull();
  });

  it("vendor Calendar is one view at the bare route", () => {
    expect(vendorCalendarHref("/vendor")).toBe("/vendor/calendar");
  });

  it("builds property-scoped tour bucket URLs", () => {
    expect(propertyTourListHref(base, "listed", "mgr-scale-06", "pending")).toBe(
      "/portal/properties/listed/mgr-scale-06/tours/pending",
    );
    expect(propertyTourListHref(base, "listed", "mgr-scale-06", "upcoming")).toBe(
      "/portal/properties/listed/mgr-scale-06/tours/upcoming",
    );
    expect(
      propertyTourDetailHref(base, "listed", "mgr-scale-06", "pending", "tour-abc"),
    ).toBe("/portal/properties/listed/mgr-scale-06/tours/pending/tour-abc");
  });

  it("builds documents application detail URLs", () => {
    expect(managerDocumentsApplicationsListHref(base)).toBe("/portal/documents/applications");
    expect(managerDocumentsApplicationDetailHref(base, "APP-1")).toBe(
      "/portal/documents/applications/APP-1",
    );
    expect(residentDocumentsApplicationListHref("/resident")).toBe("/resident/documents/application");
    expect(residentDocumentsApplicationDetailHref("/resident", "APP-1")).toBe(
      "/resident/documents/application/APP-1",
    );
  });
});
