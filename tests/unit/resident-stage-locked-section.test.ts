import { describe, expect, it } from "vitest";
import {
  isResidentPathAllowedForAccess,
  residentLockedSectionForPath,
  residentNavLockReason,
  residentStageLockCopy,
} from "@/lib/resident-portal-nav";
import { RESIDENT_ASSISTANT_SUGGESTIONS } from "@/components/portal/assistant-shared";

const applicant = {
  leaseAccessUnlocked: false,
  applicationApproved: false,
  hasCompletedApplicationSubmission: true,
};
const approved = { ...applicant, applicationApproved: true };
const tenant = { leaseAccessUnlocked: true, applicationApproved: true, hasCompletedApplicationSubmission: true };

describe("a stage-locked resident section opens its locked-state page, never home", () => {
  it("names the section and what unlocks it for an applicant", () => {
    for (const section of ["lease", "services", "forms", "move-in", "payments"]) {
      expect(residentLockedSectionForPath(`/resident/${section}`, applicant)).toBe(section);
    }
    expect(residentStageLockCopy("services", "application_submitted")).toEqual({
      label: "Services",
      message: "Services unlock after your lease is signed.",
    });
    expect(residentStageLockCopy("move-in", "application_submitted")?.message).toBe(
      "My home unlocks after your lease is signed.",
    );
    expect(residentStageLockCopy("lease", "application_submitted")?.message).toBe(
      "Lease unlocks after your application is approved.",
    );
    expect(residentStageLockCopy("payments", "application_submitted")?.message).toBe(
      "Payments unlock after your application is approved.",
    );
    expect(residentStageLockCopy("forms", "application_submitted_forms")?.message).toBe(
      "Forms unlock after your application is approved.",
    );
    expect(residentStageLockCopy("documents", "pre_approval")?.message).toBe(
      "Documents unlock after your application is approved.",
    );
  });

  it("the sidebar tooltip names the same unlock as the locked page", () => {
    expect(residentNavLockReason("services", "application_submitted")).toBe("Available after your lease is signed");
    expect(residentNavLockReason("move-in", "application_submitted")).toBe("Available after your lease is signed");
    expect(residentNavLockReason("lease", "application_submitted")).toBe("Available after your application is approved");
    expect(residentNavLockReason("services", "post_approval_pre_lease")).toBe("Available after your lease is signed");
    expect(residentNavLockReason("lease", "post_approval_pre_lease")).toBeNull();
  });

  it("/resident/services is the locked page for an applicant and the real flow for a signed resident", () => {
    expect(isResidentPathAllowedForAccess("/resident/services", applicant)).toBe(false);
    expect(residentLockedSectionForPath("/resident/services", applicant)).toBe("services");
    expect(isResidentPathAllowedForAccess("/resident/services", tenant)).toBe(true);
    expect(residentLockedSectionForPath("/resident/services", tenant)).toBeNull();
  });

  it("an approved resident without a signed lease sees Services wait on the lease", () => {
    expect(residentLockedSectionForPath("/resident/services", approved)).toBe("services");
    expect(residentStageLockCopy("services", "post_approval_pre_lease")?.message).toBe(
      "Services unlock after your lease is signed.",
    );
  });

  it("the legacy My home forms address is the Forms lock; unknown sections still bounce", () => {
    expect(residentLockedSectionForPath("/resident/move-in/forms", applicant)).toBe("forms");
    expect(residentLockedSectionForPath("/resident/nonsense", applicant)).toBeNull();
    expect(residentLockedSectionForPath("/resident/dashboard", applicant)).toBeNull();
  });
});

describe("the Assistant's Open a service chip", () => {
  it("opens the service-request flow instead of only sending chat text", () => {
    const chip = RESIDENT_ASSISTANT_SUGGESTIONS.find((s) => s.label === "Open a service");
    expect(chip?.onSelect).toBeTypeOf("function");
  });
});
