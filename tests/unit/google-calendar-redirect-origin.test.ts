import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { knownProductionWebOrigins } from "@/lib/app-url";
import {
  googleCalendarOAuthRedirectUri,
  resolveGoogleCalendarRedirectOrigin,
} from "@/lib/google-calendar/api.server";
import { gmailPaymentsOAuthRedirectUri } from "@/lib/gmail-payments/api.server";
import { httpsOAuthCallbackUrls } from "@/lib/auth/native-oauth-redirect-urls";

describe("resolveGoogleCalendarRedirectOrigin", () => {
  const prevCanonical = process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
  const prevApp = process.env.NEXT_PUBLIC_APP_URL;
  const prevOverride = process.env.GOOGLE_CALENDAR_REDIRECT_ORIGIN;

  beforeEach(() => {
    delete process.env.GOOGLE_CALENDAR_REDIRECT_ORIGIN;
    process.env.NEXT_PUBLIC_CANONICAL_APP_URL = "https://www.axis-seattle-housing.com";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.axis-seattle-housing.com";
  });

  afterEach(() => {
    if (prevCanonical) process.env.NEXT_PUBLIC_CANONICAL_APP_URL = prevCanonical;
    else delete process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
    if (prevApp) process.env.NEXT_PUBLIC_APP_URL = prevApp;
    else delete process.env.NEXT_PUBLIC_APP_URL;
    if (prevOverride) process.env.GOOGLE_CALENDAR_REDIRECT_ORIGIN = prevOverride;
    else delete process.env.GOOGLE_CALENDAR_REDIRECT_ORIGIN;
  });

  it("keeps localhost on the browser port", () => {
    expect(resolveGoogleCalendarRedirectOrigin("http://localhost:3011")).toBe("http://localhost:3011");
  });

  it("maps prop-lane.space to the canonical registered callback origin", () => {
    expect(resolveGoogleCalendarRedirectOrigin("https://prop-lane.space")).toBe(
      "https://www.axis-seattle-housing.com",
    );
    expect(googleCalendarOAuthRedirectUri("https://prop-lane.space")).toBe(
      "https://www.axis-seattle-housing.com/api/portal/google-calendar/callback",
    );
    expect(gmailPaymentsOAuthRedirectUri("https://prop-lane.space")).toBe(
      "https://www.axis-seattle-housing.com/api/portal/gmail-payments/callback",
    );
  });

  it("honors GOOGLE_CALENDAR_REDIRECT_ORIGIN only on local dev hosts", () => {
    process.env.GOOGLE_CALENDAR_REDIRECT_ORIGIN = "http://localhost:3010";
    expect(resolveGoogleCalendarRedirectOrigin("http://localhost:3011")).toBe("http://localhost:3010");
    expect(resolveGoogleCalendarRedirectOrigin("https://prop-lane.space")).toBe(
      "https://www.axis-seattle-housing.com",
    );
  });

  it("lists every production host for Supabase sign-in allowlists", () => {
    expect(knownProductionWebOrigins()).toEqual(
      expect.arrayContaining([
        "https://prop-lane.space",
        "https://www.prop-lane.space",
        "https://www.axis-seattle-housing.com",
      ]),
    );
    expect(httpsOAuthCallbackUrls("https://prop-lane.space")).toEqual(
      expect.arrayContaining([
        "https://prop-lane.space/auth/callback",
        "https://www.axis-seattle-housing.com/auth/callback",
      ]),
    );
  });
});
