import { describe, expect, it } from "vitest";

import {
  formatGoogleCalendarConnectError,
  isGoogleCalendarOAuthBlocked,
  isGoogleCalendarPartialConsent,
  isGoogleCalendarRedirectUriMismatch,
  isGoogleCalendarRevoked,
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

  it("detects a revoked/expired refresh token message and offers a reconnect CTA", () => {
    expect(isGoogleCalendarRevoked("Google Calendar access was revoked or expired. Reconnect to keep syncing.")).toBe(true);
    expect(isGoogleCalendarRevoked("access_denied")).toBe(false);
    const msg = formatGoogleCalendarConnectError("Google Calendar access was revoked or expired. Reconnect to keep syncing.");
    expect(msg.toLowerCase()).toContain("reconnect");
  });

  it("detects a granular-consent grant missing Calendar permission and surfaces it verbatim", () => {
    const reason = "Google connected without Calendar permission. On the Google screen, check the box next to Calendar events and try Connect again.";
    expect(isGoogleCalendarPartialConsent(reason)).toBe(true);
    expect(isGoogleCalendarPartialConsent("access_denied")).toBe(false);
    expect(formatGoogleCalendarConnectError(reason)).toBe(reason);
  });
});
