import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildGoogleCalendarOAuthUrl,
  verifyOAuthState,
} from "@/lib/google-calendar/api.server";
import {
  buildGmailPaymentsOAuthUrl,
  verifyGmailPaymentsOAuthState,
} from "@/lib/gmail-payments/api.server";

const previousId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
const previousSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;

beforeAll(() => {
  process.env.GOOGLE_CALENDAR_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "test-secret";
});

afterAll(() => {
  if (previousId) process.env.GOOGLE_CALENDAR_CLIENT_ID = previousId;
  else delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
  if (previousSecret) process.env.GOOGLE_CALENDAR_CLIENT_SECRET = previousSecret;
  else delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
});

describe("dedicated Google service OAuth state", () => {
  it("signs the onboarding return path into Calendar state", () => {
    const oauthUrl = new URL(
      buildGoogleCalendarOAuthUrl(
        "https://prop-lane.space",
        "manager-1",
        "/auth/manager/connect-google",
      ),
    );
    expect(oauthUrl.searchParams.get("scope")).toContain("calendar.events");
    expect(oauthUrl.searchParams.get("scope")).not.toContain("gmail.readonly");
    expect(oauthUrl.searchParams.get("include_granted_scopes")).toBe("true");
    expect(verifyOAuthState(oauthUrl.searchParams.get("state")!)).toEqual({
      userId: "manager-1",
      returnOrigin: "https://prop-lane.space",
      returnPath: "/auth/manager/connect-google",
    });
  });

  it("passes login_hint when the manager email is known", () => {
    const oauthUrl = new URL(
      buildGoogleCalendarOAuthUrl("http://localhost:3011", "manager-1", "/portal/calendar", {
        loginHint: "manager@test.proplane.local",
      }),
    );
    expect(oauthUrl.searchParams.get("login_hint")).toBe("manager@test.proplane.local");
  });

  it("signs the onboarding return path into Gmail state", () => {
    const oauthUrl = new URL(
      buildGmailPaymentsOAuthUrl(
        "https://prop-lane.space",
        "manager-1",
        "manager",
        "/auth/manager/connect-google",
      ),
    );
    expect(oauthUrl.searchParams.get("scope")).toContain("gmail.readonly");
    expect(oauthUrl.searchParams.get("scope")).not.toContain("calendar.events");
    expect(verifyGmailPaymentsOAuthState(oauthUrl.searchParams.get("state")!)).toEqual({
      userId: "manager-1",
      returnOrigin: "https://prop-lane.space",
      role: "manager",
      returnPath: "/auth/manager/connect-google",
    });
  });
});
