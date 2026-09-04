import { describe, expect, it } from "vitest";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";
import {
  isBlockedSelfServiceProfileEmail,
  resolveTrustedProspectContactEmail,
} from "@/lib/auth/prospect-contact-trust";

describe("resolveTrustedProspectContactEmail", () => {
  it("uses session email for message handoff when no tour inquiry proof exists", () => {
    expect(
      resolveTrustedProspectContactEmail({
        authEmail: "resident@example.com",
        requestedContactEmail: "resident@example.com",
        tourInquiryEmailVerified: false,
      }),
    ).toEqual({ ok: true, contactEmail: "resident@example.com" });
  });

  it("rejects a client-supplied email that does not match the session", () => {
    expect(
      resolveTrustedProspectContactEmail({
        authEmail: "attacker@example.com",
        requestedContactEmail: "victim@example.com",
        tourInquiryEmailVerified: false,
      }),
    ).toEqual({
      ok: false,
      error: "Could not link your prospect activity. Sign in with the same email you used on the form.",
    });
  });

  it("allows a tour inquiry email that differs from the signed-in auth email", () => {
    expect(
      resolveTrustedProspectContactEmail({
        authEmail: "oauth@example.com",
        requestedContactEmail: "tour@example.com",
        tourInquiryEmailVerified: true,
        verifiedInquiryEmail: "tour@example.com",
      }),
    ).toEqual({
      ok: true,
      contactEmail: "tour@example.com",
      authEmail: "oauth@example.com",
    });
  });
});

describe("isBlockedSelfServiceProfileEmail", () => {
  it("blocks the primary admin fallback email", () => {
    expect(isBlockedSelfServiceProfileEmail(PRIMARY_ADMIN_EMAIL)).toBe(true);
    expect(isBlockedSelfServiceProfileEmail("resident@example.com")).toBe(false);
  });
});
