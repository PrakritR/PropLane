import { describe, expect, it } from "vitest";
import {
  residentBrowseFromApplicationHref,
  residentBrowseFromAuthHref,
  residentCreateAccountHref,
  residentPortalPublicHref,
  residentSignInHref,
} from "@/lib/resident-public-nav";

describe("residentBrowseFromAuthHref", () => {
  it("points at public browse with auth return marker", () => {
    expect(residentBrowseFromAuthHref()).toBe("/rent/browse?from=auth");
  });
});

describe("residentBrowseFromApplicationHref", () => {
  it("includes application return path for browse back navigation", () => {
    expect(residentBrowseFromApplicationHref("/resident/applications/apply?propertyId=abc")).toBe(
      "/rent/browse?from=application&return=%2Fresident%2Fapplications%2Fapply%3FpropertyId%3Dabc",
    );
  });
});

describe("residentSignInHref", () => {
  it("embeds link_tour in next so post-auth routing reaches the resident layout", () => {
    const href = residentSignInHref("/rent/tours-contact", { tourInquiryId: "inq-abc-123" });
    expect(href).toContain("intent=resident");
    expect(href).toContain(
      `next=${encodeURIComponent("/resident/tour?link_tour=inq-abc-123")}`,
    );
  });
});

describe("residentCreateAccountHref", () => {
  it("includes tour inquiry, name, and phone prefill params", () => {
    expect(
      residentCreateAccountHref("/resident/tour", {
        email: "alex@example.com",
        fullName: "Alex Guest",
        phone: "(206) 555-0100",
        tourInquiryId: "inq-1",
      }),
    ).toContain("mode=create");
    expect(
      residentCreateAccountHref("/resident/tour", {
        email: "alex@example.com",
        fullName: "Alex Guest",
        phone: "(206) 555-0100",
        tourInquiryId: "inq-1",
      }),
    ).toContain("email=alex%40example.com");
    expect(
      residentCreateAccountHref("/resident/tour", {
        email: "alex@example.com",
        fullName: "Alex Guest",
        phone: "(206) 555-0100",
        tourInquiryId: "inq-1",
      }),
    ).toContain("phone=%28206%29+555-0100");
    expect(
      residentCreateAccountHref("/resident/tour", {
        email: "alex@example.com",
        fullName: "Alex Guest",
        phone: "(206) 555-0100",
        tourInquiryId: "inq-1",
      }),
    ).toContain("tour_inquiry=inq-1");
    expect(
      residentCreateAccountHref("/resident/tour", {
        email: "alex@example.com",
        fullName: "Alex Guest",
        phone: "(206) 555-0100",
        tourInquiryId: "inq-1",
      }),
    ).toContain(encodeURIComponent("/resident/tour?link_tour=inq-1"));
  });
});

describe("residentPortalPublicHref", () => {
  it("sends signed-in residents to the portal", () => {
    expect(
      residentPortalPublicHref({ signedIn: true, isResident: true, nextPath: "/resident/applications/apply?propertyId=x" }),
    ).toBe("/resident/applications/apply?propertyId=x");
  });

  it("routes guests to resident sign-in", () => {
    expect(residentPortalPublicHref({ signedIn: false, isResident: false })).toBe(
      residentSignInHref("/resident/applications"),
    );
  });

  it("routes signed-in non-residents to resident create-account", () => {
    expect(residentPortalPublicHref({ signedIn: true, isResident: false })).toBe(
      residentCreateAccountHref("/resident/applications"),
    );
  });
});
