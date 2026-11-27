import { describe, expect, it } from "vitest";
import {
  isResidentPathAllowedForAccess,
  residentLockedSectionForPath,
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
      message: "Services unlock after your application is approved.",
    });
    expect(residentStageLockCopy("move-in", "application_submitted")?.message).toBe(
      "My home unlocks after your application is approved.",
    );
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
      "Services unlock after your lease is fully signed.",
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
