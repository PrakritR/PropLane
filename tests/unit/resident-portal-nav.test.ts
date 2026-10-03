import { describe, expect, it } from "vitest";
import {
  isResidentPathAllowedForAccess,
  RESIDENT_BOTTOM_NAV_PRIMARY,
  resolveResidentPortalNavStage,
  residentBottomNavPrimarySections,
  residentNavSectionVisibleInNav,
  residentSectionLockedForStage,
  residentSectionUnlockedForStage,
} from "@/lib/resident-portal-nav";

describe("resident portal nav stages", () => {
  const preApproval = {
    leaseAccessUnlocked: false,
    applicationApproved: false,
    hasCompletedApplicationSubmission: false,
  };
  const applicationSubmitted = {
    leaseAccessUnlocked: false,
    applicationApproved: false,
    hasCompletedApplicationSubmission: true,
  };
  const postApproval = {
    leaseAccessUnlocked: false,
    applicationApproved: true,
    hasCompletedApplicationSubmission: true,
  };
  const postLease = {
    leaseAccessUnlocked: true,
    applicationApproved: true,
    hasCompletedApplicationSubmission: true,
  };

  it("resolves stages from access flags", () => {
    expect(resolveResidentPortalNavStage(preApproval)).toBe("pre_approval");
    expect(resolveResidentPortalNavStage(applicationSubmitted)).toBe("application_submitted");
    expect(resolveResidentPortalNavStage(postApproval)).toBe("post_approval_pre_lease");
    expect(resolveResidentPortalNavStage(postLease)).toBe("post_lease");
  });

  it("pre-approval bottom bar is tour, application, dashboard, communication", () => {
    expect(residentBottomNavPrimarySections("pre_approval")).toEqual([
      "tour",
      "applications",
      "dashboard",
      "communication",
    ]);
  });

  // Regression: this used to be lease/payments — two tabs the same stage locks —
  // so the phone bottom bar went half-dead the moment an application was submitted.
  // Approval, not submission, is what unlocks Lease and Payments.
  it("submitted bottom bar stays on tour, application, dashboard, communication", () => {
    expect(residentBottomNavPrimarySections("application_submitted")).toEqual([
      "tour",
      "applications",
      "dashboard",
      "communication",
    ]);
  });

  it("never puts a section on the bottom bar that its own stage locks", () => {
    const stages = ["pre_approval", "application_submitted", "post_approval_pre_lease", "post_lease"] as const;
    for (const stage of stages) {
      for (const section of residentBottomNavPrimarySections(stage)) {
        expect(
          { stage, section, locked: residentSectionLockedForStage(section, stage) },
        ).toEqual({ stage, section, locked: false });
      }
    }
  });

  it("unlocks lease + payments on approval and services once the lease is signed", () => {
    expect(residentBottomNavPrimarySections("post_approval_pre_lease")).toContain("lease");
    expect(residentBottomNavPrimarySections("post_approval_pre_lease")).toContain("payments");
    expect(residentBottomNavPrimarySections("post_approval_pre_lease")).not.toContain("services");
    expect(residentSectionUnlockedForStage("services", "post_approval_pre_lease")).toBe(false);
    expect(residentBottomNavPrimarySections("post_lease")).toContain("services");
    expect(residentSectionUnlockedForStage("services", "post_lease")).toBe(true);
  });

  it("post-approval bottom bar is lease, payments, dashboard, and communication", () => {
    expect(residentBottomNavPrimarySections("post_approval_pre_lease")).toEqual([
      "lease",
      "payments",
      "dashboard",
      "communication",
    ]);
  });

  it("post-lease bottom bar is services, payments, dashboard, and communication", () => {
    expect(residentBottomNavPrimarySections("post_lease")).toEqual([
      "services",
      "payments",
      "dashboard",
      "communication",
    ]);
  });

  it("allows communication during pre-approval", () => {
    expect(isResidentPathAllowedForAccess("/resident/communication/inbox/unopened", preApproval)).toBe(true);
  });

  it("blocks lease and payments until application is approved", () => {
    expect(isResidentPathAllowedForAccess("/resident/lease", applicationSubmitted)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/payments/pending", applicationSubmitted)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/lease", postApproval)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/payments/pending", postApproval)).toBe(true);
  });

  it("keeps tour and application reachable after approval and post-lease", () => {
    expect(residentSectionLockedForStage("tour", "post_approval_pre_lease")).toBe(false);
    expect(residentSectionLockedForStage("applications", "post_approval_pre_lease")).toBe(false);
    expect(residentSectionUnlockedForStage("lease", "post_approval_pre_lease")).toBe(true);
    expect(residentSectionUnlockedForStage("payments", "post_approval_pre_lease")).toBe(true);
    expect(residentSectionLockedForStage("tour", "post_lease")).toBe(false);
    expect(residentSectionLockedForStage("applications", "post_lease")).toBe(false);
  });

  it("keeps lease unlocked after both parties sign and unlocks services + house details", () => {
    expect(residentSectionUnlockedForStage("lease", "post_lease")).toBe(true);
    expect(residentSectionUnlockedForStage("services", "post_lease")).toBe(true);
    expect(residentSectionUnlockedForStage("move-in", "post_lease")).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in", postLease)).toBe(true);
  });

  it("hides house details from nav until post-lease unlock", () => {
    expect(residentNavSectionVisibleInNav("move-in", "pre_approval")).toBe(true);
    expect(residentNavSectionVisibleInNav("move-in", "post_approval_pre_lease")).toBe(true);
    expect(residentNavSectionVisibleInNav("move-in", "post_lease")).toBe(true);
    expect(residentNavSectionVisibleInNav("lease", "pre_approval")).toBe(true);
  });
});

