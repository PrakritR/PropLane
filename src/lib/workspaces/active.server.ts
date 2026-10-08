import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isViewAsSessionOpen } from "@/lib/auth/view-as-guard";
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
 * account has somewhere for its line to live — except under an open "View as"
 * session, which stays a pure read and provisions nothing (`provisionWorkspace`).
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

/**
 * The provisioning rpc, refused while a "View as" session is open. The rpc
 * INSERTs, and `withViewAsReadOnly` cannot see that through `rpc()` by name, so
 * every heal-on-read path asks here instead (the same guard
 * `portal-service-requests`, `portal-work-orders`, `manager-applications` and
 * `manager-access-server` use). Null means "not provisioned": the caller reads
 * whatever already exists rather than writing to the account being viewed.
 */
async function provisionWorkspace(db: SupabaseClient, ownerUserId: string): Promise<string | null> {
  if (await isViewAsSessionOpen()) return null;
  const { data, error } = await db.rpc("ensure_default_portal_workspace", { p_owner: ownerUserId });
  if (error || !data) return null;
  return String(data);
}

/** Every workspace the viewer can see, owned first, then the shared ones. */
export async function listViewerWorkspaces(
  db: SupabaseClient,
  viewerUserId: string,
): Promise<ActiveWorkspace[]> {
  const workspaces = await loadWorkspaces(db, viewerUserId);
  if (!workspaces.some((w) => w.owned)) {
    const provisioned = await provisionWorkspace(db, viewerUserId);
    if (provisioned) return listViewerWorkspaces(db, viewerUserId);
    // A read-only session reads the shared workspaces it can already see; any
    // other failure is a real one and the caller must not get a partial answer.
    if (!(await isViewAsSessionOpen())) {
      throw new Error("Could not prepare this account's workspace. Please retry.");
    }
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
 * Settings bar scope: honor `workspaceId` from the body or `?workspaceId=`,
 * otherwise the cookie. A named id the viewer cannot see falls through the
 * same way the cookie does — `resolveActiveWorkspace` ignores it.
 */
export async function resolveWorkspaceFromSettingsRequest(
  db: SupabaseClient,
  viewerUserId: string,
  request: Request | undefined,
  bodyWorkspaceId?: string | null,
): Promise<ActiveWorkspace> {
  const fromBody = bodyWorkspaceId?.trim() || "";
  let fromQuery = "";
  if (request) {
    try {
      fromQuery = new URL(request.url).searchParams.get("workspaceId")?.trim() || "";
    } catch {
      fromQuery = "";
    }
  }
  const selected = fromBody || fromQuery;
  if (selected) return resolveActiveWorkspace(db, viewerUserId, selected);
  return resolveActiveWorkspaceFromRequest(db, viewerUserId);
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

/** The owner's default workspace id, created when missing (never under a View-as session). */
export async function ensureDefaultWorkspaceId(db: SupabaseClient, ownerUserId: string): Promise<string> {
  const provisioned = await provisionWorkspace(db, ownerUserId);
  if (provisioned) return provisioned;
  const owned = (await loadWorkspaces(db, ownerUserId)).filter((w) => w.owned);
  const existing = owned.find((w) => w.isDefault) ?? owned[0];
  if (existing) return existing.id;
  throw new Error("Could not prepare this account's workspace. Please retry.");
}
