import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveWorkspaceSendLine } from "@/lib/sms/manager-number-provisioning.server";

/**
 * The workspace pin of an automated text ABOUT one house (a charge, a reminder, an action event): the house's own
 * workspace and the line that workspace sends from, so the dispatcher sends from that workspace's number and its owner's
 * wallet pays. A PropLane-managed (`is_service`) workspace answers with the PropLane line through `resolveWorkspaceSendLine`
 * (which defers to `resolveServiceLine`); every other workspace answers with its own registered number.
 *
 * `workspaceId` is read from the stored house, never from a request. `line` is null when the workspace has no sendable line
 * right now: the caller still passes the workspace and house so the dispatcher decides (it never borrows another
 * workspace's number). A failed read of the line rows is `unreadable`, so a managed workspace never falls back to a
 * different line on a blip.
 */
export type PropertySendPin =
  | { kind: "none" }
  | { kind: "unreadable" }
  | { kind: "pinned"; propertyId: string; workspaceId: string; line: { phoneNumber: string; numberId: string | null } | null };

export async function resolvePropertySendPin(
  db: SupabaseClient,
  input: { ownerUserId: string; propertyId: string | null | undefined },
): Promise<PropertySendPin> {
  const propertyId = String(input.propertyId ?? "").trim();
  const ownerUserId = input.ownerUserId.trim();
  if (!propertyId || !ownerUserId) return { kind: "none" };
  let workspaceId = "";
  try {
    const { data } = await db.from("manager_property_records").select("workspace_id").eq("id", propertyId).maybeSingle();
    workspaceId = String((data as { workspace_id?: unknown } | null)?.workspace_id ?? "").trim();
  } catch {
    return { kind: "unreadable" };
  }
  if (!workspaceId) return { kind: "none" };
  try {
    const line = await resolveWorkspaceSendLine(db, ownerUserId, workspaceId, { failClosed: true });
    return { kind: "pinned", propertyId, workspaceId, line };
  } catch {
    return { kind: "unreadable" };
  }
}
