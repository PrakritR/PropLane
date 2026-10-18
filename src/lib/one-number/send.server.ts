import type { SupabaseClient } from "@supabase/supabase-js";
import type { SharedLineSend, SharedLineSendResult } from "@/lib/one-number/contracts";

/**
 * The one outbound door on the shared line. Every text the router, agents,
 * alerts or the inbox send while a workspace is on the shared line goes
 * through here (consent, quiet hours, segment guard, workspace billing,
 * sign-off). Owned by the transport workstream.
 */
export async function sendSharedLineMessage(
  _db: SupabaseClient,
  _send: SharedLineSend,
): Promise<SharedLineSendResult> {
  return { ok: false, reason: "not_shared_mode" };
}