/**
 * Lease first is gone (captain, Oct 3 2026): the stage depends only on the application and the
 * signed lease. Whatever a stale access object still carries about a lease-first order or draft
 * changes nothing, and Lease stays locked until an application is approved.
 */
describe("resident portal nav — application first, always", () => {
  const startedApplication = {
    leaseAccessUnlocked: false,
    applicationApproved: false,
    hasCompletedApplicationSubmission: false,
  };
  const stale = { ...startedApplication, pipelineOrder: "lease_then_application", hasLeaseFirstDraft: true };

  it("a stale lease-first flag cannot unlock Lease", () => {
    expect(resolveResidentPortalNavStage(stale)).toBe("pre_approval");
    expect(isResidentPathAllowedForAccess("/resident/lease", stale)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/lease/pending/lease_first_1", stale)).toBe(false);
  });

  it("Lease and My home › Forms unlock on approval, the rest of My home only once the lease is signed", () => {
    const approved = { ...startedApplication, applicationApproved: true };
    expect(resolveResidentPortalNavStage(approved)).toBe("post_approval_pre_lease");
    expect(isResidentPathAllowedForAccess("/resident/lease", approved)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in/forms", approved)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in/placement", approved)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/move-in/placement", { ...approved, leaseAccessUnlocked: true })).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in", { ...approved, leaseAccessUnlocked: true })).toBe(true);
  });

  it("every phone-bar primary tab is unlocked at its stage (the two tables agree)", () => {
    for (const stage of Object.keys(RESIDENT_BOTTOM_NAV_PRIMARY) as (keyof typeof RESIDENT_BOTTOM_NAV_PRIMARY)[]) {
      for (const section of residentBottomNavPrimarySections(stage)) {
        expect(residentSectionLockedForStage(section, stage)).toBe(false);
      }
    }
  });
});

/**
 * Move-in forms set to go out on approval must be reachable then: after approval, before the lease is
 * signed, My home opens for its Forms tab ONLY. The other tabs disclose the house and stay locked.
 */
describe("resident portal nav — Forms open at approval, the rest of My home at lease signing", () => {
  const preLeaseApproved = { leaseAccessUnlocked: false, applicationApproved: true, hasCompletedApplicationSubmission: true };
  const signed = { leaseAccessUnlocked: true, applicationApproved: true, hasCompletedApplicationSubmission: true };
  const submitted = { leaseAccessUnlocked: false, applicationApproved: false, hasCompletedApplicationSubmission: true };

  it("lets an approved resident open My home › Forms", () => {
    expect(residentSectionUnlockedForStage("move-in", "post_approval_pre_lease")).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in", preLeaseApproved)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in/forms", preLeaseApproved)).toBe(true);
  });

  it("keeps placement, housemates, info and amenities locked until the lease is signed", () => {
    for (const tab of ["placement", "housemates", "info", "amenities", "inspections", "move-in"]) {
      expect({ tab, allowed: isResidentPathAllowedForAccess(`/resident/move-in/${tab}`, preLeaseApproved) }).toEqual({ tab, allowed: false });
      expect({ tab, allowed: isResidentPathAllowedForAccess(`/resident/move-in/${tab}`, signed) }).toEqual({ tab, allowed: true });
    }
  });

  it("keeps all of My home locked before approval, and the other sections locked before the lease", () => {
    expect(isResidentPathAllowedForAccess("/resident/move-in/forms", submitted)).toBe(false);
    expect(residentSectionLockedForStage("services", "post_approval_pre_lease")).toBe(true);
    expect(residentSectionLockedForStage("inspections", "post_approval_pre_lease")).toBe(true);
  });

  it("every bottom-bar tab is still unlocked at its own stage", () => {
    for (const stage of ["pre_approval", "application_submitted", "post_approval_pre_lease", "post_lease"] as const) {
      for (const section of RESIDENT_BOTTOM_NAV_PRIMARY[stage]) expect(residentSectionUnlockedForStage(section, stage)).toBe(true);
    }
  });
});
