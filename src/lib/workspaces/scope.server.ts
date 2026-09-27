import "server-only";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWorkspaces } from "./server";
import { WORKSPACE_COOKIE } from "./types";

/**
 * The houses the viewer's active workspace holds, resolved on the SERVER from
 * the selection cookie rather than from anything the client sends.
 *
 * `null` means "not narrowing": the workspace load failed, or the viewer has
 * no workspace at all. A single workspace is NOT the account when co-manager
 * grants exist — the account still reaches another owner's houses through the
 * grant, so a resolved single workspace narrows exactly like several would. An
 * EMPTY ARRAY means the workspace genuinely holds no houses — a caller that
 * treats that as "no filter" hands back the whole account, which is the bug
 * this exists to stop.
 *
 * Narrowing only. Authorization stays where it already is; this never widens
 * what the viewer could already read.
 */
export async function activeWorkspacePropertyScope(
  db: SupabaseClient,
  viewerUserId: string,
): Promise<string[] | null> {
  let workspaces;
  try {
    workspaces = await loadWorkspaces(db, viewerUserId);
  } catch {
    // A scope we cannot resolve must not silently widen the read. The caller
    // keeps its own property filter and the page reports the failure normally.
    return null;
  }
  if (workspaces.length === 0) return null;
  const selected = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const active = workspaces.find((w) => w.id === selected) ?? workspaces[0];
  if (!active) return null;
  return [...new Set(active.propertyIds.map((id) => id.trim()).filter(Boolean))];
}

/** The viewer's workspace narrowed further by an explicit property filter. */
export function narrowWorkspaceScope(
  workspaceIds: string[] | null,
  propertyId: string | undefined,
): string[] | null {
  if (!propertyId) return workspaceIds;
  if (!workspaceIds) return [propertyId];
  return workspaceIds.includes(propertyId) ? [propertyId] : [];
}

/**
 * Refuse a manager write whose property lies outside the caller's ACTIVE
 * workspace. `null` scope (no workspaces, or the load failed) never narrows,
 * the same "never narrow on a failure" contract `activeWorkspacePropertyScope`
 * itself follows. A blank `propertyId` always passes — a property-less write
 * has no house to leak into another workspace.
 *
 * This is beside module/ownership authorization, never instead of it: callers
 * check ownership or a co-manager grant first, and only then confirm the
 * named property is one the active workspace actually holds (mirrors the
 * local helper of the same shape in `manager-applications/route.ts`).
 */
export async function assertPropertyInActiveWorkspace(
  db: SupabaseClient,
  viewerUserId: string,
  propertyId: string | null | undefined,
): Promise<boolean> {
  const pid = (propertyId ?? "").trim();
  if (!pid) return true;
  const scope = await activeWorkspacePropertyScope(db, viewerUserId);
  if (scope === null) return true;
  return scope.includes(pid);
}
