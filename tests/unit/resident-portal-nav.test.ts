import { describe, expect, it } from "vitest";
import {
  isResidentPathAllowedForAccess,
  RESIDENT_BOTTOM_NAV_PRIMARY,
  resolveResidentPortalNavStage,
  residentBottomNavPrimarySections,
  residentNavLockReason,
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
    const stages = ["pre_approval", "application_submitted", "application_submitted_forms", "post_approval_pre_lease", "post_lease"] as const;
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

  it("keeps placement, housemates, info and inspections locked until the lease is signed", () => {
    for (const tab of ["placement", "housemates", "info", "amenities", "inspections", "inspections/move-in", "move-in"]) {
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
    for (const stage of ["pre_approval", "application_submitted", "application_submitted_forms", "post_approval_pre_lease", "post_lease"] as const) {
      for (const section of RESIDENT_BOTTOM_NAV_PRIMARY[stage]) expect(residentSectionUnlockedForStage(section, stage)).toBe(true);
    }
  });
});

/**
 * The Intake form goes out the moment an application is submitted, so a resident who has submitted and
 * has a form waiting must be able to open it: My home opens for its Forms tab alone, every other tab
 * stays exactly as locked as in `application_submitted`.
 */
describe("resident portal nav — submitted application with a form waiting (application_submitted_forms)", () => {
  const submittedNoForms = { leaseAccessUnlocked: false, applicationApproved: false, hasCompletedApplicationSubmission: true };
  const submittedWithForms = { ...submittedNoForms, hasMoveInForms: true };

  it("resolves the new stage only for a submitted, unapproved resident with a form", () => {
    expect(resolveResidentPortalNavStage(submittedWithForms)).toBe("application_submitted_forms");
    expect(resolveResidentPortalNavStage(submittedNoForms)).toBe("application_submitted");
    expect(resolveResidentPortalNavStage({ ...submittedNoForms, hasMoveInForms: false })).toBe("application_submitted");
  });

  it("a form flag does not change any other stage", () => {
    const flagged = (access: Record<string, boolean>) => ({ ...access, hasMoveInForms: true });
    expect(resolveResidentPortalNavStage(flagged({ leaseAccessUnlocked: false, applicationApproved: false, hasCompletedApplicationSubmission: false }))).toBe("pre_approval");
    expect(resolveResidentPortalNavStage(flagged({ leaseAccessUnlocked: false, applicationApproved: true, hasCompletedApplicationSubmission: true }))).toBe("post_approval_pre_lease");
    expect(resolveResidentPortalNavStage(flagged({ leaseAccessUnlocked: true, applicationApproved: true, hasCompletedApplicationSubmission: true }))).toBe("post_lease");
  });

  it("the bottom bar is the submitted one, and every primary tab on it is unlocked", () => {
    expect(residentBottomNavPrimarySections("application_submitted_forms")).toEqual(residentBottomNavPrimarySections("application_submitted"));
    expect(residentBottomNavPrimarySections("application_submitted_forms")).toEqual(["tour", "applications", "dashboard", "communication"]);
    for (const section of residentBottomNavPrimarySections("application_submitted_forms")) {
      expect(residentSectionLockedForStage(section, "application_submitted_forms")).toBe(false);
    }
  });

  it("the new stage is covered by the two-tables-agree invariant", () => {
    expect(Object.keys(RESIDENT_BOTTOM_NAV_PRIMARY)).toContain("application_submitted_forms");
  });

  it("opens My home, and nothing else the submitted stage locks", () => {
    expect(residentSectionUnlockedForStage("move-in", "application_submitted_forms")).toBe(true);
    expect(residentSectionUnlockedForStage("move-in", "application_submitted")).toBe(false);
    for (const section of ["lease", "payments", "services", "inspections", "documents"]) {
      expect({ section, locked: residentSectionLockedForStage(section, "application_submitted_forms") }).toEqual({ section, locked: true });
    }
    for (const section of ["tour", "applications", "dashboard", "communication", "profile"]) {
      expect({ section, locked: residentSectionLockedForStage(section, "application_submitted_forms") }).toEqual({ section, locked: false });
    }
  });

  it("allows /resident/move-in and /resident/move-in/forms", () => {
    expect(isResidentPathAllowedForAccess("/resident/move-in", submittedWithForms)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in/forms", submittedWithForms)).toBe(true);
  });

  it("keeps placement, housemates, info, amenities and inspections locked", () => {
    for (const tab of ["placement", "housemates", "info", "amenities", "inspections"]) {
      expect({ tab, allowed: isResidentPathAllowedForAccess(`/resident/move-in/${tab}`, submittedWithForms) }).toEqual({ tab, allowed: false });
    }
  });

  it("keeps Lease and Payments locked", () => {
    expect(isResidentPathAllowedForAccess("/resident/lease", submittedWithForms)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/lease/pending/x", submittedWithForms)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/payments", submittedWithForms)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/payments/pending", submittedWithForms)).toBe(false);
  });

  it("keeps the always-open sections reachable", () => {
    expect(isResidentPathAllowedForAccess("/resident/dashboard", submittedWithForms)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/communication/inbox/unopened", submittedWithForms)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/applications", submittedWithForms)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/profile", submittedWithForms)).toBe(true);
  });

  it("without a form, /resident/move-in/forms stays closed for a submitted-only resident", () => {
    expect(isResidentPathAllowedForAccess("/resident/move-in/forms", submittedNoForms)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/move-in", submittedNoForms)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/move-in/forms", { ...submittedNoForms, hasMoveInForms: false })).toBe(false);
  });

  it("a resident who has not submitted never gets My home, even with a form flag", () => {
    const preApproval = { leaseAccessUnlocked: false, applicationApproved: false, hasCompletedApplicationSubmission: false, hasMoveInForms: true };
    expect(isResidentPathAllowedForAccess("/resident/move-in/forms", preApproval)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/move-in", preApproval)).toBe(false);
  });

  it("approval and a signed lease behave as before (Forms from approval, the rest at signing)", () => {
    const approved = { leaseAccessUnlocked: false, applicationApproved: true, hasCompletedApplicationSubmission: true, hasMoveInForms: true };
    expect(isResidentPathAllowedForAccess("/resident/move-in/forms", approved)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in/placement", approved)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/lease", approved)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in/placement", { ...approved, leaseAccessUnlocked: true })).toBe(true);
  });

  it("the sidebar says a locked section opens after approval, and My home has no lock reason", () => {
    expect(residentNavLockReason("lease", "application_submitted_forms")).toBe("Available after your application is approved");
    expect(residentNavLockReason("payments", "application_submitted_forms")).toBe("Available after your application is approved");
    expect(residentNavLockReason("lease", "application_submitted_forms")).toBe(residentNavLockReason("lease", "application_submitted"));
    expect(residentNavLockReason("move-in", "application_submitted_forms")).toBeNull();
    expect(residentNavLockReason("move-in", "application_submitted")).toBe("Available after your application is approved");
    expect(residentNavLockReason("dashboard", "application_submitted_forms")).toBeNull();
  });

  it("My home stays visible in the nav at the new stage", () => {
    expect(residentNavSectionVisibleInNav("move-in", "application_submitted_forms")).toBe(true);
  });
});

/**
 * C1-R5 — Inspections is a tab of My home, so no stage may unlock (or list) a separate
 * `inspections` section, and the bottom bar / stage tables must keep agreeing.
 */
describe("resident portal nav — Inspections lives inside My home", () => {
  const stages = ["pre_approval", "application_submitted", "application_submitted_forms", "booking_residency", "post_approval_pre_lease", "post_lease"] as const;
  const signed = { leaseAccessUnlocked: true, applicationApproved: true, hasCompletedApplicationSubmission: true };
  const approved = { leaseAccessUnlocked: false, applicationApproved: true, hasCompletedApplicationSubmission: true };

  it("no stage unlocks a standalone inspections section, and no bottom bar promotes one", () => {
    for (const stage of stages) {
      expect({ stage, unlocked: residentSectionUnlockedForStage("inspections", stage) }).toEqual({ stage, unlocked: false });
      expect(RESIDENT_BOTTOM_NAV_PRIMARY[stage]).not.toContain("inspections");
    }
  });

  it("the stage tables still agree: every bottom-bar section is unlocked at its own stage", () => {
    for (const stage of stages) {
      for (const section of RESIDENT_BOTTOM_NAV_PRIMARY[stage]) {
        expect({ stage, section, unlocked: residentSectionUnlockedForStage(section, stage) }).toEqual({ stage, section, unlocked: true });
      }
    }
  });

  it("My home › Inspections opens with the signed lease, exactly like the rest of My home", () => {
    expect(isResidentPathAllowedForAccess("/resident/move-in/inspections", signed)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in/inspections/move-in/abc", signed)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in/inspections", approved)).toBe(false);
  });

  it("the old /resident/inspections address passes the shared guard so the renderer can redirect it", () => {
    expect(isResidentPathAllowedForAccess("/resident/inspections", approved)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/inspections/upcoming", signed)).toBe(true);
  });

  it("is in no resident sidebar catalog", async () => {
    const sections = await import("@/lib/portals/resident-sections");
    for (const list of [
      sections.RESIDENT_UNIFIED_PORTAL_SECTIONS,
      sections.RESIDENT_APPROVED_PORTAL_SECTIONS,
      sections.RESIDENT_LIMITED_PORTAL_SECTIONS,
    ]) {
      expect(list.map((s) => s.section)).not.toContain("inspections");
    }
    expect(sections.RESIDENT_PORTAL_SECTION_IDS as readonly string[]).not.toContain("inspections");
    const native = await import("@/lib/native/portal-bottom-nav");
    expect(native.NATIVE_BOTTOM_NAV_RESIDENT_ORDER as readonly string[]).not.toContain("inspections");
  });
});
