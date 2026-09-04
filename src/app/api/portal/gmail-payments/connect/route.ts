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
import type { ManagerPaymentReceiptChannel } from "@/lib/gmail-payments/portal-role";
import { requireManager } from "@/lib/gmail-payments/require-manager.server";
import { sanitizeOAuthReturnPath } from "@/lib/auth/oauth-return-path";
import { warmGoogleCalendarOAuthConfig } from "@/lib/google-calendar/settings";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const originParam = url.searchParams.get("origin")?.trim();
  const origin = originParam || url.origin;
  const returnPath = sanitizeOAuthReturnPath(url.searchParams.get("returnTo"), "/portal/payments");
  const returnTo = `${origin.replace(/\/$/, "")}${returnPath}`;

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
    const ctx = await requireManager();
    if (!ctx) {
      const reason = encodeURIComponent("Sign in as a manager, then try again.");
      return NextResponse.redirect(`${returnTo}?gmail-pay=error&reason=${reason}`);
    }
    void gmailPaymentsOAuthRedirectUri(origin);
    const channelParam = url.searchParams.get("channel")?.trim();
    const channel: ManagerPaymentReceiptChannel | undefined =
      channelParam === "venmo" || channelParam === "zelle" ? channelParam : undefined;
    const oauthUrl = buildGmailPaymentsOAuthUrl(origin, ctx.userId, "manager", returnPath, channel);
    return NextResponse.redirect(oauthUrl);
  } catch (e) {
    const reason = encodeURIComponent(e instanceof Error ? e.message : "Failed to start Gmail connect.");
    return NextResponse.redirect(`${returnTo}?gmail-pay=error&reason=${reason}`);
  }
}
