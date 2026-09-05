import { describe, expect, it } from "vitest";
import {
  applicationListHref,
  legacyManagerPortalSectionPath,
  managerDocumentsApplicationDetailHref,
  managerDocumentsApplicationsListHref,
  propertyListHref,
  propertyTourDetailHref,
  propertyTourListHref,
  residentDocumentsApplicationDetailHref,
  residentDocumentsApplicationListHref,
} from "@/lib/portal-detail-routes";

describe("portal-detail-routes href helpers", () => {
  const base = "/portal";

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
