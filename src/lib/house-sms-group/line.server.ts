import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { resolveWorkspaceSendLine } from "@/lib/sms/manager-number-provisioning.server";

export type SmsGroupLine = { ok: true; line: string; kind: "shared" | "work" } | { ok: false; reason: "no_line" | "unreadable" };

/**
 * The number a house's group text is projected from. The same decision every text ABOUT a workspace uses
 * (`resolveHouseSmsLine`): the shared PropLane line when this workspace is on it, otherwise
 * `resolveWorkspaceSendLine`, which answers a PropLane-MANAGED (`is_service`) workspace with the PropLane
 * line (`resolveServiceLine`) and every other workspace with ITS OWN registered work number. A workspace
 * with no sendable line, or one that cannot be read, is a refusal: the group is never projected from
 * another workspace's number.
 */
export async function resolveSmsGroupLine(
  db: SupabaseClient,
  input: { workspaceId: string; ownerUserId: string },
): Promise<SmsGroupLine> {
  try {
    const config = await loadSharedLineConfig(db);
    if (config.sharedNumber && workspaceOnSharedLine(config, input.workspaceId)) {
      const shared = normalizeE164(config.sharedNumber);
      return shared ? { ok: true, line: shared, kind: "shared" } : { ok: false, reason: "no_line" };
    }
    const line = await resolveWorkspaceSendLine(db, input.ownerUserId, input.workspaceId, { failClosed: true });
    const phone = line ? normalizeE164(line.phoneNumber) : null;
    return phone ? { ok: true, line: phone, kind: "work" } : { ok: false, reason: "no_line" };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}
