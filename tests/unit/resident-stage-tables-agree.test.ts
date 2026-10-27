import { existsSync } from "node:fs";
import { join } from "node:path";
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
import { RESIDENT_RENDERED_SECTION_IDS, RESIDENT_UNIFIED_PORTAL_SECTIONS } from "@/lib/portals/resident-sections";
import { portalNavLockKind } from "@/lib/portals/nav-locks";
import { PORTAL_NAV_GROUPS } from "@/lib/portals/nav-groups";
import { NATIVE_BOTTOM_NAV_RESIDENT_ORDER, splitNativeBottomNavItems } from "@/lib/native/portal-bottom-nav";
import { routeResolves } from "../helpers/route-resolves";

const STAGES = Object.keys(RESIDENT_BOTTOM_NAV_PRIMARY) as ResidentPortalNavStage[];

const none = { leaseAccessUnlocked: false, applicationApproved: false, hasCompletedApplicationSubmission: false };
const submitted = { ...none, hasCompletedApplicationSubmission: true };
const approved = { ...submitted, applicationApproved: true };
const signed = { ...approved, leaseAccessUnlocked: true };

describe("Short stays live inside Application across the resident stage tables", () => {
  it("Application is open at every stage, so no lifecycle stage can lock a guest out of their own stays", () => {
    expect(STAGES.length).toBeGreaterThanOrEqual(7);
    for (const stage of STAGES) {
      expect({ stage, unlocked: residentSectionUnlockedForStage("applications", stage) }).toEqual({ stage, unlocked: true });
      expect(portalNavLockKind({ kind: "resident", section: "applications", subscriptionTier: undefined, residentNavStage: stage })).toBe("none");
    }
  });

  it("every bottom-bar tab is unlocked at its own stage (the invariant the tables share)", () => {
    for (const stage of STAGES) {
      for (const section of residentBottomNavPrimarySections(stage)) {
        expect({ stage, section, locked: residentSectionLockedForStage(section, stage) }).toEqual({ stage, section, locked: false });
      }
    }
  });

  it("a guest whose only history is a stay gets the Application, Payments, Messages bar (no Stays tab)", () => {
    const guest = { ...none, hasStays: true };
    expect(resolveResidentPortalNavStage(guest)).toBe("short_stay_guest");
    expect(residentBottomNavPrimarySections("short_stay_guest")).toEqual(["applications", "payments", "dashboard", "communication"]);
    // Payments carries the stay's charge, so it is open for them although they never applied.
    expect(residentSectionUnlockedForStage("payments", "short_stay_guest")).toBe(true);
    // The native bar is derived from the one table, never copied.
    const split = splitNativeBottomNavItems(RESIDENT_UNIFIED_PORTAL_SECTIONS, "resident", "short_stay_guest");
    expect(split.primary.map((i) => i.section)).toEqual(["applications", "payments", "dashboard", "communication"]);
  });

  it("an applicant, a booking resident and a signed resident keep their own stage even when they have stays", () => {
    expect(resolveResidentPortalNavStage({ ...submitted, hasStays: true })).toBe("application_submitted");
    expect(resolveResidentPortalNavStage({ ...approved, hasStays: true })).toBe("post_approval_pre_lease");
    expect(resolveResidentPortalNavStage({ ...signed, hasStays: true })).toBe("post_lease");
    expect(resolveResidentPortalNavStage({ ...none, isBookingResidency: true, hasStays: true })).toBe("booking_residency");
  });

  it("the stay request and every Application bucket load for ANY resident account at every stage, a brand-new signup included", () => {
    for (const access of [none, submitted, approved, signed]) {
      for (const hasStays of [true, false]) {
        const who = { ...access, hasStays };
        for (const path of [
          "/resident/applications",
          "/resident/applications/pending",
          "/resident/applications/approved",
          "/resident/applications/rejected",
          "/resident/applications/stay",
        ]) {
          expect({ path, hasStays, allowed: isResidentPathAllowedForAccess(path, who) }).toEqual({ path, hasStays, allowed: true });
        }
      }
    }
    // Stage 0 (no application, no tour, no stay) still lands on the request page, not the apply wizard.
    expect(resolveResidentPortalNavStage(none)).toBe("pre_approval");
    expect(isResidentPathAllowedForAccess("/resident/applications/stay", none)).toBe(true);
    // The retired address is let through the shared guard so the next.config redirect lands instead of a bounce home.
    expect(isResidentPathAllowedForAccess("/resident/stays/upcoming", none)).toBe(true);
  });

  it("a guest with only stays lands on their Application list after a sign-in link", () => {
    expect(residentPortalHomePath({ ...none, hasTourLink: false, hasSubmittedApplication: false, hasStays: true })).toBe("/resident/applications");
    expect(residentPortalHomePath({ ...none, hasTourLink: false, hasSubmittedApplication: false })).toBe("/resident/applications/apply");
    expect(residentPortalHomePath({ ...approved, hasTourLink: false, hasSubmittedApplication: true, hasStays: true })).toBe("/resident/dashboard");
  });

  it("there is no Stays section anywhere: not registered, rendered, grouped or in the native bar", () => {
    expect(RESIDENT_UNIFIED_PORTAL_SECTIONS.map((s) => s.section)).not.toContain("stays");
    expect(RESIDENT_RENDERED_SECTION_IDS as readonly string[]).not.toContain("stays");
    expect(PORTAL_NAV_GROUPS.resident.flatMap((g) => g.sections)).not.toContain("stays");
    expect(NATIVE_BOTTOM_NAV_RESIDENT_ORDER as readonly string[]).not.toContain("stays");
    for (const stage of STAGES) expect(residentBottomNavPrimarySections(stage)).not.toContain("stays");
    // Application stays registered, rendered, grouped and in the native bar.
    expect(RESIDENT_UNIFIED_PORTAL_SECTIONS.find((s) => s.section === "applications")).toMatchObject({ label: "Application" });
    expect(RESIDENT_RENDERED_SECTION_IDS as readonly string[]).toContain("applications");
    expect(PORTAL_NAV_GROUPS.resident.flatMap((g) => g.sections)).toContain("applications");
    expect(NATIVE_BOTTOM_NAV_RESIDENT_ORDER as readonly string[]).toContain("applications");
  });

  it("the request page is its own route, so it outranks applications/[bucket]", () => {
    expect(existsSync(join(process.cwd(), "src/app/resident/applications/stay/page.tsx"))).toBe(true);
    expect(routeResolves("/resident/applications/stay")).toBe(true);
    expect(routeResolves("/resident/applications/approved")).toBe(true);
  });
});
