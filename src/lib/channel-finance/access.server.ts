import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";
import { requireBookingsManager } from "@/lib/channel-calendar/require-manager.server";
import { resolveActiveWorkspaceFromRequest } from "@/lib/workspaces/active.server";
import type { FinanceScope } from "./store.server";

export type ChannelFinanceContext = {
  db: SupabaseClient;
  viewerUserId: string;
  scope: FinanceScope;
  propertyIds: string[];
};

/**
 * The signed-in manager, the ACTIVE workspace they are acting in, and whether they may touch its Payments: the workspace owner
 * always; anyone else needs Payments at `level` on at least one of the workspace's houses (the gate the Payments routes use). Every
 * record is keyed to the workspace's OWNER and id, never the co-manager who happened to upload. Null = refused / signed out.
 */
export async function requireChannelFinanceContext(level: "read" | "edit"): Promise<ChannelFinanceContext | null> {
  const ctx = await requireBookingsManager();
  if (!ctx) return null;
  const ws = await resolveActiveWorkspaceFromRequest(ctx.db, ctx.userId);
  let allowed = ws.ownerUserId === ctx.userId;
  for (const propertyId of allowed ? [] : ws.propertyIds) {
    if (await managerHasCoManagerPermissionForProperty(ctx.db, ctx.userId, propertyId, "payments", level)) {
      allowed = true;
      break;
    }
  }
  if (!allowed) return null;
  return { db: ctx.db, viewerUserId: ctx.userId, scope: { ownerUserId: ws.ownerUserId, workspaceId: ws.id, includeUnplaced: ws.isDefault }, propertyIds: ws.propertyIds };
}
