import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getPublicListings } from "@/lib/public-listings.server";
import {
  parseWorkspaceBrowseListParam,
  resolveBrowseTokensToPropertyIds,
} from "@/lib/workspace-browse-links";
import { slugifyWorkspaceBrowseSlug } from "@/lib/workspace-browse-slug";

export type WorkspaceBrowseResolveResult =
  | { ok: true; propertyIds: string[]; workspaceName: string }
  | { ok: false; status: 403 | 404; error: string };

/**
 * Re-authorize every listing token for a workspace slug. Rejects the whole
 * request when any token does not map to a live public listing in that workspace.
 */
export async function resolveWorkspaceBrowseListings(
  workspaceSlug: string,
  listParam: string | null | undefined,
): Promise<WorkspaceBrowseResolveResult> {
  const slug = slugifyWorkspaceBrowseSlug(workspaceSlug);
  const tokens = parseWorkspaceBrowseListParam(listParam);
  if (!slug || tokens.length === 0) {
    return { ok: false, status: 404, error: "This browse link is incomplete." };
  }

  const db = createSupabaseServiceRoleClient();
  const { data: workspaces } = await db.from("portal_workspaces").select("id, name");
  const matching = (workspaces ?? []).filter(
    (row) => slugifyWorkspaceBrowseSlug(String(row.name ?? "")) === slug,
  );
  if (matching.length === 0) {
    return { ok: false, status: 404, error: "Workspace not found." };
  }
  const matchingWorkspaceIds = matching.map((row) => String(row.id));
  const workspaceName = String(matching[0]!.name ?? "").trim() || workspaceSlug;

  const publicIds = new Set((await getPublicListings()).map((listing) => listing.id));
  const { data: rows, error } = await db
    .from("manager_property_records")
    .select("id")
    .eq("status", "live")
    .in("workspace_id", matchingWorkspaceIds)
    .is("test_workspace_id", null);
  if (error) {
    return { ok: false, status: 404, error: "Could not load listings." };
  }
  const authorizedIds = (rows ?? [])
    .map((row) => String(row.id))
    .filter((id) => publicIds.has(id));

  const propertyIds = resolveBrowseTokensToPropertyIds(tokens, authorizedIds);
  if (propertyIds.length !== tokens.length) {
    return { ok: false, status: 403, error: "One or more homes in this link are not available." };
  }

  return { ok: true, propertyIds, workspaceName };
}
