// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  portalDashboardMobileHeaderLabel,
  portalMobileActiveSectionLabel,
  resolvePortalMobileBackTarget,
} from "@/lib/portal-mobile-back";
import type { PortalDefinition } from "@/lib/portal-types";
import { vendorPortal } from "@/lib/portals/vendor";

const residentPortal: PortalDefinition = {
  kind: "resident",
  basePath: "/resident",
  title: "Resident Portal",
  accent: "blue",
  sections: [
    { section: "dashboard", label: "Dashboard", tabs: [] },
    { section: "applications", label: "Applications", tabs: [] },
    { section: "payments", label: "Payments", tabs: [] },
    {
      section: "communication",
      label: "Communication",
      tabs: [
        { id: "unopened", label: "Unopened" },
        { id: "sent", label: "Sent" },
      ],
    },
    { section: "profile", label: "Settings", tabs: [] },
  ],
};

const managerPortal: PortalDefinition = {
  kind: "manager",
  basePath: "/portal",
  title: "Manager Portal",
  accent: "blue",
  sections: [
    { section: "dashboard", label: "Dashboard", tabs: [] },
    { section: "communication", label: "Communication", tabs: [] },
  ],
};

describe("resolvePortalMobileBackTarget", () => {
  it("returns null on dashboard", () => {
    expect(resolvePortalMobileBackTarget("/resident/dashboard", residentPortal)).toBeNull();
  });

  it("returns null from a top-level section (section title in the mobile bar)", () => {
    expect(resolvePortalMobileBackTarget("/resident/applications", residentPortal)).toBeNull();
  });

  it("hides dashboard back on early rental-application wizard steps", () => {
    const params = new URLSearchParams({ wizardStep: "2" });
    expect(resolvePortalMobileBackTarget("/resident/applications/apply", residentPortal, params)).toBeNull();
  });

  // The wizard no longer stamps `?wizardStep=1` on first mount — that write cost
  // a server round-trip and a skeleton frame every time a resident opened an
  // application link. Absence therefore MEANS step 1, and step 1 must keep
  // hiding the dashboard back action exactly as it did when the param was there.
  it("treats an absent wizardStep on the apply path as step 1", () => {
    expect(resolvePortalMobileBackTarget("/resident/applications/apply", residentPortal)).toBeNull();
    expect(
      resolvePortalMobileBackTarget("/resident/applications/apply", residentPortal, new URLSearchParams()),
    ).toBeNull();
    expect(
      resolvePortalMobileBackTarget(
        "/resident/applications/apply",
        residentPortal,
        new URLSearchParams({ propertyId: "mgr-alder" }),
      ),
    ).toBeNull();
  });

  it("returns dashboard from apply after step 3", () => {
    const params = new URLSearchParams({ wizardStep: "4" });
    expect(resolvePortalMobileBackTarget("/resident/applications/apply", residentPortal, params)).toEqual({
      href: "/resident/dashboard",
      label: "Dashboard",
    });
  });

  it("returns first communication email tab from a deeper email tab", () => {
    expect(resolvePortalMobileBackTarget("/resident/communication/email/sent", residentPortal)).toEqual({
      href: "/resident/communication/email/unopened",
      label: "Communication",
    });
  });

  it("returns null from the default communication email tab", () => {
    expect(resolvePortalMobileBackTarget("/resident/communication/email/unopened", residentPortal)).toBeNull();
  });

  it("returns sms all view from deeper resident sms bucket", () => {
    expect(resolvePortalMobileBackTarget("/resident/communication/sms/sent", residentPortal)).toEqual({
      href: "/resident/communication/sms/all",
      label: "Communication",
    });
  });

  it("returns sms all view from deeper manager sms bucket", () => {
    expect(resolvePortalMobileBackTarget("/portal/communication/sms/opened", managerPortal)).toEqual({
      href: "/portal/communication/sms/all",
      label: "Communication",
    });
  });

  it("returns null from communication sms all view", () => {
    expect(resolvePortalMobileBackTarget("/portal/communication/sms/all", managerPortal)).toBeNull();
  });

  it("returns null from legacy communication sms unopened bucket", () => {
    expect(resolvePortalMobileBackTarget("/portal/communication/sms/unopened", managerPortal)).toBeNull();
  });

  it("returns null for an alternate section tab (tab pills handle navigation)", () => {
    const portalWithResidents: PortalDefinition = {
      ...managerPortal,
      sections: [
        ...managerPortal.sections,
        {
          section: "residents",
          label: "Residents",
          tabs: [{ id: "current", label: "Current" }],
        },
      ],
    };
    expect(resolvePortalMobileBackTarget("/portal/residents/previous", portalWithResidents)).toBeNull();
  });

  it("returns null for the primary residents tab", () => {
    const portalWithResidents: PortalDefinition = {
      ...managerPortal,
      sections: [
        ...managerPortal.sections,
        {
          section: "residents",
          label: "Residents",
          tabs: [{ id: "current", label: "Current" }],
        },
      ],
    };
    expect(resolvePortalMobileBackTarget("/portal/residents/current", portalWithResidents)).toBeNull();
  });
});
describe("portalDashboardMobileHeaderLabel", () => {
  it("returns the dashboard label on the dashboard route", () => {
    expect(portalDashboardMobileHeaderLabel("/resident/dashboard", residentPortal)).toBe("Dashboard");
  });

  it("returns null on a non-dashboard section", () => {
    expect(portalDashboardMobileHeaderLabel("/resident/applications", residentPortal)).toBeNull();
  });

  it("returns null outside the portal's basePath", () => {
    expect(portalDashboardMobileHeaderLabel("/manager/dashboard", residentPortal)).toBeNull();
  });

  it("returns Dashboard for vendor portal dashboard route", () => {
    expect(portalDashboardMobileHeaderLabel("/vendor/dashboard", vendorPortal)).toBe("Dashboard");
  });
});


describe("resolvePortalMobileBackTarget on native shell", () => {
  beforeEach(() => {
    document.documentElement.setAttribute("data-native", "ios");
  });
  afterEach(() => {
    document.documentElement.removeAttribute("data-native");
  });

  it("suppresses dashboard back from a top-level section", () => {
    expect(resolvePortalMobileBackTarget("/resident/applications", residentPortal)).toBeNull();
  });

  it("still returns communication folder back targets", () => {
    expect(resolvePortalMobileBackTarget("/resident/communication/email/sent", residentPortal)).toEqual({
      href: "/resident/communication/email/unopened",
      label: "Communication",
    });
  });
});

describe("portalMobileActiveSectionLabel", () => {
  it("returns the section label off dashboard", () => {
    expect(portalMobileActiveSectionLabel("/resident/applications", residentPortal)).toBe("Applications");
  });

  it("returns null on dashboard", () => {
    expect(portalMobileActiveSectionLabel("/resident/dashboard", residentPortal)).toBeNull();
  });
});
