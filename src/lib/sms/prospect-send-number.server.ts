import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveManagedSendLine } from "@/lib/sms/manager-number-provisioning.server";
import { resolveManagerWorkNumber } from "@/lib/twilio-provisioning";
import { resolveActiveWorkspaceFromRequest } from "@/lib/workspaces/active.server";

/**
 * The ONE number a prospect-facing text or its preview names for a manager's active workspace.
 *
 * A PropLane-managed (`is_service`) workspace texts on the PropLane line even when its owner's profile still holds an
 * older number of its own (Ambika's +1 (814) 679-3694), so a preview that read `profiles.sms_from_number` showed a
 * different number than the send used. A managed workspace whose line cannot be resolved answers null (nothing
 * sends, never the old number); any other workspace keeps its own work number.
 */
export async function resolveProspectFacingSendNumber(db: SupabaseClient, managerUserId: string): Promise<string | null> {
  let workspaceId: string | null = null;
  try {
    workspaceId = (await resolveActiveWorkspaceFromRequest(db, managerUserId)).id;
  } catch {
    workspaceId = null;
  }
  const managed = await resolveManagedSendLine(db, managerUserId, workspaceId);
  if (managed.managed) return managed.line?.phoneNumber ?? null;
  return resolveManagerWorkNumber(db, managerUserId);
}

/**
 * The ONE number a text or notice from a manager's workspace names as "from" when a caller only needs the number (a reminder's
 * reply-to, an invite text's sender): a PropLane-managed workspace answers with `resolveManagedSendLine` (its own registered
 * number, else the PropLane line; null when unresolvable, never an old row), every other workspace with the caller's own
 * lookup (`fallback`). Nothing outside the send path reads `manager_sms_numbers` or the profile to pick it.
 */
export async function resolveManagedAwareFromNumber(
  db: SupabaseClient,
  managerUserId: string,
  fallback: () => Promise<string | null | undefined>,
  workspaceId?: string | null,
): Promise<string | null> {
  const managed = await resolveManagedSendLine(db, managerUserId, workspaceId ?? null).catch(() => null);
  if (managed?.managed) return managed.line?.phoneNumber ?? null;
  return (await fallback().catch(() => null)) ?? null;
}
