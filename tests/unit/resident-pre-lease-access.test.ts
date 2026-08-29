import { describe, expect, it } from "vitest";
import { isResidentPathAllowedForAccess } from "@/lib/resident-portal-nav";
import { RESIDENT_UNIFIED_PORTAL_SECTIONS } from "@/lib/portals/resident-sections";

describe("resident portal stage access", () => {
  const preApproval = {
    leaseAccessUnlocked: false,
    applicationApproved: false,
    hasSubmittedApplication: false,
    hasCompletedApplicationSubmission: false,
  };
  const applicationSubmitted = {
    leaseAccessUnlocked: false,
    applicationApproved: false,
    hasSubmittedApplication: true,
    hasCompletedApplicationSubmission: true,
  };
  const postApproval = {
    leaseAccessUnlocked: false,
    applicationApproved: true,
    hasSubmittedApplication: true,
    hasCompletedApplicationSubmission: true,
  };
  const postLease = {
    leaseAccessUnlocked: true,
    applicationApproved: true,
    hasSubmittedApplication: true,
    hasCompletedApplicationSubmission: true,
  };

  it("unified nav catalog lists every resident section", () => {
    const ids = RESIDENT_UNIFIED_PORTAL_SECTIONS.map((s) => s.section);
    expect(ids).toContain("tour");
    expect(ids).toContain("lease");
    expect(ids).toContain("services");
    expect(ids).toContain("payments");
  });

  it("pre-approval allows tour, application, dashboard, and communication", () => {
    expect(isResidentPathAllowedForAccess("/resident/tour", preApproval)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/applications/pending", preApproval)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/dashboard", preApproval)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/communication/inbox/unopened", preApproval)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/lease", preApproval)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/payments/pending", preApproval)).toBe(false);
  });

  it("submitted application keeps tour/application but blocks lease and payments until approval", () => {
    expect(isResidentPathAllowedForAccess("/resident/tour", applicationSubmitted)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/applications/pending", applicationSubmitted)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/lease", applicationSubmitted)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/payments/pending", applicationSubmitted)).toBe(false);
  });

  it("post-approval allows lease, payments, tour, and application", () => {
    expect(isResidentPathAllowedForAccess("/resident/lease", postApproval)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/payments/pending", postApproval)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/tour", postApproval)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/applications/pending", postApproval)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/applications/apply?propertyId=demo", postApproval)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/services", postApproval)).toBe(false);
  });

  it("passes legacy section aliases through to their real destination", () => {
    // Not resident nav sections — renderPortalSection rewrites each one. A
    // guard that calls them forbidden bounces the redirect before it lands
    // (the client guard judges the ORIGINAL pathname mid-redirect).
    for (const access of [preApproval, applicationSubmitted, postApproval, postLease]) {
      expect(isResidentPathAllowedForAccess("/resident/inbox/unopened", access)).toBe(true);
      expect(isResidentPathAllowedForAccess("/resident/financials/summary", access)).toBe(true);
      expect(isResidentPathAllowedForAccess("/resident/finances", access)).toBe(true);
      expect(isResidentPathAllowedForAccess("/resident/bugs-feedback", access)).toBe(true);
    }
  });

  it("post-lease unlocks services and house details and keeps tour and application reachable", () => {
    expect(isResidentPathAllowedForAccess("/resident/services", postLease)).toBe(true);
    // Legacy sub-paths redirect to the unified Services screen.
    expect(isResidentPathAllowedForAccess("/resident/services/requests", postLease)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/services/work-orders", postLease)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in", postLease)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/lease", postLease)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/tour", postLease)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/applications/pending", postLease)).toBe(true);
  });
});
