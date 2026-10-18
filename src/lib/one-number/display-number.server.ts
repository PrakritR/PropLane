import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { resolveSendWorkspaceId } from "@/lib/one-number/shared-line-number.server";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";

/**
 * The PropLane line a workspace texts from, or null. Non-null only while the shared line is live and
 * the workspace is ON it (a workspace holding a number of its own is not, and neither is one outside
 * the pilot). Fails closed to null: in per_workspace mode this is always null.
 */
export async function resolveSharedLineNumberFor(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceId: string | null | undefined,
): Promise<string | null> {
  try {
    const config = await loadSharedLineConfig(db);
    if (config.mode !== "shared" || !config.sharedNumber) return null;
    const id = (await resolveSendWorkspaceId(db, ownerUserId, { workspaceId: workspaceId ?? null })) ?? String(workspaceId ?? "").trim();
    return workspaceOnSharedLine(config, id || null) ? config.sharedNumber : null;
  } catch {
    return null;
  }
}

/**
 * The number a workspace ACTUALLY texts from, for showing to people (listing CTA, resident welcome,
 * work contact, printables): its own sendable number when it has one, else the PropLane line while it
 * is on it, else null. This is a display answer. Sends keep going through the send path
 * (`evaluateWorkspaceSendReadiness`); this never decides who may send.
 */
export async function resolveWorkspaceDisplayNumber(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceId?: string | null,
): Promise<string | null> {
  const own = await resolveActiveManagerSendNumber(db, ownerUserId, workspaceId ?? null).catch(() => null);
  if (own) return own;
  return resolveSharedLineNumberFor(db, ownerUserId, workspaceId);
}
