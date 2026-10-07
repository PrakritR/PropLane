import { NextResponse } from "next/server";

import { saveMetaConnection } from "@/lib/listing-channels/meta/connection.server";
import {
  exchangeMetaCode,
  fetchMetaIdentity,
  fetchMetaManagedPages,
  metaAppCredentials,
  metaRedirectUri,
} from "@/lib/listing-channels/meta/graph.server";
import { verifyMetaOAuthState } from "@/lib/listing-channels/meta/oauth-state";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { listViewerWorkspaces } from "@/lib/workspaces/active.server";
import { scheduleListingChannelSync } from "@/lib/listing-channels/sync.server";

export const runtime = "nodejs";

/**
 * Meta redirects here with `code` + our signed `state`. The state must verify, be fresh, and name the
 * SAME signed-in manager and an OWNED workspace; then the code becomes a long-lived user token, the
 * first managed Page's own token is stored encrypted, and the user token is discarded.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const creds = metaAppCredentials();
  const state = creds ? verifyMetaOAuthState(url.searchParams.get("state"), creds.appSecret) : null;
  const returnPath = state?.returnPath ?? "/portal/profile?tab=spreadsheets";
  const to = (flag: string) => NextResponse.redirect(`${url.origin}${returnPath}${returnPath.includes("?") ? "&" : "?"}${flag}`);
  const fail = (reason: string) => to(`meta=error&reason=${encodeURIComponent(reason)}`);

  if (!creds || !state) return fail("The Facebook connection expired. Click Connect again.");
  const denied = url.searchParams.get("error");
  if (denied) return fail(url.searchParams.get("error_description") ?? "Facebook did not approve the connection.");
  const code = url.searchParams.get("code");
  if (!code) return fail("Facebook did not return an authorization code.");

  const auth = await requireManagerRouteUser();
  if (!auth || auth.userId !== state.userId) return fail("Sign in as the same manager, then try again.");
  const workspaces = await listViewerWorkspaces(auth.db, auth.userId).catch(() => []);
  const workspace = workspaces.find((w) => w.id === state.workspaceId && w.owned);
  if (!workspace) return fail("Only the workspace owner can connect Facebook.");

  try {
    const userToken = await exchangeMetaCode({ code, redirectUri: metaRedirectUri(url.origin) });
    const [identity, pages] = await Promise.all([fetchMetaIdentity(userToken), fetchMetaManagedPages(userToken)]);
    const page = pages[0];
    if (!page) return fail("That Facebook account does not manage a Page. Create or get access to one, then connect again.");
    await saveMetaConnection(auth.db, { workspaceId: workspace.id, managerUserId: auth.userId, metaUserId: identity.id, page });
    // New connection: queue this workspace's live listings.
    const { data } = await auth.db.from("manager_property_records").select("id").eq("workspace_id", workspace.id).eq("status", "live");
    for (const row of data ?? []) scheduleListingChannelSync(auth.db, String(row.id));
    return to("meta=connected");
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not connect Facebook.");
  }
}
