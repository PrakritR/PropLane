import { describe, expect, it } from "vitest";

import {
  formatGoogleCalendarConnectError,
  isGoogleCalendarOAuthBlocked,
  isGoogleCalendarRedirectUriMismatch,
} from "@/lib/google-calendar/connect-errors";

describe("google calendar connect errors", () => {
  it("detects blocked OAuth responses", () => {
    expect(isGoogleCalendarOAuthBlocked("access_denied")).toBe(true);
    expect(isGoogleCalendarOAuthBlocked("This app is blocked")).toBe(true);
    expect(isGoogleCalendarOAuthBlocked("redirect_uri_mismatch")).toBe(false);
  });

  it("detects redirect_uri_mismatch", () => {
    expect(isGoogleCalendarRedirectUriMismatch("Error 400: redirect_uri_mismatch")).toBe(true);
    expect(isGoogleCalendarRedirectUriMismatch("access_denied")).toBe(false);
  });

  it("returns actionable copy for blocked calendar connect", () => {
    const msg = formatGoogleCalendarConnectError("access_denied");
    expect(msg).toContain("Test users");
    expect(msg).toContain("calendar.events");
  });

  it("returns the exact redirect URI to add on mismatch", () => {
    const msg = formatGoogleCalendarConnectError("redirect_uri_mismatch", {
      oauthRedirectUri: "http://localhost:3004/api/portal/google-calendar/callback",
    });
    expect(msg).toContain("http://localhost:3004/api/portal/google-calendar/callback");
    expect(msg).toContain("Authorized redirect URIs");
  });
});
