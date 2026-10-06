import { NextResponse } from "next/server";

import { sanitizeOAuthReturnPath } from "@/lib/auth/oauth-return-path";
import { resolveListingChannelContext } from "@/lib/listing-channels/route-context.server";
import { signMetaOAuthState } from "@/lib/listing-channels/meta/oauth-state";
import { buildMetaOAuthDialogUrl, metaAppCredentials, metaRedirectUri } from "@/lib/listing-channels/meta/graph.server";

export const runtime = "nodejs";

/** Settings → Integrations → Posting → Connect Facebook: send the workspace owner to Meta's OAuth dialog. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnPath = sanitizeOAuthReturnPath(url.searchParams.get("returnTo"), "/portal/profile?tab=spreadsheets");
  const back = (reason: string) => NextResponse.redirect(`${url.origin}${returnPath}${returnPath.includes("?") ? "&" : "?"}meta=error&reason=${encodeURIComponent(reason)}`);

  const creds = metaAppCredentials();
  if (!creds) return back("Facebook posting is not set up on this server.");
  const ctx = await resolveListingChannelContext(request).catch(() => null);
  if (!ctx) return back("Sign in as a manager, then try again.");
  if (!ctx.workspace.owned) return back("Only the workspace owner can connect Facebook.");

  const state = signMetaOAuthState({ userId: ctx.userId, workspaceId: ctx.workspace.id, returnPath }, creds.appSecret);
  return NextResponse.redirect(buildMetaOAuthDialogUrl({ appId: creds.appId, redirectUri: metaRedirectUri(url.origin), state }));
}
