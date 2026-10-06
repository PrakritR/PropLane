import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("Lease and Forms unlock on approval, My home only once the lease is signed", () => {
    const approved = { ...startedApplication, applicationApproved: true };
    expect(resolveResidentPortalNavStage(approved)).toBe("post_approval_pre_lease");
    expect(isResidentPathAllowedForAccess("/resident/lease", approved)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/forms", approved)).toBe(true);
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
 * Forms is its own section, open from an approved application on; My home (placement, details, roommates,
 * inspections) discloses the house and stays locked until the lease is signed. The two stage tables (what is
 * unlocked, what the phone bar promotes) must keep agreeing.
 */
describe("resident portal nav — Forms open at approval, My home at lease signing", () => {
  const preLeaseApproved = { leaseAccessUnlocked: false, applicationApproved: true, hasCompletedApplicationSubmission: true };
  const signed = { leaseAccessUnlocked: true, applicationApproved: true, hasCompletedApplicationSubmission: true };
  const submitted = { leaseAccessUnlocked: false, applicationApproved: false, hasCompletedApplicationSubmission: true };

  it("lets an approved resident open Forms, its list and a form's own address", () => {
    expect(residentSectionUnlockedForStage("forms", "post_approval_pre_lease")).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/forms", preLeaseApproved)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/forms/completed", preLeaseApproved)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/forms/0b2f6a54-9c1d-4e3a-8d2e-7a1f5b6c8d90", preLeaseApproved)).toBe(true);
  });

  it("keeps all of My home locked between approval and the signed lease, and opens it at signing", () => {
    expect(residentSectionUnlockedForStage("move-in", "post_approval_pre_lease")).toBe(false);
    for (const tab of ["placement", "housemates", "info", "amenities", "inspections", "inspections/move-in", "move-in"]) {
      expect({ tab, allowed: isResidentPathAllowedForAccess(`/resident/move-in/${tab}`, preLeaseApproved) }).toEqual({ tab, allowed: false });
      expect({ tab, allowed: isResidentPathAllowedForAccess(`/resident/move-in/${tab}`, signed) }).toEqual({ tab, allowed: true });
    }
    expect(isResidentPathAllowedForAccess("/resident/move-in", preLeaseApproved)).toBe(false);
  });

  it("the old /resident/move-in/forms address is judged as Forms, so it can redirect there", () => {
    expect(isResidentPathAllowedForAccess("/resident/move-in/forms", preLeaseApproved)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in/forms", signed)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in/forms", submitted)).toBe(false);
  });

  it("keeps Forms locked in the nav before approval, and the other sections locked before the lease", () => {
    expect(isResidentPathAllowedForAccess("/resident/forms", submitted)).toBe(false);
    expect(residentSectionLockedForStage("forms", "application_submitted")).toBe(true);
    expect(residentSectionLockedForStage("forms", "pre_approval")).toBe(true);
    expect(residentSectionLockedForStage("services", "post_approval_pre_lease")).toBe(true);
    expect(residentSectionLockedForStage("inspections", "post_approval_pre_lease")).toBe(true);
  });

  it("Forms is unlocked at every stage from approval on (approved, booking, signed)", () => {
    for (const stage of ["post_approval_pre_lease", "booking_residency", "post_lease"] as const) {
      expect({ stage, unlocked: residentSectionUnlockedForStage("forms", stage) }).toEqual({ stage, unlocked: true });
    }
  });

  it("every bottom-bar tab is still unlocked at its own stage", () => {
    for (const stage of ["pre_approval", "application_submitted", "application_submitted_forms", "post_approval_pre_lease", "post_lease"] as const) {
      for (const section of RESIDENT_BOTTOM_NAV_PRIMARY[stage]) expect(residentSectionUnlockedForStage(section, stage)).toBe(true);
    }
  });
});

/**
 * The Intake form goes out the moment an application is submitted (and a form can block approval), so a
 * resident who has submitted and has a form waiting must be able to open it. The nav stays exactly as locked
 * as `application_submitted`; Forms alone is reachable, by its direct link.
 */
describe("resident portal nav — submitted application with a form waiting (application_submitted_forms)", () => {
  const submittedNoForms = { leaseAccessUnlocked: false, applicationApproved: false, hasCompletedApplicationSubmission: true };
  const submittedWithForms = { ...submittedNoForms, hasMoveInForms: true };
  const FORM = "/resident/forms/0b2f6a54-9c1d-4e3a-8d2e-7a1f5b6c8d90";

  it("resolves the stage only for a submitted, unapproved resident with a form", () => {
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

  it("unlocks exactly what the submitted stage does: Forms and My home stay locked rows", () => {
    expect(residentSectionUnlockedForStage("forms", "application_submitted_forms")).toBe(false);
    expect(residentSectionUnlockedForStage("move-in", "application_submitted_forms")).toBe(false);
    for (const section of ["lease", "payments", "services", "inspections", "documents", "forms", "move-in"]) {
      expect({ section, locked: residentSectionLockedForStage(section, "application_submitted_forms") }).toEqual({ section, locked: true });
    }
    for (const section of ["tour", "applications", "dashboard", "communication", "profile"]) {
      expect({ section, locked: residentSectionLockedForStage(section, "application_submitted_forms") }).toEqual({ section, locked: false });
    }
  });

  it("a form waiting before approval is still fillable by its direct link, and so is the old emailed address", () => {
    expect(isResidentPathAllowedForAccess("/resident/forms", submittedWithForms)).toBe(true);
    expect(isResidentPathAllowedForAccess(FORM, submittedWithForms)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in/forms", submittedWithForms)).toBe(true);
  });

  it("keeps My home, Lease and Payments locked", () => {
    for (const tab of ["", "/placement", "/housemates", "/info", "/amenities", "/inspections"]) {
      expect({ tab, allowed: isResidentPathAllowedForAccess(`/resident/move-in${tab}`, submittedWithForms) }).toEqual({ tab, allowed: false });
    }
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

  it("without a form, Forms stays closed for a submitted-only resident", () => {
    expect(isResidentPathAllowedForAccess("/resident/forms", submittedNoForms)).toBe(false);
    expect(isResidentPathAllowedForAccess(FORM, { ...submittedNoForms, hasMoveInForms: false })).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/move-in/forms", submittedNoForms)).toBe(false);
  });

  it("a resident who has not submitted never gets Forms or My home, even with a form flag", () => {
    const preApproval = { leaseAccessUnlocked: false, applicationApproved: false, hasCompletedApplicationSubmission: false, hasMoveInForms: true };
    expect(isResidentPathAllowedForAccess("/resident/forms", preApproval)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/move-in", preApproval)).toBe(false);
  });

  it("approval and a signed lease behave as the plan says (Forms from approval, My home at signing)", () => {
    const approved = { leaseAccessUnlocked: false, applicationApproved: true, hasCompletedApplicationSubmission: true, hasMoveInForms: true };
    expect(isResidentPathAllowedForAccess("/resident/forms", approved)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in/placement", approved)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/lease", approved)).toBe(true);
    expect(isResidentPathAllowedForAccess("/resident/move-in/placement", { ...approved, leaseAccessUnlocked: true })).toBe(true);
  });

  it("the sidebar says a locked section opens after approval, and Forms reads the same before approval", () => {
    expect(residentNavLockReason("lease", "application_submitted_forms")).toBe("Available after your application is approved");
    expect(residentNavLockReason("payments", "application_submitted_forms")).toBe("Available after your application is approved");
    expect(residentNavLockReason("lease", "application_submitted_forms")).toBe(residentNavLockReason("lease", "application_submitted"));
    expect(residentNavLockReason("forms", "application_submitted_forms")).toBe("Available after your application is approved");
    expect(residentNavLockReason("forms", "post_approval_pre_lease")).toBeNull();
    expect(residentNavLockReason("move-in", "post_approval_pre_lease")).toBe("Available after your lease is signed");
    expect(residentNavLockReason("dashboard", "application_submitted_forms")).toBeNull();
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

/**
 * Forms is one section read by several tables (the registry the sidebar lists, the stage table that decides
 * what is unlocked, the path guard, the native bar, the nav group). They have to agree, and the move-in gate
 * that rides on a form must be decided on the server.
 */
describe("resident portal nav — the Forms section is consistent across every table", () => {
  it("is registered, grouped under My home before My home, rendered, and on the native bar in the same place", async () => {
    const sections = await import("@/lib/portals/resident-sections");
    const groups = await import("@/lib/portals/nav-groups");
    const native = await import("@/lib/native/portal-bottom-nav");
    for (const list of [sections.RESIDENT_UNIFIED_PORTAL_SECTIONS, sections.RESIDENT_APPROVED_PORTAL_SECTIONS, sections.RESIDENT_LIMITED_PORTAL_SECTIONS]) {
      expect(list.find((s) => s.section === "forms")).toMatchObject({ label: "Forms", tabs: [] });
    }
    expect(sections.RESIDENT_RENDERED_SECTION_IDS as readonly string[]).toContain("forms");
    expect(sections.RESIDENT_FREE_TIER_SECTION_IDS as readonly string[]).toContain("forms");
    const myHome = groups.PORTAL_NAV_GROUPS.resident.find((g) => g.id === "my-home")!.sections;
    expect(myHome.indexOf("forms")).toBe(myHome.indexOf("lease") + 1);
    expect(myHome.indexOf("forms")).toBeLessThan(myHome.indexOf("move-in"));
    const order = native.NATIVE_BOTTOM_NAV_RESIDENT_ORDER as readonly string[];
    expect(order.indexOf("forms")).toBe(order.indexOf("move-in") - 1);
  });

  it("is unlocked at exactly the stages an approved application opens, and never promoted to the phone bar", () => {
    const stages = ["pre_approval", "application_submitted", "application_submitted_forms", "booking_residency", "post_approval_pre_lease", "post_lease"] as const;
    const unlocked = stages.filter((stage) => residentSectionUnlockedForStage("forms", stage));
    expect(unlocked).toEqual(["booking_residency", "post_approval_pre_lease", "post_lease"]);
    for (const stage of stages) expect(RESIDENT_BOTTOM_NAV_PRIMARY[stage]).not.toContain("forms");
  });

  it("decides the Move-in details lock on the server and never builds the page with the house in it", () => {
    const render = readFileSync(join(process.cwd(), "src/lib/render-portal-section.tsx"), "utf8");
    expect(render).toContain("residentAccess?.blockingFormsPending?.moveInDetails");
    expect(render).toContain("formsLock={formsLock}");
    const panel = readFileSync(join(process.cwd(), "src/components/portal/resident-move-in-panel.tsx"), "utf8");
    expect(panel).toContain("redactMoveInDetails(loaded)");
  });
});
