import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWorkspaces } from "./server";
import { WORKSPACE_COOKIE, type PortalWorkspace } from "./types";

/**
 * The workspace a viewer is acting IN: the one the switcher selected, else the
 * workspace they own by default. This is the one answer to "which workspace's
 * work number / work email does this request mean" — Communication, Settings,
 * provisioning and outbound identity all ask here.
 *
 * Selection never widens access: a cookie naming a workspace the viewer cannot
 * see is ignored and the viewer's own default wins. A viewer with no owned
 * workspace row yet gets one, the same way property writes do, so a brand-new
 * account has somewhere for its line to live.
 */
export type ActiveWorkspace = {
  id: string;
  name: string;
  ownerUserId: string;
  owned: boolean;
  isDefault: boolean;
  propertyIds: string[];
};

function toActive(w: PortalWorkspace): ActiveWorkspace {
  return {
    id: w.id,
    name: w.name,
    ownerUserId: w.ownerUserId,
    owned: w.owned,
    isDefault: w.isDefault,
    propertyIds: w.propertyIds,
  };
}

/** Every workspace the viewer can see, owned first, then the shared ones. */
export async function listViewerWorkspaces(
  db: SupabaseClient,
  viewerUserId: string,
): Promise<ActiveWorkspace[]> {
  const workspaces = await loadWorkspaces(db, viewerUserId);
  if (!workspaces.some((w) => w.owned)) {
    const { data, error } = await db.rpc("ensure_default_portal_workspace", { p_owner: viewerUserId });
    if (error || !data) throw new Error("Could not prepare this account's workspace. Please retry.");
    return listViewerWorkspaces(db, viewerUserId);
  }
  return workspaces
    .slice()
    .sort((a, b) => Number(b.owned) - Number(a.owned) || Number(b.isDefault) - Number(a.isDefault))
    .map(toActive);
}

export async function resolveActiveWorkspace(
  db: SupabaseClient,
  viewerUserId: string,
  selectedWorkspaceId?: string | null,
): Promise<ActiveWorkspace> {
  const workspaces = await listViewerWorkspaces(db, viewerUserId);
  const selected = selectedWorkspaceId?.trim();
  const picked = selected ? workspaces.find((w) => w.id === selected) : undefined;
  const fallback =
    workspaces.find((w) => w.owned && w.isDefault) ?? workspaces.find((w) => w.owned) ?? workspaces[0];
  const active = picked ?? fallback;
  if (!active) throw new Error("Could not resolve a workspace for this account.");
  return active;
}

/** The active workspace from the request's own cookie, for route handlers. */
export async function resolveActiveWorkspaceFromRequest(
  db: SupabaseClient,
  viewerUserId: string,
): Promise<ActiveWorkspace> {
  let selected: string | undefined;
  try {
    const { cookies } = await import("next/headers");
    selected = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  } catch {
    // Outside a request scope (a unit test, a job): nothing selected, the
    // viewer's own default workspace wins. Never a wider read.
    selected = undefined;
  }
  return resolveActiveWorkspace(db, viewerUserId, selected);
}

/**
 * The workspace a WORKSPACE-KEYED identity row (a number, an address) answers
 * for: its owner and whether the viewer holds it. Null when the row is not
 * placed in any workspace (a legacy row the migration could not backfill).
 */
export async function loadWorkspaceById(
  db: SupabaseClient,
  workspaceId: string,
): Promise<{ id: string; name: string; ownerUserId: string; isDefault: boolean } | null> {
  const id = workspaceId.trim();
  if (!id) return null;
  const { data, error } = await db
    .from("portal_workspaces")
    .select("id, name, owner_user_id, is_default")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: String(data.id),
    name: String(data.name ?? ""),
    ownerUserId: String(data.owner_user_id ?? ""),
    isDefault: Boolean(data.is_default),
  };
}

/** The owner's default workspace id, created when missing. */
export async function ensureDefaultWorkspaceId(db: SupabaseClient, ownerUserId: string): Promise<string> {
  const { data, error } = await db.rpc("ensure_default_portal_workspace", { p_owner: ownerUserId });
  if (error || !data) throw new Error("Could not prepare this account's workspace. Please retry.");
  return String(data);
}
