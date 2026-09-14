import "server-only";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWorkspaces } from "./server";
import { WORKSPACE_COOKIE } from "./types";

/**
 * The houses the viewer's active workspace holds, resolved on the SERVER from
 * the selection cookie rather than from anything the client sends.
 *
 * `null` means "not narrowing": the selection is absent, or the account is a
 * single workspace and the workspace IS the account. An EMPTY ARRAY means the
 * workspace genuinely holds no houses — a caller that treats that as "no
 * filter" hands back the whole account, which is the bug this exists to stop.
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
  if (workspaces.length <= 1) return null;
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
