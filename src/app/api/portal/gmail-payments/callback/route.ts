import { NextResponse } from "next/server";

import { exchangeGmailPaymentsCode, verifyGmailPaymentsOAuthState } from "@/lib/gmail-payments/api.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const oauthError = url.searchParams.get("error");
  const oauthErrorDescription = url.searchParams.get("error_description");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const callbackOrigin = url.origin;

  if (oauthError) {
    const raw =
      oauthErrorDescription?.trim() ||
      (oauthError === "access_denied"
        ? "access_denied"
        : oauthError);
    const reason = encodeURIComponent(raw);
    return NextResponse.redirect(`${callbackOrigin}/portal/payments?gmail-pay=error&reason=${reason}`);
  }

  if (!code || !state) {
    const reason = encodeURIComponent("Google did not return an authorization code. Try Connect again.");
    return NextResponse.redirect(`${callbackOrigin}/portal/payments?gmail-pay=error&reason=${reason}`);
  }

  const oauthState = verifyGmailPaymentsOAuthState(state);
  if (!oauthState) {
    const reason = encodeURIComponent("Gmail connect session expired. Click Connect again.");
    return NextResponse.redirect(`${callbackOrigin}/portal/payments?gmail-pay=error&reason=${reason}`);
  }

  const returnTo = `${oauthState.returnOrigin}${oauthState.returnPath}`;

  try {
    const db = createSupabaseServiceRoleClient();
    await exchangeGmailPaymentsCode(
      db,
      oauthState.userId,
      code,
      oauthState.returnOrigin,
      oauthState.role,
      oauthState.channel,
    );
    return NextResponse.redirect(`${returnTo}?gmail-pay=connected`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    const reason = encodeURIComponent(message);
    return NextResponse.redirect(`${returnTo}?gmail-pay=error&reason=${reason}`);
  }
}
