import { describe, expect, it } from "vitest";
import {
  isResidentPathAllowedForAccess,
  resolveResidentPortalNavStage,
  residentBottomNavPrimarySections,
  residentNavSectionVisibleInNav,
  residentPortalHomePath,
  residentSectionUnlockedForStage,
} from "@/lib/resident-portal-nav";

/**
 * A booking-created resident (PropLane "Add booking" → new resident) skips
 * application and lease entirely — no submitted application, no signed
 * lease — yet unlocks the same workspace a signed lease would: Lease,
 * Payments, Documents, Services, My home. `STAGE_UNLOCKED_SECTIONS` and
 * `RESIDENT_BOTTOM_NAV_PRIMARY` (src/lib/resident-portal-nav.ts) must derive
 * this from the SAME `resolveResidentPortalNavStage` decision every other
 * stage does.
 */
describe("resident portal nav — booking residency", () => {
  const booking = {
    leaseAccessUnlocked: false,
    applicationApproved: false,
    hasCompletedApplicationSubmission: false,
    isBookingResidency: true,
  };

  it("resolves to its own stage, ahead of the ordinary submission stages", () => {
    expect(resolveResidentPortalNavStage(booking)).toBe("booking_residency");
    // A real signed lease or an approved application still wins if either is
    // also true — a booking resident who later actually applies or signs
    // moves on exactly like anyone else.
    expect(resolveResidentPortalNavStage({ ...booking, applicationApproved: true })).toBe("post_approval_pre_lease");
    expect(resolveResidentPortalNavStage({ ...booking, leaseAccessUnlocked: true })).toBe("post_lease");
  });

  it("unlocks Lease, Payments, Documents, Services, and My home without an application or lease row", () => {
    for (const section of ["lease", "payments", "documents", "services", "move-in"]) {
      expect(residentSectionUnlockedForStage(section, "booking_residency")).toBe(true);
    }
  });

  it("keeps both tables — bottom nav and section unlocks — in agreement", () => {
    for (const section of residentBottomNavPrimarySections("booking_residency")) {
      expect(residentSectionUnlockedForStage(section, "booking_residency")).toBe(true);
    }
    expect(residentBottomNavPrimarySections("booking_residency")).toEqual([
      "services",
      "payments",
      "dashboard",
      "communication",
    ]);
  });

  it("hides the Applications and Lease nav rows rather than showing them locked", () => {
    expect(residentNavSectionVisibleInNav("applications", "booking_residency")).toBe(false);
    expect(residentNavSectionVisibleInNav("lease", "booking_residency")).toBe(false);
    // Still unlocked underneath — a direct link works, it is just not a nav row.
    expect(residentSectionUnlockedForStage("applications", "booking_residency")).toBe(true);
    expect(residentSectionUnlockedForStage("lease", "booking_residency")).toBe(true);
    // Untouched for every other stage.
    expect(residentNavSectionVisibleInNav("applications", "post_lease")).toBe(true);
    expect(residentNavSectionVisibleInNav("lease", "pre_approval")).toBe(true);
  });

  it("allows the route guard onto Lease/Payments/Documents/Services/move-in", () => {
    expect(isResidentPathAllowedForAccess("/resident/lease", booking)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/payments/pending", booking)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in", booking)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/documents", booking)).toBe(true);
  });

  it("lands a booking resident on move-in details, not the empty dashboard", () => {
    expect(
      residentPortalHomePath({
        leaseAccessUnlocked: false,
        applicationApproved: false,
        hasTourLink: false,
        hasSubmittedApplication: false,
        isBookingResidency: true,
      }),
    ).toBe("/resident/move-in");
  });
});
