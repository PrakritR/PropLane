import { describe, expect, it } from "vitest";
import {
  isResidentPathAllowedForAccess,
  resolveResidentPortalNavStage,
  residentBottomNavPrimarySections,
  residentLeaseFirstApplicationRedirectLeaseId,
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
  const leaseFirst = {
    leaseAccessUnlocked: false,
    applicationApproved: false,
    hasCompletedApplicationSubmission: false,
    pipelineOrder: "lease_then_application" as const,
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
    expect(resolveResidentPortalNavStage(leaseFirst)).toBe("post_approval_pre_lease");
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
 * Lease-first (captain, Oct 3): a resident who has a lease-first draft for a home gets Lease
 * unlocked in the sidebar, the phone bar, the server guard and the client guard — all four read
 * the one stage, so the two tables cannot disagree. Application-first is unchanged.
 */
describe("resident portal nav — lease-first draft", () => {
  const startedApplication = {
    leaseAccessUnlocked: false,
    applicationApproved: false,
    hasCompletedApplicationSubmission: false,
  };
  const withDraft = { ...startedApplication, hasLeaseFirstDraft: true };

  it("a lease-first draft unlocks Lease even when the workspace order is unknown", () => {
    expect(resolveResidentPortalNavStage(startedApplication)).toBe("pre_approval");
    expect(resolveResidentPortalNavStage(withDraft)).toBe("post_approval_pre_lease");
    // An in-progress application alongside the draft changes nothing.
    expect(resolveResidentPortalNavStage({ ...withDraft, hasCompletedApplicationSubmission: true })).toBe(
      "post_approval_pre_lease",
    );
  });

  it("sidebar and phone bar agree: Lease is unlocked and on the bar, not locked", () => {
    const stage = resolveResidentPortalNavStage(withDraft);
    expect(residentSectionUnlockedForStage("lease", stage)).toBe(true);
    expect(residentSectionLockedForStage("lease", stage)).toBe(false);
    expect(residentBottomNavPrimarySections(stage)).toContain("lease");
    for (const section of residentBottomNavPrimarySections(stage)) {
      expect(residentSectionLockedForStage(section, stage)).toBe(false);
    }
  });

  it("server and client guards let the draft's resident open Lease", () => {
    expect(isResidentPathAllowedForAccess("/resident/lease/pending/lease_first_1", withDraft)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/lease", withDraft)).toBe(true);
    // Without the draft the same resident is still held at the application stage.
    expect(isResidentPathAllowedForAccess("/resident/lease", startedApplication)).toBe(false);
  });

  it("application-first is unchanged: Lease still unlocks only on approval", () => {
    const appFirst = { ...startedApplication, pipelineOrder: "application_then_lease" as const, hasLeaseFirstDraft: false };
    expect(resolveResidentPortalNavStage(appFirst)).toBe("pre_approval");
    expect(isResidentPathAllowedForAccess("/resident/lease", appFirst)).toBe(false);
    expect(resolveResidentPortalNavStage({ ...appFirst, applicationApproved: true })).toBe("post_approval_pre_lease");
  });

  it("Application hands off to the unsigned lease only in a lease-first workspace", () => {
    const base = { pipelineOrder: "lease_then_application" as const, leaseFirstPendingLeaseId: "lease_first_1" };
    expect(residentLeaseFirstApplicationRedirectLeaseId(base)).toBe("lease_first_1");
    // Signed (no pending lease) -> the application is next.
    expect(residentLeaseFirstApplicationRedirectLeaseId({ ...base, leaseFirstPendingLeaseId: null })).toBeNull();
    // Application-first workspace, or a lease already fully executed -> never redirected.
    expect(
      residentLeaseFirstApplicationRedirectLeaseId({ ...base, pipelineOrder: "application_then_lease" }),
    ).toBeNull();
    expect(residentLeaseFirstApplicationRedirectLeaseId({ ...base, leaseAccessUnlocked: true })).toBeNull();
  });
});
