import { describe, expect, it } from "vitest";

import {
  googleServiceResultPath,
  MANAGER_GOOGLE_SERVICES_PATH,
  normalizeGoogleServiceReturnPath,
} from "@/lib/auth/manager-google-services";
import { GOOGLE_CALENDAR_OAUTH_SCOPES } from "@/lib/google-calendar/scopes";

describe("manager Google services onboarding", () => {
  it("asks for Calendar only — Gmail is not a PropLane scope", () => {
    expect(GOOGLE_CALENDAR_OAUTH_SCOPES).toContain("calendar.events");
    expect(GOOGLE_CALENDAR_OAUTH_SCOPES).not.toContain("gmail");
  });

  it("rejects cross-origin callback destinations", () => {
    expect(normalizeGoogleServiceReturnPath("//evil.example", "/portal/calendar")).toBe("/portal/calendar");
    expect(normalizeGoogleServiceReturnPath("/%2f%2fevil.example", "/portal/calendar")).toBe(
      "/portal/calendar",
    );
    expect(normalizeGoogleServiceReturnPath(MANAGER_GOOGLE_SERVICES_PATH, "/portal/calendar")).toBe(
      MANAGER_GOOGLE_SERVICES_PATH,
    );
  });

  it("uses onboarding status keys without changing existing portal callback keys", () => {
    expect(googleServiceResultPath(MANAGER_GOOGLE_SERVICES_PATH, "calendar", "connected")).toBe(
      "/auth/manager/connect-google?calendar=connected",
    );
    expect(googleServiceResultPath("/portal/calendar", "calendar", "connected")).toBe(
      "/portal/calendar?gcal=connected",
    );
    expect(googleServiceResultPath("/portal/calendar", "calendar", "error", "Access denied")).toBe(
      "/portal/calendar?gcal=error&reason=Access+denied",
    );
  });
});
