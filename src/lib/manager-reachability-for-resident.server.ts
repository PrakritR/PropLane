import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveActiveManagerWorkEmail } from "@/lib/manager-assistant-email/manager-assistant-email.server";
import type { ManagerReachabilityLines } from "@/lib/manager-reachability-for-resident";
import { resolveWorkspaceDisplayNumber } from "@/lib/one-number/display-number.server";
import { formatManagerMessagingPhone } from "@/lib/sms/manager-messaging-number";

/** Work SMS line + assistant inbox address a resident may use for this manager. */
export async function resolveManagerReachabilityForResident(
  db: SupabaseClient,
  managerUserId: string,
  /** The workspace the resident belongs to; omitted = the manager's default workspace. */
  workspaceId?: string | null,
): Promise<ManagerReachabilityLines> {
  const id = managerUserId.trim();
  if (!id) return { workPhoneLabel: null, assistantEmail: null };

  // Both channels resolved through their "can this actually receive?" resolver.
  // The email used to be read straight off the row, so a deployment with mail
  // switched off still handed every resident an address that swallowed their
  // message.
  const [phoneE164, assistantEmail] = await Promise.all([
    resolveWorkspaceDisplayNumber(db, id, workspaceId).catch(() => null),
    resolveActiveManagerWorkEmail(db, id).catch(() => null),
  ]);

  const workPhoneLabel = phoneE164
    ? formatManagerMessagingPhone(phoneE164) || phoneE164
    : null;

  return { workPhoneLabel, assistantEmail };
}
