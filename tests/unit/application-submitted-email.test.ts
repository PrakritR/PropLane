import { describe, expect, it } from "vitest";
import {
  APPLICATION_SUBMITTED_EMAIL_SUBJECT,
  APPLICATION_SUBMITTED_CONFIRMATION_SUBJECT,
  applicationSubmittedEmailSubject,
  buildApplicationSubmittedEmailBody,
  buildApplicationSubmittedMailtoHref,
} from "@/lib/application-submitted-email";

describe("application-submitted-email", () => {
  const params = {
    applicantName: "Alex Chen",
    applicantEmail: "alex@example.com",
    axisId: "APP-12345",
    signupUrl: "https://app.example.com/auth/resident-setup?token=tok&proplane_id=APP-12345",
    propertyTitle: "Sunset House",
  };

  it("includes axis id and signup URL in body", () => {
    const body = buildApplicationSubmittedEmailBody(params);
    expect(body).toContain("APP-12345");
    expect(body).toContain(params.signupUrl);
    expect(body).toContain("alex@example.com");
    expect(body).toContain("Sunset House");
    expect(body).toContain("Hi Alex Chen,");
  });

  it("uses resident account subject", () => {
    expect(APPLICATION_SUBMITTED_EMAIL_SUBJECT.toLowerCase()).toContain("resident");
  });

  it("uses confirmation subject and portal link when account already exists", () => {
    const portalUrl = "https://app.example.com/resident/applications";
    const body = buildApplicationSubmittedEmailBody({ ...params, signupUrl: portalUrl, accountReady: true });
    expect(applicationSubmittedEmailSubject(true)).toBe(APPLICATION_SUBMITTED_CONFIRMATION_SUBJECT);
    expect(body).toContain(portalUrl);
    expect(body).not.toContain("Create your resident portal account");
  });

  it("builds mailto with encoded subject and body", () => {
    const href = buildApplicationSubmittedMailtoHref({
      to: "alex@example.com",
      applicantName: "Alex Chen",
      applicantEmail: "alex@example.com",
      axisId: "APP-12345",
      origin: "https://app.example.com",
      propertyTitle: "Sunset House",
    });
    expect(href.startsWith("mailto:alex%40example.com?")).toBe(true);
    expect(href).toContain("subject=");
    expect(href).toContain("body=");
    expect(decodeURIComponent(href)).toContain("APP-12345");
  });
});
