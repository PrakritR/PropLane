import { NextResponse } from "next/server";

import {
  GMAIL_PAYMENTS_ENABLED,
  GMAIL_PAYMENTS_DISABLED_REASON,
} from "@/lib/gmail-payments/enabled";

import {
  buildGmailPaymentsOAuthUrl,
  gmailPaymentsOAuthRedirectUri,
  isGmailPaymentsOAuthConfigured,
} from "@/lib/gmail-payments/api.server";
import { requireVendor } from "@/lib/gmail-payments/require-vendor.server";
import { warmGoogleCalendarOAuthConfig } from "@/lib/google-calendar/settings";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const originParam = url.searchParams.get("origin")?.trim();
  const origin = originParam || url.origin;
  const returnTo = `${origin.replace(/\/$/, "")}/vendor/payments`;

  // The one place the `gmail.readonly` scope would be requested. While the
  // feature is off, refuse here rather than anywhere downstream — a redirect to
  // Google is exactly what must not happen (PRP-130).
  if (!GMAIL_PAYMENTS_ENABLED) {
    const reason = encodeURIComponent(GMAIL_PAYMENTS_DISABLED_REASON);
    return NextResponse.redirect(`${returnTo}?gmail-pay=error&reason=${reason}`);
  }

  try {
    await warmGoogleCalendarOAuthConfig();
    if (!isGmailPaymentsOAuthConfigured()) {
      const reason = encodeURIComponent("Google OAuth is not configured on this server.");
      return NextResponse.redirect(`${returnTo}?gmail-pay=error&reason=${reason}`);
    }
    const ctx = await requireVendor();
    if (!ctx) {
      const reason = encodeURIComponent("Sign in as a vendor, then try again.");
      return NextResponse.redirect(`${returnTo}?gmail-pay=error&reason=${reason}`);
    }
    void gmailPaymentsOAuthRedirectUri(origin, "vendor");
    const oauthUrl = buildGmailPaymentsOAuthUrl(origin, ctx.userId, "vendor");
    return NextResponse.redirect(oauthUrl);
  } catch (e) {
    const reason = encodeURIComponent(e instanceof Error ? e.message : "Failed to start Gmail connect.");
    return NextResponse.redirect(`${returnTo}?gmail-pay=error&reason=${reason}`);
  }
}
