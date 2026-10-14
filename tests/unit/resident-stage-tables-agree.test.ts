import { describe, expect, it } from "vitest";
import {
  RESIDENT_BOTTOM_NAV_PRIMARY,
  isResidentPathAllowedForAccess,
  residentBottomNavPrimarySections,
  residentPortalHomePath,
  residentSectionLockedForStage,
  residentSectionUnlockedForStage,
  resolveResidentPortalNavStage,
  type ResidentPortalNavStage,
} from "@/lib/resident-portal-nav";
import {
  RESIDENT_CONDITIONAL_SECTION_IDS,
  RESIDENT_RENDERED_SECTION_IDS,
  RESIDENT_UNIFIED_PORTAL_SECTIONS,
  withoutConditionalResidentSections,
} from "@/lib/portals/resident-sections";
import { portalNavLockKind } from "@/lib/portals/nav-locks";
import { PORTAL_NAV_GROUPS } from "@/lib/portals/nav-groups";
import { NATIVE_BOTTOM_NAV_RESIDENT_ORDER, splitNativeBottomNavItems } from "@/lib/native/portal-bottom-nav";
import { routeResolves } from "../helpers/route-resolves";

const STAGES = Object.keys(RESIDENT_BOTTOM_NAV_PRIMARY) as ResidentPortalNavStage[];

const none = { leaseAccessUnlocked: false, applicationApproved: false, hasCompletedApplicationSubmission: false };
const submitted = { ...none, hasCompletedApplicationSubmission: true };
const approved = { ...submitted, applicationApproved: true };
const signed = { ...approved, leaseAccessUnlocked: true };

describe("Stays across the resident stage tables", () => {
  it("is open at every stage, so no lifecycle stage can lock a guest out of their own stays", () => {
    expect(STAGES.length).toBeGreaterThanOrEqual(7);
    for (const stage of STAGES) {
      expect({ stage, unlocked: residentSectionUnlockedForStage("stays", stage) }).toEqual({ stage, unlocked: true });
      expect(portalNavLockKind({ kind: "resident", section: "stays", subscriptionTier: undefined, residentNavStage: stage })).toBe("none");
    }
  });

  it("every bottom-bar tab is unlocked at its own stage (the invariant the tables share)", () => {
    for (const stage of STAGES) {
      for (const section of residentBottomNavPrimarySections(stage)) {
        expect({ stage, section, locked: residentSectionLockedForStage(section, stage) }).toEqual({ stage, section, locked: false });
      }
    }
  });

  it("a guest whose only history is a stay gets the Stays, Payments, Messages bar", () => {
    const guest = { ...none, hasStays: true };
    expect(resolveResidentPortalNavStage(guest)).toBe("short_stay_guest");
    expect(residentBottomNavPrimarySections("short_stay_guest")).toEqual(["stays", "payments", "dashboard", "communication"]);
    // Payments carries the stay's charge, so it is open for them although they never applied.
    expect(residentSectionUnlockedForStage("payments", "short_stay_guest")).toBe(true);
    // The native bar is derived from the one table, never copied.
    const items = withoutConditionalResidentSections(RESIDENT_UNIFIED_PORTAL_SECTIONS).concat(
      RESIDENT_UNIFIED_PORTAL_SECTIONS.filter((s) => s.section === "stays"),
    );
    const split = splitNativeBottomNavItems(items, "resident", "short_stay_guest");
    expect(split.primary.map((i) => i.section)).toEqual(["stays", "payments", "dashboard", "communication"]);
  });

  it("an applicant, a booking resident and a signed resident keep their own stage even when they have stays", () => {
    expect(resolveResidentPortalNavStage({ ...submitted, hasStays: true })).toBe("application_submitted");
    expect(resolveResidentPortalNavStage({ ...approved, hasStays: true })).toBe("post_approval_pre_lease");
    expect(resolveResidentPortalNavStage({ ...signed, hasStays: true })).toBe("post_lease");
    expect(resolveResidentPortalNavStage({ ...none, isBookingResidency: true, hasStays: true })).toBe("booking_residency");
  });

  it("the Stays URL loads for an account with a stay row at every stage and is refused otherwise", () => {
    for (const access of [none, submitted, approved, signed]) {
      expect(isResidentPathAllowedForAccess("/resident/stays/upcoming", { ...access, hasStays: true })).toBe(true);
      expect(isResidentPathAllowedForAccess("/resident/stays/upcoming", access)).toBe(false);
      expect(isResidentPathAllowedForAccess("/resident/stays", { ...access, hasStays: false })).toBe(false);
    }
  });

  it("a guest with only stays lands on them after a sign-in link", () => {
    expect(residentPortalHomePath({ ...none, hasTourLink: false, hasSubmittedApplication: false, hasStays: true })).toBe("/resident/stays");
    expect(residentPortalHomePath({ ...none, hasTourLink: false, hasSubmittedApplication: false })).toBe("/resident/applications/apply");
    expect(residentPortalHomePath({ ...approved, hasTourLink: false, hasSubmittedApplication: true, hasStays: true })).toBe("/resident/dashboard");
  });

  it("is a registered, rendered, grouped, ordered and routable section", () => {
    expect(RESIDENT_UNIFIED_PORTAL_SECTIONS.find((s) => s.section === "stays")).toMatchObject({ label: "Stays", tabs: [] });
    expect(RESIDENT_RENDERED_SECTION_IDS as readonly string[]).toContain("stays");
    expect(PORTAL_NAV_GROUPS.resident.flatMap((g) => g.sections)).toContain("stays");
    expect(NATIVE_BOTTOM_NAV_RESIDENT_ORDER as readonly string[]).toContain("stays");
    expect(RESIDENT_CONDITIONAL_SECTION_IDS as readonly string[]).toEqual(["stays"]);
    // Route precedence: nothing in the app tree shadows it, and the section tabs resolve.
    expect(routeResolves("/resident/stays")).toBe(true);
    expect(routeResolves("/resident/stays/upcoming")).toBe(true);
    expect(routeResolves("/resident/stays/past")).toBe(true);
  });

  it("is drawn only for an account that has stays", () => {
    expect(withoutConditionalResidentSections(RESIDENT_UNIFIED_PORTAL_SECTIONS).map((s) => s.section)).not.toContain("stays");
    expect(RESIDENT_UNIFIED_PORTAL_SECTIONS.map((s) => s.section)).toContain("stays");
  });
});
