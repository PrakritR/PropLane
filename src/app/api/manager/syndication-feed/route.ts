import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  buildZillowFeedUrl,
  getOrCreateManagerSyndicationFeedKey,
} from "@/lib/listing-syndication/manager-syndication-feed.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { resolveWorkspaceFromSettingsRequest } from "@/lib/workspaces/active.server";

export const runtime = "nodejs";

async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * GET — the caller's ACTIVE workspace's Zillow Rental Network feed URL
 * (W013), creating that workspace's feed row on first read. Honors an
 * explicit `?workspaceId=`, else the workspace-switcher cookie, else the
 * viewer's own default workspace — the same settings-bar resolution every
 * other workspace-scoped settings route uses
 * (`resolveWorkspaceFromSettingsRequest`), so a co-manager acting in a
 * shared workspace gets THAT workspace's feed, keyed to its actual owner.
 * Always the canonical production origin: Zillow's crawler hits this URL
 * from the outside, so it can never resolve to localhost or a preview
 * deploy the way a request-derived origin could.
 */
export async function GET(request: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const db = createSupabaseServiceRoleClient();
  try {
    const workspace = await resolveWorkspaceFromSettingsRequest(db, user.id, request);
    const feedKey = await getOrCreateManagerSyndicationFeedKey(db, workspace.ownerUserId, workspace.id);
    return NextResponse.json({
      feedUrl: buildZillowFeedUrl(resolveEmailLinkBaseUrl(), feedKey),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    });
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : "Could not load the feed URL." },
      { status: 500 },
    );
  }
}
