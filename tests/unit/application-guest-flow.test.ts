import { describe, expect, it, vi } from "vitest";
import {
  APPLICATION_STARTED_EMAIL_SUBJECT,
  buildApplicationStartedEmailBody,
} from "@/lib/application-started-email";
import {
  shouldSyncInProgressDraft,
  inProgressApplicationResumeUrl,
  buildInProgressApplicationRow,
} from "@/lib/rental-application/in-progress-application";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import {
  hasPublicApplyGuestContinue,
  markPublicApplyGuestContinue,
  publicApplySignInHref,
} from "@/lib/rental-application/public-apply-session";

describe("application started email", () => {
  it("builds subject and body with resume + setup links", () => {
    expect(APPLICATION_STARTED_EMAIL_SUBJECT).toMatch(/continue/i);
    const body = buildApplicationStartedEmailBody({
      applicantName: "Sam",
      propertyTitle: "Oak House",
      resumeUrl: "https://prop-lane.space/rent/apply?propertyId=p1",
      signupUrl: "https://prop-lane.space/auth/resident-setup?token=abc",
    });
    expect(body).toContain("Sam");
    expect(body).toContain("Oak House");
    expect(body).toContain("/rent/apply?propertyId=p1");
    expect(body).toContain("resident-setup");
  });
});

describe("in-progress draft sync eligibility", () => {
  it("requires email and property", () => {
    expect(shouldSyncInProgressDraft({ email: "", propertyId: "p1" })).toBe(false);
    expect(shouldSyncInProgressDraft({ email: "a@b.com", propertyId: "" })).toBe(false);
    expect(shouldSyncInProgressDraft({ email: "a@b.com", propertyId: "p1" })).toBe(true);
    expect(shouldSyncInProgressDraft({ email: "jaarav071@gmail.c", propertyId: "p1" })).toBe(false);
  });

  it("uses public apply resume url", () => {
    const form = { ...createInitialRentalWizardState(), propertyId: "prop-1" };
    const row = buildInProgressApplicationRow({
      axisId: "PROPLANE-ABC",
      form,
      residentEmail: "jane@test.com",
    });
    expect(inProgressApplicationResumeUrl("https://axis.test", row)).toBe(
      "https://axis.test/rent/apply?propertyId=prop-1",
    );
    expect(
      inProgressApplicationResumeUrl("https://axis.test", row, {
        token: "guest-resume-token",
        axisId: "PROPLANE-ABC",
      }),
    ).toContain("token=guest-resume-token");
    expect(
      inProgressApplicationResumeUrl("https://axis.test", row, {
        token: "guest-resume-token",
        axisId: "PROPLANE-ABC",
      }),
    ).toContain("proplane_id=PROPLANE-ABC");
  });
});

describe("public apply session", () => {
  it("builds sign-in href with return to in-portal apply", () => {
    expect(publicApplySignInHref("prop-9")).toBe(
      "/auth/sign-in?intent=resident&next=%2Fresident%2Fapplications%2Fapply%3FpropertyId%3Dprop-9",
    );
  });

  it("tracks guest continue per property", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        setItem: (k: string, v: string) => store.set(k, v),
        getItem: (k: string) => store.get(k) ?? null,
      },
    });
    markPublicApplyGuestContinue("prop-guest");
    expect(hasPublicApplyGuestContinue("prop-guest")).toBe(true);
    expect(hasPublicApplyGuestContinue("other")).toBe(false);
    vi.unstubAllGlobals();
  });
});
