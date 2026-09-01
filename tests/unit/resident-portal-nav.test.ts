import { describe, expect, it } from "vitest";
import {
  isResidentPathAllowedForAccess,
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

  it("post-approval bottom bar is lease, payments, applications, and communication", () => {
    expect(residentBottomNavPrimarySections("post_approval_pre_lease")).toEqual([
      "lease",
      "payments",
      "applications",
      "communication",
    ]);
  });

  it("post-lease bottom bar is services, payments, applications, and communication", () => {
    expect(residentBottomNavPrimarySections("post_lease")).toEqual([
      "services",
      "payments",
      "applications",
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
    expect(residentNavSectionVisibleInNav("move-in", "pre_approval")).toBe(false);
    expect(residentNavSectionVisibleInNav("move-in", "post_approval_pre_lease")).toBe(false);
    expect(residentNavSectionVisibleInNav("move-in", "post_lease")).toBe(true);
    expect(residentNavSectionVisibleInNav("lease", "pre_approval")).toBe(true);
  });
});
