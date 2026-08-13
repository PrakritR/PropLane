import { describe, expect, it } from "vitest";

import {
  formatGoogleCalendarConnectError,
  isGoogleCalendarOAuthBlocked,
} from "@/lib/google-calendar/connect-errors";

describe("google calendar connect errors", () => {
  it("detects blocked OAuth responses", () => {
    expect(isGoogleCalendarOAuthBlocked("access_denied")).toBe(true);
    expect(isGoogleCalendarOAuthBlocked("This app is blocked")).toBe(true);
    expect(isGoogleCalendarOAuthBlocked("redirect_uri_mismatch")).toBe(false);
  });

  it("returns actionable copy for blocked calendar connect", () => {
    const msg = formatGoogleCalendarConnectError("access_denied");
    expect(msg).toContain("Test users");
    expect(msg).toContain("calendar.events");
  });
});
