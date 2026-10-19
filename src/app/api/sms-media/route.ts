import { NextResponse } from "next/server";
import { createSmsMediaSignedUrl } from "@/lib/sms-media.server";
import { resolveCommunicationScope } from "@/lib/communication/conversation-visibility.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadWorkspaces } from "@/lib/workspaces/server";

export const runtime = "nodejs";

async function teammateMayReadSmsMedia(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  viewerId: string,
  ownerId: string,
  path: string,
): Promise<boolean> {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(ownerId)) return false;
    const { data: file } = await db
      .from("sms_media_files")
      .select("workspace_id")
      .eq("storage_path", path)
      .maybeSingle();
    const workspaceId = String(file?.workspace_id ?? "").trim();
    if (!workspaceId) return false;
    // Team membership is not a grant: the viewer needs Communication (inbox) on at least one house
    // of the workspace the file belongs to. `ownerIds` / `grantedHousesByOwner` carry only houses
    // positively granted at `read`.
    const scope = await resolveCommunicationScope(db, viewerId, "read");
    if (scope.teamWorkspacesByOwner?.get(ownerId)?.has(workspaceId) !== true) return false;
    if (!scope.ownerIds.includes(ownerId)) return false;
    const granted = scope.grantedHousesByOwner.get(ownerId);
    if (!granted || granted.size === 0) return false;
    const workspace = (await loadWorkspaces(db, viewerId)).find((w) => w.id === workspaceId);
    return Boolean(workspace && workspace.ownerUserId === ownerId && workspace.propertyIds.some((id) => granted.has(String(id))));
  } catch {
    return false;
  }
}

/**
 * GET /api/sms-media?path=manager/<uid>/<sid>/<n>.<ext> — mint a short-lived
 * signed URL for an MMS attachment the signed-in manager owns and redirect to
 * it. Bucket paths are what gets persisted (signed URLs expire); this route is
 * the read-time access point, mirroring manager-documents.
 */
export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const path = new URL(req.url).searchParams.get("path")?.trim() ?? "";
  // Ownership: the path is namespaced manager/<manager_user_id>/... - the owning
  // manager may mint a link. A denial matches a missing object's 404.
  if (!path.startsWith("manager/") || path.includes("..")) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const db = createSupabaseServiceRoleClient();
  if (!path.startsWith(`manager/${user.id}/`)) {
    // A teammate of the owner's workspace: the file must be indexed to a
    // workspace the viewer is an accepted team member of. Fail closed otherwise.
    const ownerId = path.split("/")[1] ?? "";
    const allowed = await teammateMayReadSmsMedia(db, user.id, ownerId, path);
    if (!allowed) return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const signedUrl = await createSmsMediaSignedUrl(db, path);
  if (!signedUrl) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.redirect(signedUrl, 302);
}
